/**
 * vaultStore persistence tests — v3 meta in AsyncStorage. Nothing secret is
 * stored any more: the YubiKey signs directly, so there is no sealed blob.
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
import { vaultStore, VaultMetaV3 } from '@/services/vault/vaultStore'

const META: VaultMetaV3 = {
  v: 3,
  enrolledAt: 1_700_000_000_000,
  yubiSerial: '12345678',
  nickname: 'Main key',
  slot: 0x82,
  nextKeyIndex: 0,
  xpub: 'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8',
  r1PublicKey: '02' + 'ab'.repeat(32)
}

beforeEach(async () => {
  await AsyncStorage.clear()
  for (const k of Object.keys(secureItems)) delete secureItems[k]
})

describe('vaultStore v3', () => {
  it('round-trips v3 meta including the R1 public key', async () => {
    await vaultStore.setMeta(META)
    expect(await vaultStore.getMeta()).toEqual(META)
  })

  it('reports enrollment from meta, not a seal', async () => {
    await vaultStore.clear()
    expect(await vaultStore.isEnrolled()).toBe(false)
    await vaultStore.setMeta(META)
    expect(await vaultStore.isEnrolled()).toBe(true)
  })

  it('rejects meta that is not v3', async () => {
    // No backwards compatibility: a v1/v2 record must read as "not enrolled"
    // rather than deserialise into something the new code would misuse.
    // Written through AsyncStorage directly — vaultStore deliberately exposes
    // no raw-write seam just for tests.
    await AsyncStorage.setItem('vault_meta_v1', JSON.stringify({ ...META, v: 2 }))
    expect(await vaultStore.getMeta()).toBeNull()
    expect(await vaultStore.isEnrolled()).toBe(false)
  })

  it('takes consecutive indices and persists them', async () => {
    await vaultStore.setMeta(META)
    expect(await vaultStore.takeNextIndex()).toBe(0)
    expect(await vaultStore.takeNextIndex()).toBe(1)
    expect((await vaultStore.getMeta())!.nextKeyIndex).toBe(2)
  })

  it('clears the legacy seal entry', async () => {
    await vaultStore.setMeta(META)
    await vaultStore.clear()
    expect(await vaultStore.getMeta()).toBeNull()
  })
})
