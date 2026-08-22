/**
 * VaultKeyService — enrollment, recovery, disable. Driven against the mock
 * YubiKey and the real (AsyncStorage/SecureStore-mocked) vaultStore.
 *
 * The YubiKey is now an unwrap oracle: enrollment seals the 64-byte vault
 * seed to the card's public key and writes v4 meta (no xpub, no
 * r1PublicKey — see VaultKeyService.ts's header). These tests therefore
 * prove the seal is USABLE — the enrolled (or re-enrolled, or adopted) card's
 * ECDH must open it back to the exact HD node the mnemonic + passphrase route
 * derives — rather than inspecting a public key field that no longer exists.
 *
 * The ceremony's own ceremony.ts (rewritten under Task 8 to the same
 * unwrap-oracle model — no per-output r1PublicKey vocabulary left) is
 * intentionally not exercised here; VaultKeyService no longer has anything
 * to do with it.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)
const secureItems: Record<string, string> = {}
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afudo',
  getItemAsync: jest.fn(async (k: string) => secureItems[k] ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => {
    secureItems[k] = v
  }),
  deleteItemAsync: jest.fn(async (k: string) => {
    delete secureItems[k]
  })
}))

import AsyncStorage from '@react-native-async-storage/async-storage'
import { HD, Hash, Utils } from '@bsv/sdk'
import { MockYubiKey } from '../../services/vault/mockYubiKey'
import { setMockDriver } from '../../services/vault/driver'
import { vaultStore } from '../../services/vault/vaultStore'
import {
  enrollVault,
  finalizeEnrollment,
  recoverVaultHD,
  disableVault,
  resealToNewKey,
  VAULT_SLOT
} from '../../services/vault/VaultKeyService'
import { deriveVaultHD } from '../../services/vault/vaultDerivation'
import { unsealVaultKey } from '../../services/vault/sealing'

let mock: MockYubiKey

beforeEach(async () => {
  await AsyncStorage.clear()
  for (const k of Object.keys(secureItems)) delete secureItems[k]
  mock = new MockYubiKey()
  mock.insertKey('MOCK-1')
  setMockDriver(mock)
})
afterEach(() => setMockDriver(null))

// A fixed, well-known throwaway BIP39 test vector. NEVER a real wallet phrase.
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const PASSPHRASE = 'correct horse battery staple anchor'

// args().getPin returns this and no requestPinChange is supplied in these
// tests, so the card's PIN never actually changes during enrollment.
const DEFAULT_PIN_AFTER_CHANGE = '123456'

/** Enrollment args with the v4 requirements filled in. */
const args = (over: Record<string, unknown> = {}) => ({
  nickname: 'k',
  mnemonic: MNEMONIC,
  passphrase: PASSPHRASE,
  onPhase: () => {},
  getPin: async () => DEFAULT_PIN_AFTER_CHANGE,
  ...over
})

