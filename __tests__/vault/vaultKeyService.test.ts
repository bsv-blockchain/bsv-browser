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
import { enrollVault, recoverVaultKey, disableVault, VAULT_PROTOCOL } from '../../services/vault/VaultKeyService'
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

test('enroll seals V to the key, queues 64 deposit keys, returns a recovery phrase', async () => {
  const phases: string[] = []
  const { backupMnemonic } = await enrollVault({
    nickname: 'Work key',
    onPhase: p => phases.push(p),
    getPin: async () => '123456'
  })

  expect(backupMnemonic.split(' ').length).toBe(24)
  expect(phases).toContain('generating')
  expect(phases).toContain('sealing')
  expect(phases).toContain('done')

  expect(await vaultStore.isEnrolled()).toBe(true)
  const meta = await vaultStore.getMeta()
  expect(meta?.nickname).toBe('Work key')
  expect(meta?.yubiSerial).toBe('MOCK-1')
  expect(meta?.depositKeys).toHaveLength(64)
  expect(meta?.nextKeyIndex).toBe(64)
  expect(meta?.depositKeys[0].keyID).toBe('vault/0')
  expect(meta?.depositKeys[63].keyID).toBe('vault/63')

  // The recovery phrase must recover the exact V that was sealed: derive V from
  // the phrase, then confirm the deposit-key hashes match.
  const v = (await recoverVaultKey(backupMnemonic)).toArray()
  expect(deriveVaultPkh(v, 'vault/0')).toBe(meta?.depositKeys[0].pkh)
  expect(deriveVaultPkh(v, 'vault/63')).toBe(meta?.depositKeys[63].pkh)
})

test('the sealed V unseals through the YubiKey ceremony (ECDH)', async () => {
  const { backupMnemonic } = await enrollVault({
    nickname: 'k',
    onPhase: () => {},
    getPin: async () => '123456'
  })
  const seal = await vaultStore.getSeal()
  expect(seal).not.toBeNull()
  // reproduce the ceremony: verify PIN then ECDH against the seal's ephemeral pub
  await mock.verifyPin('123456')
  const { secret } = await mock.ecdh(seal!.slot, '123456', seal!.ePub)
  const vFromToken = unsealVaultKey(seal!, secret)
  const vFromPhrase = (await recoverVaultKey(backupMnemonic)).toArray()
  expect(vFromToken).toEqual(vFromPhrase)
})

test('default PIN (123456) forces a PIN change during enrollment', async () => {
  let changeCalled = false
  await enrollVault({
    nickname: 'k',
    onPhase: () => {},
    getPin: async () => '654321',
    requestPinChange: async () => {
      changeCalled = true
      return { oldPin: '123456', newPin: '654321' }
    }
  })
  expect(changeCalled).toBe(true)
})

test('recoverVaultKey rejects an invalid phrase', async () => {
  await expect(recoverVaultKey('not a valid mnemonic phrase at all')).rejects.toBeDefined()
})

test('disableVault clears the seal and meta', async () => {
  await enrollVault({ nickname: 'k', onPhase: () => {}, getPin: async () => '123456' })
  await disableVault()
  expect(await vaultStore.isEnrolled()).toBe(false)
  expect(await vaultStore.getMeta()).toBeNull()
})
