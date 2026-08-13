/**
 * VaultKeyService — enrollment, recovery, disable. Driven against the mock
 * YubiKey and the real (AsyncStorage/SecureStore-mocked) vaultStore.
 */
import { PrivateKey, KeyDeriver } from '@bsv/sdk'

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
import { enrollVault, finalizeEnrollment, recoverVaultKey, disableVault, VAULT_PROTOCOL } from '../../services/vault/VaultKeyService'
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

const deriveVaultPkh = (v: number[], keyID: string): string => {
  const kd = new KeyDeriver(new PrivateKey(v))
  return kd.derivePublicKey(VAULT_PROTOCOL, keyID, 'self', true).toHash('hex') as string
}

test('enroll builds seal + 64 deposit keys + phrase but does NOT persist until finalize (fix #4)', async () => {
  const phases: string[] = []
  const { backupMnemonic, pending } = await enrollVault({
    nickname: 'Work key',
    onPhase: p => phases.push(p),
    getPin: async () => '123456'
  })

  expect(backupMnemonic.split(' ').length).toBe(24)
  expect(phases).toContain('generating')
  expect(phases).toContain('done')

  // Nothing on disk yet — a user who backs out on the backup step is simply
  // not enrolled, never enrolled-with-no-phrase.
  expect(await vaultStore.isEnrolled()).toBe(false)
  expect(await vaultStore.getMeta()).toBeNull()

  expect(pending.meta.nickname).toBe('Work key')
  expect(pending.meta.yubiSerial).toBe('MOCK-1')
  expect(pending.meta.depositKeys).toHaveLength(64)
  expect(pending.meta.nextKeyIndex).toBe(64)
  expect(pending.meta.depositKeys[63].keyID).toBe('vault/63')

  // Only finalize persists.
  await finalizeEnrollment(pending)
  expect(await vaultStore.isEnrolled()).toBe(true)
  const meta = await vaultStore.getMeta()

  const v = (await recoverVaultKey(backupMnemonic)).toArray()
  expect(deriveVaultPkh(v, 'vault/0')).toBe(meta?.depositKeys[0].pkh)
  expect(deriveVaultPkh(v, 'vault/63')).toBe(meta?.depositKeys[63].pkh)
})

test('the sealed V unseals through the YubiKey ceremony (ECDH)', async () => {
  const { backupMnemonic, pending } = await enrollVault({
    nickname: 'k',
    onPhase: () => {},
    getPin: async () => '123456'
  })
  await finalizeEnrollment(pending)
  const seal = await vaultStore.getSeal()
  expect(seal).not.toBeNull()
  await mock.verifyPin('123456')
  const { secret } = await mock.ecdh(seal!.slot, '123456', seal!.ePub)
  const vFromToken = unsealVaultKey(seal!, secret)
  const vFromPhrase = (await recoverVaultKey(backupMnemonic)).toArray()
  expect(vFromToken).toEqual(vFromPhrase)
})

test('a factory-PIN key (user enters 123456) forces a PIN change (fix #5)', async () => {
  let changeArgs: { oldPin: string; newPin: string } | null = null
  await enrollVault({
    nickname: 'k',
    onPhase: () => {},
    getPin: async () => '123456', // factory
    requestPinChange: async () => {
      changeArgs = { oldPin: '123456', newPin: '654321' }
      return changeArgs
    }
  })
  expect(changeArgs).toEqual({ oldPin: '123456', newPin: '654321' })
})

test('a non-factory PIN never triggers a change and never burns a retry (fix #5)', async () => {
  mock.setPin('999999') // key already has a custom PIN
  let changeCalled = false
  await enrollVault({
    nickname: 'k',
    onPhase: () => {},
    getPin: async () => '999999',
    requestPinChange: async () => {
      changeCalled = true
      return { oldPin: '123456', newPin: 'x' }
    }
  })
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
    enrollVault({ nickname: 'k', onPhase: () => {}, getPin: async () => '123456' })
  ).rejects.toMatchObject({ code: 'pin-locked' })
})

test('recoverVaultKey rejects an invalid phrase', async () => {
  await expect(recoverVaultKey('not a valid mnemonic phrase at all')).rejects.toBeDefined()
})

test('disableVault clears the seal and meta', async () => {
  const { pending } = await enrollVault({ nickname: 'k', onPhase: () => {}, getPin: async () => '123456' })
  await finalizeEnrollment(pending)
  await disableVault()
  expect(await vaultStore.isEnrolled()).toBe(false)
  expect(await vaultStore.getMeta()).toBeNull()
})
