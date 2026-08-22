/**
 * Vault persistence.
 *
 * - Sealed blob → expo-secure-store ('vault_seal_v1'), same Keychain
 *   accessibility class as the wallet mnemonic. The seal alone is useless
 *   without the physical YubiKey; SecureStore here is defense-in-depth, and
 *   it is deliberately NOT behind LocalStorageProvider's biometric latch —
 *   the YubiKey ceremony is the gate for anything the seal protects.
 * - UI metadata (serial, nickname, deposit-index counter) → AsyncStorage
 *   ('vault_meta_v1'). Nothing secret lives here, and no key material either:
 *   v4 carries no xpub and no card public key. The only thing that can
 *   produce a vault address is the private HD node, which exists solely for
 *   the length of a ceremony (or a mnemonic + passphrase recovery).
 *
 * v1-v3 records are not readable — `getMeta` returns null for anything whose
 * `v` isn't 4, so an un-migrated install reads as "not enrolled" rather than
 * deserialising into something this code would misuse.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { SealedBlob } from './types'

const SEAL_KEY = 'vault_seal_v1'
const META_KEY = 'vault_meta_v1'

/**
 * Current enrollment.
 *
 * K1-only vault: at rest this is just the sealed blob plus this plaintext
 * counter. No xpub and no card public key: the one secret at rest is the
 * seed inside the sealed blob, and nothing here narrows the search for it.
 */
export interface VaultMetaV4 {
  v: 4
  enrolledAt: number
  yubiSerial: string
  nickname: string
  /** PIV slot holding the card's P-256 ECDH key (0x82). */
  slot: number
  /** Next unused deposit index — monotonic, never reused. */
  nextKeyIndex: number
  lastUsedAt?: number
}

export type VaultMeta = VaultMetaV4

const secureOpts = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }

export const vaultStore = {
  async isEnrolled(): Promise<boolean> {
    const [meta, seal] = await Promise.all([vaultStore.getMeta(), vaultStore.getSeal()])
    return meta != null && seal != null
  },

  async getSeal(): Promise<SealedBlob | null> {
    const raw = await SecureStore.getItemAsync(SEAL_KEY, secureOpts)
    if (!raw) return null
    try {
      return JSON.parse(raw) as SealedBlob
    } catch {
      return null
    }
  },

  async setSeal(b: SealedBlob): Promise<void> {
    await SecureStore.setItemAsync(SEAL_KEY, JSON.stringify(b), secureOpts)
  },

  async getMeta(): Promise<VaultMeta | null> {
    const raw = await AsyncStorage.getItem(META_KEY)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as { v?: unknown }
      return parsed?.v === 4 ? (parsed as VaultMeta) : null
    } catch {
      return null
    }
  },

  async setMeta(m: VaultMeta): Promise<void> {
    await AsyncStorage.setItem(META_KEY, JSON.stringify(m))
  },

  /**
   * Reserve the next deposit index and advance the counter.
   *
   * Persisted before returning: a crash between deposits must never reissue an
   * index, since two deposits to the same K1 key are linkable and confusing.
   */
  async takeNextIndex(): Promise<number | null> {
    const meta = await vaultStore.getMeta()
    if (!meta) return null
    const index = meta.nextKeyIndex
    await vaultStore.setMeta({ ...meta, nextKeyIndex: index + 1 })
    return index
  },

  /** Remove everything, including the sealed blob — used by disable +
   * recovery flows. */
  async clear(): Promise<void> {
    await SecureStore.deleteItemAsync(SEAL_KEY).catch(() => {})
    await AsyncStorage.removeItem(META_KEY)
  }
}
