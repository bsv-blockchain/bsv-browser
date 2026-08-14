/**
 * VaultKeyService — enrollment, recovery, disable. Driven against the mock
 * YubiKey and the real (AsyncStorage/SecureStore-mocked) vaultStore.
 */
import { HD } from '@bsv/sdk'

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
import { enrollVault, finalizeEnrollment, recoverVaultHD, disableVault } from '../../services/vault/VaultKeyService'
import { deriveVaultHD, vaultXpub, depositPkhFromXpub } from '../../services/vault/vaultDerivation'
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

/** Enrollment args with the v2 requirements filled in. */
const args = (over: Record<string, unknown> = {}) => ({
  nickname: 'k',
  mnemonic: MNEMONIC,
  passphrase: PASSPHRASE,
  onPhase: () => {},
  getPin: async () => '123456',
  ...over
})

test('enroll builds a v2 seal + xpub but does NOT persist until finalize (fix #4)', async () => {
  const phases: string[] = []
  const { pending } = await enrollVault(args({ nickname: 'Work key', onPhase: (p: string) => phases.push(p) }))

  expect(phases).toContain('generating')
  expect(phases).toContain('done')

  // Nothing on disk yet — a user who backs out is simply not enrolled.
  expect(await vaultStore.isEnrolled()).toBe(false)
  expect(await vaultStore.getMeta()).toBeNull()

  expect(pending.meta.nickname).toBe('Work key')
  expect(pending.meta.yubiSerial).toBe('MOCK-1')
  expect(pending.meta.v).toBe(2)
  // A single counter replaces the old 64-key hash queue.
  expect(pending.meta.nextKeyIndex).toBe(0)
  expect(pending.meta).not.toHaveProperty('depositKeys')

  await finalizeEnrollment(pending)
  expect(await vaultStore.isEnrolled()).toBe(true)
  const meta = await vaultStore.getMeta()

  // The stored xpub is exactly what the mnemonic + passphrase derives, so the
  // second recovery path reaches the same addresses.
  expect(meta && 'xpub' in meta && meta.xpub).toBe(vaultXpub(deriveVaultHD(MNEMONIC, PASSPHRASE)))
})

test('enrollment returns no second mnemonic to back up', async () => {
  // The entire point of v2: one phrase, not two.
  const result = await enrollVault(args())
  expect(result).not.toHaveProperty('backupMnemonic')
})

test('enroll refuses a weak passphrase before touching the key', async () => {
  // Rejecting after the tap would waste the user's NFC interaction.
  let pinAsked = false
  await expect(
    enrollVault(args({ passphrase: 'hunter2', getPin: async () => { pinAsked = true; return '123456' } }))
  ).rejects.toMatchObject({ code: 'bad-passphrase' })
  expect(pinAsked).toBe(false)
})

test('enroll refuses an empty passphrase', async () => {
  // Empty would make V identical to the main wallet's master key.
  await expect(enrollVault(args({ passphrase: '' }))).rejects.toMatchObject({
    code: 'bad-passphrase'
  })
})

test('the sealed vault node unseals through the YubiKey ceremony (ECDH)', async () => {
  const { pending } = await enrollVault(args())
  await finalizeEnrollment(pending)
  const seal = await vaultStore.getSeal()
  expect(seal).not.toBeNull()
  await mock.verifyPin('123456')
  const { secret } = await mock.ecdh(seal!.slot, '123456', seal!.ePub)

  // Device+PIN and mnemonic+passphrase must land on the SAME node, or the two
  // recovery paths would reach different vaults.
  const fromToken = HD.fromBinary(unsealVaultKey(seal!, secret))
  const fromPhrase = await recoverVaultHD(MNEMONIC, PASSPHRASE)
  expect(fromToken.toString()).toBe(fromPhrase.toString())

  // And the chain code survived, so deposit addresses are reachable.
  expect(depositPkhFromXpub(vaultXpub(fromToken), 7)).toBe(
    depositPkhFromXpub(vaultXpub(fromPhrase), 7)
  )
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

test('recoverVaultHD rejects an invalid phrase', async () => {
  await expect(recoverVaultHD('not a valid mnemonic phrase at all', PASSPHRASE)).rejects.toBeDefined()
})

test('recoverVaultHD rejects a mistyped passphrase against the stored xpub', async () => {
  // BIP39 passphrases have no checksum, so without the xpub check a typo would
  // silently open a different, EMPTY vault and look like lost funds.
  const xpub = vaultXpub(deriveVaultHD(MNEMONIC, PASSPHRASE))
  await expect(
    recoverVaultHD(MNEMONIC, 'correct horse battery staple anchoe', xpub)
  ).rejects.toMatchObject({ code: 'bad-passphrase' })
})

test('disableVault clears the seal and meta', async () => {
  const { pending } = await enrollVault(args())
  await finalizeEnrollment(pending)
  await disableVault()
  expect(await vaultStore.isEnrolled()).toBe(false)
  expect(await vaultStore.getMeta()).toBeNull()
})
