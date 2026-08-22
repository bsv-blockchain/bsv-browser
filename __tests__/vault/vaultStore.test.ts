/**
 * vaultStore persistence tests — v4 meta in AsyncStorage, sealed blob in
 * SecureStore. Meta v4 carries no key material at all: no xpub, no R1 public
 * key. Those live only inside the sealed blob, opened through the YubiKey
 * ceremony.
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
import { vaultStore, VaultMetaV4 } from '@/services/vault/vaultStore'
import { SealedBlob } from '@/services/vault/types'

const META: VaultMetaV4 = {
  v: 4,
  enrolledAt: 1_700_000_000_000,
  yubiSerial: '12345678',
  nickname: 'Main key',
  slot: 0x82,
  nextKeyIndex: 0
}

const SEAL: SealedBlob = {
  v: 1,
  slot: 0x82,
  ePub: '04' + 'cd'.repeat(64),
  salt: 'ab'.repeat(32),
  c: 'ef'.repeat(48),
  yubiSerial: '12345678',
  yubiPubSha256: '11'.repeat(32)
}

beforeEach(async () => {
  await AsyncStorage.clear()
  for (const k of Object.keys(secureItems)) delete secureItems[k]
})

describe('vaultStore v4', () => {
  it('round-trips v4 meta with no xpub / r1PublicKey', async () => {
    await vaultStore.setMeta(META)
    const got = await vaultStore.getMeta()
    expect(got).toEqual(META)
    expect(got).not.toHaveProperty('xpub')
    expect(got).not.toHaveProperty('r1PublicKey')
  })

  it('rejects meta that is not v4', async () => {
    // No backwards compatibility: an old v3 record (with xpub/r1PublicKey)
    // must read as "not enrolled" rather than deserialise into something the
    // new code would misuse.
    // Written through AsyncStorage directly — vaultStore deliberately exposes
    // no raw-write seam just for tests.
    await AsyncStorage.setItem(
      'vault_meta_v1',
      JSON.stringify({ ...META, v: 3, xpub: 'x', r1PublicKey: 'y' })
    )
    expect(await vaultStore.getMeta()).toBeNull()
    expect(await vaultStore.isEnrolled()).toBe(false)
  })

  it('round-trips a sealed blob via setSeal/getSeal', async () => {
    expect(await vaultStore.getSeal()).toBeNull()
    await vaultStore.setSeal(SEAL)
    expect(await vaultStore.getSeal()).toEqual(SEAL)
  })

  it('isEnrolled requires both meta v4 and a seal', async () => {
    expect(await vaultStore.isEnrolled()).toBe(false)

    await vaultStore.setMeta(META)
    expect(await vaultStore.isEnrolled()).toBe(false) // meta only, no seal

    await vaultStore.setSeal(SEAL)
    expect(await vaultStore.isEnrolled()).toBe(true)
  })

  it('takes consecutive indices and persists them', async () => {
    await vaultStore.setMeta(META)
    expect(await vaultStore.takeNextIndex()).toBe(0)
    expect(await vaultStore.takeNextIndex()).toBe(1)
    expect((await vaultStore.getMeta())!.nextKeyIndex).toBe(2)
  })

  it('clear() removes both the meta and the seal', async () => {
    await vaultStore.setMeta(META)
    await vaultStore.setSeal(SEAL)
    await vaultStore.clear()
    expect(await vaultStore.getMeta()).toBeNull()
    expect(await vaultStore.getSeal()).toBeNull()
    expect(await vaultStore.isEnrolled()).toBe(false)
  })

  it('clears a legacy seal entry even with no meta present', async () => {
    // Seed the SecureStore key directly, as an upgraded install might still
    // have one sitting in the Keychain.
    secureItems['vault_seal_v1'] = 'legacy-sealed-blob'
    await vaultStore.clear()
    expect(secureItems['vault_seal_v1']).toBeUndefined()
  })
})