describe('enrollVault', () => {
  test('produces v4 meta and persists nothing until finalize', async () => {
    const phases: string[] = []
    const { pending } = await enrollVault(args({ nickname: 'Work key', onPhase: (p: string) => phases.push(p) }))

    expect(phases).toContain('generating')
    expect(phases).toContain('done')

    // Nothing on disk yet — a user who backs out is simply not enrolled.
    expect(await vaultStore.isEnrolled()).toBe(false)
    expect(await vaultStore.getMeta()).toBeNull()
    expect(await vaultStore.getSeal()).toBeNull()

    expect(pending.meta.v).toBe(4)
    expect(pending.meta.slot).toBe(0x82)
    expect(pending.meta.nickname).toBe('Work key')
    expect(pending.meta.yubiSerial).toBe('MOCK-1')
    expect(pending.meta.nextKeyIndex).toBe(0)
    expect((pending.meta as any).xpub).toBeUndefined()
    expect((pending.meta as any).r1PublicKey).toBeUndefined()
    expect(pending.seal.v).toBe(1)
    expect(pending.seal.slot).toBe(0x82)
    expect(pending.seal.yubiSerial).toBe('MOCK-1')

    await finalizeEnrollment(pending)
    expect(await vaultStore.isEnrolled()).toBe(true)
    const meta = await vaultStore.getMeta()
    expect(meta!.nickname).toBe('Work key')
    expect(await vaultStore.getSeal()).toEqual(pending.seal)
  })

  test('persists a v4 meta with no xpub and a seal the enrolled card can open', async () => {
    const { pending } = await enrollVault(args())
    await finalizeEnrollment(pending)
    const meta = await vaultStore.getMeta()
    expect(meta).toMatchObject({ v: 4, nextKeyIndex: expect.any(Number) })
    expect((meta as any).xpub).toBeUndefined()
    expect((meta as any).r1PublicKey).toBeUndefined()
    const seal = await vaultStore.getSeal()
    expect(seal?.v).toBe(1)
    // The mock card opens it, and the seed inside derives the same HD as the
    // mnemonic + passphrase route.
    const { secret } = await mock.ecdh(seal!.slot, DEFAULT_PIN_AFTER_CHANGE, seal!.ePub)
    const seed = unsealVaultKey(seal!, secret)
    expect(HD.fromSeed(seed).toString()).toBe(deriveVaultHD(MNEMONIC, PASSPHRASE).toString())
  })

  test('enrollment returns no second mnemonic to back up', async () => {
    // The entire point of v2/v3/v4: one phrase, not two.
    const result = await enrollVault(args())
    expect(result).not.toHaveProperty('backupMnemonic')
  })

  test('zeroes the vault seed even when sealing fails on malformed card key material', async () => {
    // A card bug (or a compromised/foreign PIV slot) could return something
    // that is not a well-formed SEC1 point; sealVaultKey's ECDH then throws a
    // raw @noble/curves error with no .code. enrollVault recodes that into
    // VaultError('template-invalid') without echoing the underlying message
    // (which could otherwise leak details about the malformed input back to
    // a caller). That throw happens AFTER the seed has been derived, so it
    // must not skip the zeroing step — the seed is exactly the secret this
    // whole function exists to keep off disk and out of memory once done
    // with it.
    jest.spyOn(mock, 'generateVaultKey').mockResolvedValueOnce({ publicKey: '04aabb' })
    const fillSpy = jest.spyOn(Array.prototype, 'fill')
    await expect(enrollVault(args())).rejects.toMatchObject({ code: 'template-invalid' })
    const zeroedA64ByteArray = fillSpy.mock.calls.some(
      ([value], i) => value === 0 && (fillSpy.mock.instances[i] as unknown[]).length === 64
    )
    fillSpy.mockRestore()
    expect(zeroedA64ByteArray).toBe(true)
  })

  test('rejects a weak passphrase before any key contact', async () => {
    const spy = jest.spyOn(mock, 'getKeyInfo')
    let pinAsked = false
    await expect(
      enrollVault(args({ passphrase: 'hunter2', getPin: async () => { pinAsked = true; return '123456' } }))
    ).rejects.toMatchObject({ code: 'bad-passphrase' })
    expect(pinAsked).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  test('enroll refuses an empty passphrase', async () => {
    // Empty would make V identical to the main wallet's master key.
    const spy = jest.spyOn(mock, 'getKeyInfo')
    await expect(enrollVault(args({ passphrase: '' }))).rejects.toMatchObject({
      code: 'bad-passphrase'
    })
    expect(spy).not.toHaveBeenCalled()
  })

  test('a factory-PIN key (user enters 123456) forces a PIN change (fix #5)', async () => {
    let changeArgs: { oldPin: string; newPin: string } | null = null
    await enrollVault(
      args({
        getPin: async () => '123456', // factory
        requestPinChange: async () => {
          changeArgs = { oldPin: '123456', newPin: '654321' }
          return changeArgs
        }
      })
    )
    expect(changeArgs).toEqual({ oldPin: '123456', newPin: '654321' })
  })

  test('a non-factory PIN never triggers a change and never burns a retry (fix #5)', async () => {
    mock.setPin('999999') // key already has a custom PIN
    let changeCalled = false
    await enrollVault(
      args({
        getPin: async () => '999999',
        requestPinChange: async () => {
          changeCalled = true
          return { oldPin: '123456', newPin: 'x' }
        }
      })
    )
    expect(changeCalled).toBe(false)
    // No wasted '123456' probe → retries stay full.
    expect((await mock.getKeyInfo()).pinRetries).toBe(3)
  })

  test('enroll refuses a key whose PIN is already blocked (fix #5)', async () => {
    const blocked = new MockYubiKey()
    blocked.insertKey('BLOCKED')
    // exhaust retries
    await blocked.verifyPin('000000').catch(() => {})
    await blocked.verifyPin('000000').catch(() => {})
    await blocked.verifyPin('000000').catch(() => {})
    setMockDriver(blocked)
    await expect(
      enrollVault(args())
    ).rejects.toMatchObject({ code: 'pin-locked' })
  })

  test('enroll refuses to overwrite an occupied PIV slot (slot-occupied)', async () => {
    mock.occupySlot() // e.g. an existing age-plugin-yubikey identity in slot 82
    await expect(
      enrollVault(args())
    ).rejects.toMatchObject({ code: 'slot-occupied' })
    // nothing persisted, and the existing slot key is untouched
    expect(await vaultStore.isEnrolled()).toBe(false)
  })

  test('adopting an occupied slot reuses that key and never generates', async () => {
    mock.occupySlot() // the same YubiKey, already enrolled on another device
    const existing = (await mock.readVaultPublicKey(VAULT_SLOT))!.publicKey
    const genSpy = jest.spyOn(mock, 'generateVaultKey')
    const phases: string[] = []

    const { pending } = await enrollVault(
      args({ adoptExisting: true, onPhase: (p: string) => phases.push(p) })
    )

    expect(genSpy).not.toHaveBeenCalled()
    expect(phases).toContain('adopting')
    expect(phases).not.toContain('generating')
    // The seal was built against the key ALREADY on the card, not a fresh
    // one — proven by its yubiPubSha256 matching that key's hash, and (the
    // stronger check) by the card's own ECDH actually opening it.
    expect(pending.seal.yubiPubSha256).toBe(Utils.toHex(Hash.sha256(Utils.toArray(existing, 'hex'))))
    const { secret } = await mock.ecdh(pending.seal.slot, DEFAULT_PIN_AFTER_CHANGE, pending.seal.ePub)
    const seed = unsealVaultKey(pending.seal, secret)
    expect(HD.fromSeed(seed).toString()).toBe(deriveVaultHD(MNEMONIC, PASSPHRASE).toString())
    // Still nothing on disk until finalize.
    expect(await vaultStore.isEnrolled()).toBe(false)
  })

  test('adoption starts deposit indices high, so two devices do not reissue the same address', async () => {
    mock.occupySlot()
    const { pending: adopted } = await enrollVault(args({ adoptExisting: true }))
    expect(adopted.meta.nextKeyIndex).toBeGreaterThanOrEqual(1 << 20)
    expect(adopted.meta.nextKeyIndex).toBeLessThan(0x80000000)

    // Two adoptions in a row must not land on the same index.
    const { pending: again } = await enrollVault(args({ adoptExisting: true }))
    expect(again.meta.nextKeyIndex).not.toBe(adopted.meta.nextKeyIndex)
  })

  test('adoptExisting on an EMPTY slot still generates a fresh key from index 0', async () => {
    const genSpy = jest.spyOn(mock, 'generateVaultKey')
    const { pending } = await enrollVault(args({ adoptExisting: true }))
    expect(genSpy).toHaveBeenCalledTimes(1)
    expect(pending.meta.nextKeyIndex).toBe(0)
  })

  test('session-based enroll (NFC): PIN collected BEFORE the tap; ops run in one session', async () => {
    const nfc = new MockYubiKey()
    ;(nfc as any).sessionBased = true
    nfc.setPin('123456')
    nfc.insertKey('MOCK-1')
    setMockDriver(nfc)
    const order: string[] = []
    const startSpy = jest.spyOn(nfc, 'start').mockImplementation(() => {
      order.push('session-start')
      // simulate the tap connecting
      ;(nfc as any).emit({ type: 'attached', serial: 'MOCK-1', transport: 'mock' })
    })
    const stopSpy = jest.spyOn(nfc, 'stop')

    const { pending } = await enrollVault(
      args({
        getPin: async () => {
          order.push('pin-entered')
          return '123456'
        }
      })
    )
    await finalizeEnrollment(pending)

    // PIN entered in the UI BEFORE the NFC session opened, and the session closed.
    expect(order).toEqual(['pin-entered', 'session-start'])
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(stopSpy).toHaveBeenCalledTimes(1)
    expect(await vaultStore.isEnrolled()).toBe(true)
  })
})

describe('recoverVaultHD', () => {
  test('rejects an invalid phrase', async () => {
    await expect(recoverVaultHD('not a valid mnemonic phrase at all', PASSPHRASE)).rejects.toBeDefined()
  })
})

describe('resealToNewKey', () => {
  test('writes v4 meta for the new key, preserving nextKeyIndex', async () => {
    // Enroll and finalize under the FIRST key.
    const { pending } = await enrollVault(args())
    await finalizeEnrollment(pending)
    const oldSeal = pending.seal

    // Simulate a couple of deposits having advanced the counter.
    await vaultStore.takeNextIndex()
    await vaultStore.takeNextIndex()
    expect((await vaultStore.getMeta())!.nextKeyIndex).toBe(2)

    // Lose the key; enroll a fresh one via resealToNewKey.
    const fresh = new MockYubiKey()
    fresh.insertKey('MOCK-2')
    setMockDriver(fresh)
    await resealToNewKey(MNEMONIC, PASSPHRASE, 'k', async () => '123456')

    const after = await vaultStore.getMeta()
    expect(after!.v).toBe(4)
    expect(after!.yubiSerial).toBe('MOCK-2')
    // The counter must never be reissued to a second address.
    expect(after!.nextKeyIndex).toBe(2)

    const newSeal = (await vaultStore.getSeal())!
    expect(newSeal).not.toEqual(oldSeal)
    // The seal now opens through the NEW card, to the same HD node the
    // mnemonic + passphrase derive.
    const { secret } = await fresh.ecdh(newSeal.slot, '123456', newSeal.ePub)
    const seed = unsealVaultKey(newSeal, secret)
    expect(HD.fromSeed(seed).toString()).toBe(deriveVaultHD(MNEMONIC, PASSPHRASE).toString())
  })

  test('the OLD physical key can no longer open the seal after re-enrollment', async () => {
    // Outputs locked under the OLD key do not become spendable via the R1
    // ceremony again after a reseal — that guarantee lives in ceremony.ts's
    // serial check (Task 8, not exercised here). What VaultKeyService itself
    // guarantees is narrower but just as load-bearing: the OLD card's ECDH no
    // longer opens the CURRENT seal at all, because resealToNewKey overwrites
    // it with one sealed to the NEW card's key.
    const { pending } = await enrollVault(args())
    await finalizeEnrollment(pending)
    const oldMock = mock // still "physically present" with its original key

    const fresh = new MockYubiKey()
    fresh.insertKey('MOCK-2')
    setMockDriver(fresh)
    await resealToNewKey(MNEMONIC, PASSPHRASE, 'k', async () => '123456')

    const after = (await vaultStore.getMeta())!
    expect(after.yubiSerial).toBe('MOCK-2')
    expect(after.yubiSerial).not.toBe(pending.meta.yubiSerial)

    const newSeal = (await vaultStore.getSeal())!
    const { secret: oldCardSecret } = await oldMock.ecdh(newSeal.slot, '123456', newSeal.ePub)
    expect(() => unsealVaultKey(newSeal, oldCardSecret)).toThrow(
      expect.objectContaining({ code: 'seal-corrupt' })
    )
  })

  describe('verifyHD gate', () => {
    test('verifyHD returning false refuses to reseal: nothing written, nothing generated', async () => {
      // BIP39 passphrases have no checksum, so a mistyped one would otherwise
      // silently overwrite the ONLY seal that opens the real vault with one
      // sealed to a node nobody can spend from — the old physical key is
      // gone by design (that's what reseal is for), so this is the last
      // chance to catch the typo before it becomes unrecoverable.
      const { pending } = await enrollVault(args())
      await finalizeEnrollment(pending)
      const oldSeal = pending.seal
      const oldMeta = await vaultStore.getMeta()

      const fresh = new MockYubiKey()
      fresh.insertKey('MOCK-2')
      setMockDriver(fresh)
      const infoSpy = jest.spyOn(fresh, 'getKeyInfo')
      const genSpy = jest.spyOn(fresh, 'generateVaultKey')

      await expect(
        resealToNewKey(MNEMONIC, PASSPHRASE, 'k', async () => '123456', async () => false)
      ).rejects.toMatchObject({ code: 'bad-passphrase' })

      // Verification runs BEFORE the tap even begins.
      expect(infoSpy).not.toHaveBeenCalled()
      expect(genSpy).not.toHaveBeenCalled()
      // The slot on the new card was never touched.
      expect(await fresh.readVaultPublicKey(VAULT_SLOT)).toBeNull()

      // vaultStore is untouched — the OLD seal is exactly as it was, and
      // still opens (via the OLD card) to the OLD HD.
      expect(await vaultStore.getMeta()).toEqual(oldMeta)
      expect(await vaultStore.getSeal()).toEqual(oldSeal)
      const { secret } = await mock.ecdh(oldSeal.slot, DEFAULT_PIN_AFTER_CHANGE, oldSeal.ePub)
      const seed = unsealVaultKey(oldSeal, secret)
      expect(HD.fromSeed(seed).toString()).toBe(deriveVaultHD(MNEMONIC, PASSPHRASE).toString())
    })

    test('verifyHD returning true lets the reseal proceed as before', async () => {
      const { pending } = await enrollVault(args())
      await finalizeEnrollment(pending)

      const fresh = new MockYubiKey()
      fresh.insertKey('MOCK-2')
      setMockDriver(fresh)
      let verifiedWith: string | null = null

      await resealToNewKey(MNEMONIC, PASSPHRASE, 'k', async () => '123456', async hd => {
        verifiedWith = hd.toString()
        return true
      })

      // verifyHD was actually called with the HD the new seal now wraps.
      expect(verifiedWith).toBe(deriveVaultHD(MNEMONIC, PASSPHRASE).toString())

      const after = await vaultStore.getMeta()
      expect(after!.yubiSerial).toBe('MOCK-2')
      const seal = (await vaultStore.getSeal())!
      const { secret } = await fresh.ecdh(seal.slot, '123456', seal.ePub)
      const seed = unsealVaultKey(seal, secret)
      expect(HD.fromSeed(seed).toString()).toBe(deriveVaultHD(MNEMONIC, PASSPHRASE).toString())
    })
  })
})

test('disableVault clears all vault state', async () => {
  const { pending } = await enrollVault(args())
  await finalizeEnrollment(pending)
  await disableVault()
  expect(await vaultStore.isEnrolled()).toBe(false)
  expect(await vaultStore.getMeta()).toBeNull()
  expect(await vaultStore.getSeal()).toBeNull()
})
