/**
 * vaultStore persistence tests — seal in SecureStore, metadata in
 * AsyncStorage, deposit-key queue semantics.
 */
import type { SealedBlob } from '../../services/vault/types'
import type { VaultMetaV1 } from '../../services/vault/vaultStore'

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
  expect(((await vaultStore.getMeta()) as VaultMetaV1).depositKeys).toHaveLength(0)
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
  const meta = (await vaultStore.getMeta()) as VaultMetaV1
  expect(meta.depositKeys.map(k => k.keyID)).toEqual(['vault/0', 'vault/1'])
  expect(meta.nextKeyIndex).toBe(2)
})

// ── v2: xpub + a single counter, no precomputed key-hash queue ───────────

const metaV2 = {
  v: 2 as const,
  enrolledAt: 1755000000000,
  yubiSerial: '31337042',
  nickname: 'Work key',
  slot: 0x82,
  nextKeyIndex: 0,
  xpub: 'xpub-placeholder'
}

test('v2 meta round trips without a deposit-key queue', async () => {
  await vaultStore.setMeta(metaV2)
  const read = await vaultStore.getMeta()
  expect(read).toEqual(metaV2)
  expect(read && 'depositKeys' in read).toBe(false)
})

test('takeNextIndex hands out consecutive indices and persists each one', async () => {
  // Persist per call: a crash between deposits must never reissue an index,
  // because reuse would send two deposits to the same address.
  await vaultStore.setMeta(metaV2)
  expect(await vaultStore.takeNextIndex()).toBe(0)
  expect(await vaultStore.takeNextIndex()).toBe(1)
  expect(await vaultStore.takeNextIndex()).toBe(2)
  expect((await vaultStore.getMeta())?.nextKeyIndex).toBe(3)
})

test('takeNextIndex never runs out, unlike the old 64-key queue', async () => {
  await vaultStore.setMeta({ ...metaV2, nextKeyIndex: 999_999 })
  expect(await vaultStore.takeNextIndex()).toBe(999_999)
  expect(await vaultStore.takeNextIndex()).toBe(1_000_000)
})

test('takeNextIndex returns null when not enrolled', async () => {
  expect(await vaultStore.takeNextIndex()).toBeNull()
})

test('v1 meta still reads back, so existing enrollments are not stranded', async () => {
  // Device+PIN keeps working for v1 vaults: the seal is opaque to how V was
  // derived. Only the mnemonic-recovery path differs between versions.
  const v1 = {
    v: 1 as const,
    enrolledAt: 1,
    yubiSerial: 's',
    nickname: 'old key',
    slot: 0x82,
    nextKeyIndex: 64,
    depositKeys: [{ keyID: 'vault/0', pkh: 'aa'.repeat(20) }]
  }
  await vaultStore.setMeta(v1)
  const read = await vaultStore.getMeta()
  expect(read?.v).toBe(1)
  expect(read).toEqual(v1)
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
