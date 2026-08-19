/**
 * VaultKeyService — enrollment, recovery, disable. Driven against the mock
 * YubiKey and the real (AsyncStorage/SecureStore-mocked) vaultStore.
 *
 * There is no sealing anymore: the YubiKey signs directly, so enrollment's
 * only job is to generate the PIV key, record its compressed public key, and
 * write v3 meta.
 */
import { CeremonyController } from '../../services/vault/ceremony'

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
import { MockYubiKey } from '../../services/vault/mockYubiKey'
import { setMockDriver } from '../../services/vault/driver'
import { vaultStore } from '../../services/vault/vaultStore'
import {
  enrollVault,
  finalizeEnrollment,
  recoverVaultHD,
  disableVault,
  resealHDToNewKey,
  VAULT_SLOT
} from '../../services/vault/VaultKeyService'
import { deriveVaultHD, vaultXpub } from '../../services/vault/vaultDerivation'
import { compressP256 } from '../../services/vault/r1k1'

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

/** Enrollment args with the v3 requirements filled in. */
const args = (over: Record<string, unknown> = {}) => ({
  nickname: 'k',
  mnemonic: MNEMONIC,
  passphrase: PASSPHRASE,
  onPhase: () => {},
  getPin: async () => '123456',
  ...over
})

describe('enrollVault', () => {
  test('produces v3 meta with the compressed R1 public key and persists nothing until finalize', async () => {
    const phases: string[] = []
    const { pending } = await enrollVault(args({ nickname: 'Work key', onPhase: (p: string) => phases.push(p) }))

    expect(phases).toContain('generating')
    expect(phases).toContain('done')

    // Nothing on disk yet — a user who backs out is simply not enrolled.
    expect(await vaultStore.isEnrolled()).toBe(false)
    expect(await vaultStore.getMeta()).toBeNull()

    expect(pending.meta.v).toBe(3)
    expect(pending.meta.slot).toBe(0x82)
    expect(pending.meta.nickname).toBe('Work key')
    expect(pending.meta.yubiSerial).toBe('MOCK-1')
    expect(pending.meta.nextKeyIndex).toBe(0)
    // 33-byte compressed, not the 65-byte SEC1 the driver returns.
    expect(pending.meta.r1PublicKey).toMatch(/^0[23][0-9a-f]{64}$/)
    expect(pending.meta.xpub.startsWith('xpub')).toBe(true)

    await finalizeEnrollment(pending)
    expect(await vaultStore.isEnrolled()).toBe(true)
    const meta = await vaultStore.getMeta()
    expect(meta!.r1PublicKey).toBe(pending.meta.r1PublicKey)

    // The stored xpub is exactly what the mnemonic + passphrase derives, so
    // the second recovery path reaches the same addresses.
    expect(meta!.xpub).toBe(vaultXpub(deriveVaultHD(MNEMONIC, PASSPHRASE)))
  })

  test('records the key the card actually generated, not a stray or default value', async () => {
    const { pending } = await enrollVault(args())
    const onCard = (await mock.readVaultPublicKey(VAULT_SLOT))!.publicKey
    // onCard is the raw 65-byte uncompressed SEC1 point the mock (like the
    // real card) returns; compressing it independently must match what
    // enrollment stored.
    expect(onCard.length).toBe(130) // 65 bytes, hex
    expect(pending.meta.r1PublicKey).toBe(compressP256(onCard))
  })

  test('enrollment returns no second mnemonic to back up', async () => {
    // The entire point of v2/v3: one phrase, not two.
    const result = await enrollVault(args())
    expect(result).not.toHaveProperty('backupMnemonic')
  })

  test('zeroes the vault seed even when the card returns malformed key material', async () => {
    // A card bug (or a compromised/foreign PIV slot) could return something
    // that is not a well-formed SEC1 point; compressP256 throws template-invalid
    // for it. That throw happens AFTER the seed has been derived, so it must
    // not skip the zeroing step — the seed is exactly the secret this whole
    // function exists to keep off disk and out of memory once done with it.
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
    expect(pending.meta.r1PublicKey).toBe(compressP256(existing))
    // Same wallet phrase + passphrase means the SAME vault as the other device.
    expect(pending.meta.xpub).toBe(vaultXpub(deriveVaultHD(MNEMONIC, PASSPHRASE)))
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

  test('rejects a mistyped passphrase against the stored xpub', async () => {
    // BIP39 passphrases have no checksum, so without the xpub check a typo would
    // silently open a different, EMPTY vault and look like lost funds.
    const xpub = vaultXpub(deriveVaultHD(MNEMONIC, PASSPHRASE))
    await expect(
      recoverVaultHD(MNEMONIC, 'correct horse battery staple anchoe', xpub)
    ).rejects.toMatchObject({ code: 'bad-passphrase' })
  })
})

describe('resealHDToNewKey', () => {
  test('writes v3 meta for the new key, preserving nextKeyIndex', async () => {
    // Enroll and finalize under the FIRST key.
    const { pending } = await enrollVault(args())
    await finalizeEnrollment(pending)
    const oldR1PublicKey = pending.meta.r1PublicKey

    // Simulate a couple of deposits having advanced the counter.
    await vaultStore.takeNextIndex()
    await vaultStore.takeNextIndex()
    expect((await vaultStore.getMeta())!.nextKeyIndex).toBe(2)

    // Lose the key; enroll a fresh one via resealHDToNewKey.
    const fresh = new MockYubiKey()
    fresh.insertKey('MOCK-2')
    setMockDriver(fresh)
    const hd = deriveVaultHD(MNEMONIC, PASSPHRASE)
    await resealHDToNewKey(hd, 'k', async () => '123456')

    const after = await vaultStore.getMeta()
    expect(after!.v).toBe(3)
    expect(after!.yubiSerial).toBe('MOCK-2')
    expect(after!.r1PublicKey).not.toBe(oldR1PublicKey)
    // The counter must never be reissued to a second address.
    expect(after!.nextKeyIndex).toBe(2)
  })

  // F2: this used to be "asserted" by rebuilding a locking script from the
  // same three arguments and checking it equals itself — a determinism check
  // on a pure function, not a spendability guarantee. The real claim (see
  // VaultKeyService.ts's and r1k1.ts's corrected doc comments) is the
  // opposite of what the old comment said: R1 spendability does NOT survive
  // a re-enrollment. Proven here directly against the ceremony: the OLD
  // physical key, presented against the vault's NOW-current meta (whose
  // yubiSerial is the NEW key's), is rejected by the serial check before any
  // signing is attempted — exactly the mechanism that makes outputs from the
  // old key unspendable via R1 afterward, leaving the K1 recovery sweep
  // (transfers.ts's sweepVaultWithHD, which never touches a YubiKey) as the
  // only way to move them.
  test('the OLD physical key is rejected by the ceremony after re-enrollment — R1 does not survive, only K1 recovery does', async () => {
    const { pending } = await enrollVault(args())
    await finalizeEnrollment(pending)
    const oldMock = mock // still "physically present" with its original serial

    const fresh = new MockYubiKey()
    fresh.insertKey('MOCK-2')
    setMockDriver(fresh)
    const hd = deriveVaultHD(MNEMONIC, PASSPHRASE)
    await resealHDToNewKey(hd, 'k', async () => '123456')

    const after = (await vaultStore.getMeta())!
    expect(after.yubiSerial).toBe('MOCK-2')
    expect(after.yubiSerial).not.toBe(pending.meta.yubiSerial)

    const ceremony = new CeremonyController({
      getDriver: () => oldMock,
      store: { getMeta: async () => ({ slot: after.slot, yubiSerial: after.yubiSerial, r1PublicKey: after.r1PublicKey }) },
      retentionMs: 120_000
    })
    await expect(ceremony.requestSigner('withdraw')).rejects.toMatchObject({ code: 'serial-mismatch' })
  })
})

test('disableVault clears all vault state', async () => {
  const { pending } = await enrollVault(args())
  await finalizeEnrollment(pending)
  await disableVault()
  expect(await vaultStore.isEnrolled()).toBe(false)
  expect(await vaultStore.getMeta()).toBeNull()
})
