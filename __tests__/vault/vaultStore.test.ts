/**
 * vaultStore persistence tests — seal in SecureStore, metadata in
 * AsyncStorage, deposit-key queue semantics.
 */
import type { SealedBlob } from '../../services/vault/types'

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
import { vaultStore } from '../../services/vault/vaultStore'

const seal: SealedBlob = {
  v: 1,
  slot: 0x82,
  ePub: 'aa'.repeat(65),
  salt: 'bb'.repeat(32),
  c: 'cc'.repeat(64),
  yubiSerial: '31337042',
  yubiPubSha256: 'dd'.repeat(32)
}

beforeEach(async () => {
  await AsyncStorage.clear()
  for (const k of Object.keys(secureItems)) delete secureItems[k]
})

test('not enrolled until a seal is stored', async () => {
  expect(await vaultStore.isEnrolled()).toBe(false)
  await vaultStore.setSeal(seal)
  expect(await vaultStore.isEnrolled()).toBe(true)
  expect(await vaultStore.getSeal()).toEqual(seal)
})

test('meta round trip', async () => {
  expect(await vaultStore.getMeta()).toBeNull()
  const meta = {
    v: 1 as const,
    enrolledAt: 1755000000000,
    yubiSerial: '31337042',
    nickname: 'Work key',
    slot: 0x82,
    nextKeyIndex: 64,
    depositKeys: [
      { keyID: 'vault/0', pkh: '11'.repeat(20) },
      { keyID: 'vault/1', pkh: '22'.repeat(20) }
    ]
  }
  await vaultStore.setMeta(meta)
  expect(await vaultStore.getMeta()).toEqual(meta)
})

test('popDepositKey drains the queue and persists', async () => {
  await vaultStore.setMeta({
    v: 1,
    enrolledAt: 1,
    yubiSerial: 's',
    nickname: 'n',
    slot: 0x82,
    nextKeyIndex: 2,
    depositKeys: [
      { keyID: 'vault/0', pkh: 'aa'.repeat(20) },
      { keyID: 'vault/1', pkh: 'bb'.repeat(20) }
    ]
  })
  expect((await vaultStore.popDepositKey())?.keyID).toBe('vault/0')
  expect((await vaultStore.popDepositKey())?.keyID).toBe('vault/1')
  expect(await vaultStore.popDepositKey()).toBeNull()
  expect((await vaultStore.getMeta())?.depositKeys).toHaveLength(0)
})

test('pushDepositKeys appends and advances nextKeyIndex', async () => {
  await vaultStore.setMeta({
    v: 1,
    enrolledAt: 1,
    yubiSerial: 's',
    nickname: 'n',
    slot: 0x82,
    nextKeyIndex: 1,
    depositKeys: [{ keyID: 'vault/0', pkh: 'aa'.repeat(20) }]
  })
  await vaultStore.pushDepositKeys([{ keyID: 'vault/1', pkh: 'bb'.repeat(20) }], 2)
  const meta = await vaultStore.getMeta()
  expect(meta?.depositKeys.map(k => k.keyID)).toEqual(['vault/0', 'vault/1'])
  expect(meta?.nextKeyIndex).toBe(2)
})

test('clear removes seal and meta', async () => {
  await vaultStore.setSeal(seal)
  await vaultStore.setMeta({
    v: 1,
    enrolledAt: 1,
    yubiSerial: 's',
    nickname: 'n',
    slot: 0x82,
    nextKeyIndex: 0,
    depositKeys: []
  })
  await vaultStore.clear()
  expect(await vaultStore.isEnrolled()).toBe(false)
  expect(await vaultStore.getSeal()).toBeNull()
  expect(await vaultStore.getMeta()).toBeNull()
})
