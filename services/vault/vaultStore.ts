/**
 * Vault persistence.
 *
 * Only AsyncStorage metadata now — nothing secret. The YubiKey signs directly,
 * so there is no sealed key to protect and the SecureStore entry is gone.
 * Deposit pkhs and the xpub become public the moment they are used on-chain,
 * and the R1 public key is published in every output's customInstructions.
 *
 * `clear()` still deletes the legacy seal entry so an upgraded install does not
 * leave dead key material in the Keychain.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'

/** Legacy SecureStore key. Written by no current code path — deleted on clear()
 * so an upgraded install sheds the old sealed blob. */
const LEGACY_SEAL_KEY = 'vault_seal_v1'
const META_KEY = 'vault_meta_v1'

/**
 * Current enrollment.
 *
 * v3 drops the sealed blob and the v1 deposit-key queue, and adds the YubiKey's
 * P-256 public key. v1 and v2 records are not readable — `getMeta` returns null
 * for them, so an un-migrated install reads as "not enrolled" rather than
 * deserialising into something this code would misuse.
 */
export interface VaultMetaV3 {
  v: 3
  enrolledAt: number
  yubiSerial: string
  nickname: string
  /** PIV slot holding the R1 key (0x82). */
  slot: number
  /** Next unused deposit index — monotonic, never reused. */
  nextKeyIndex: number
  lastUsedAt?: number
  /** Public-only vault node. Derives every K1 deposit key; cannot spend. */
  xpub: string
  /** The YubiKey's P-256 public key, 33-byte compressed, hex. */
  r1PublicKey: string
}

export type VaultMeta = VaultMetaV3

export const vaultStore = {
  async isEnrolled(): Promise<boolean> {
    return (await vaultStore.getMeta()) != null
  },

  async getMeta(): Promise<VaultMeta | null> {
    const raw = await AsyncStorage.getItem(META_KEY)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as { v?: unknown }
      return parsed?.v === 3 ? (parsed as VaultMeta) : null
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

  /** Remove everything, including the legacy sealed blob. */
  async clear(): Promise<void> {
    await SecureStore.deleteItemAsync(LEGACY_SEAL_KEY).catch(() => {})
    await AsyncStorage.removeItem(META_KEY)
  }
}
