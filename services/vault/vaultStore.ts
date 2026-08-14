/**
 * Vault persistence.
 *
 * - Sealed blob → expo-secure-store ('vault_seal_v1'), same Keychain
 *   accessibility class as the wallet mnemonic. The seal is useless without
 *   the physical YubiKey; SecureStore here is defense-in-depth, and it is
 *   deliberately NOT behind LocalStorageProvider's biometric latch — the
 *   YubiKey ceremony is the gate for anything the seal protects.
 * - UI metadata (serial, nickname, deposit-key queue) → AsyncStorage
 *   ('vault_meta_v1'). Nothing secret lives here: deposit pkhs become public
 *   the moment they are used on-chain.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { SealedBlob } from './types'

const SEAL_KEY = 'vault_seal_v1'
const META_KEY = 'vault_meta_v1'

interface VaultMetaCommon {
  enrolledAt: number
  yubiSerial: string
  nickname: string
  slot: number
  /** Next unused deposit index — monotonic, never reused. */
  nextKeyIndex: number
  lastUsedAt?: number
}

/**
 * Legacy enrollment: V was a second random 24-word mnemonic, and deposits drew
 * from a precomputed queue of BRC-42 key hashes that had to be refilled by a
 * privileged ceremony once exhausted.
 *
 * Still read (never written) so existing vaults keep working — the seal is
 * opaque to how V was derived, so device+PIN is unaffected. Only the
 * mnemonic-recovery path differs by version.
 */
export interface VaultMetaV1 extends VaultMetaCommon {
  v: 1
  depositKeys: { keyID: string; pkh: string }[]
}

/**
 * Current enrollment: V derives from the main wallet mnemonic plus a vault
 * passphrase, and deposit addresses are BIP32 children of the stored xpub.
 * No queue, no refill ceremony, unlimited addresses.
 */
export interface VaultMetaV2 extends VaultMetaCommon {
  v: 2
  /** Public-only vault node. Derives every deposit address; cannot spend. */
  xpub: string
}

export type VaultMeta = VaultMetaV1 | VaultMetaV2

export const isV2 = (m: VaultMeta | null): m is VaultMetaV2 => m?.v === 2

const secureOpts = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }

export const vaultStore = {
  async isEnrolled(): Promise<boolean> {
    return (await SecureStore.getItemAsync(SEAL_KEY, secureOpts)) != null
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
      return JSON.parse(raw) as VaultMeta
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
   * index, since two deposits to the same address are linkable and confusing.
   * Returns null when there is no enrollment.
   */
  async takeNextIndex(): Promise<number | null> {
    const meta = await vaultStore.getMeta()
    if (!meta) return null
    const index = meta.nextKeyIndex
    await vaultStore.setMeta({ ...meta, nextKeyIndex: index + 1 })
    return index
  },

  /** v1 only. Pop the next deposit key off the legacy queue (persisted
   * immediately). Returns null when the queue is empty — v1 callers had to
   * replenish via a privileged ceremony. */
  async popDepositKey(): Promise<{ keyID: string; pkh: string } | null> {
    const meta = await vaultStore.getMeta()
    if (!meta || meta.v !== 1 || meta.depositKeys.length === 0) return null
    const [head, ...rest] = meta.depositKeys
    await vaultStore.setMeta({ ...meta, depositKeys: rest })
    return head
  },

  /** v1 only. Append freshly derived deposit keys and advance the cursor. */
  async pushDepositKeys(keys: { keyID: string; pkh: string }[], nextKeyIndex: number): Promise<void> {
    const meta = await vaultStore.getMeta()
    if (!meta) throw new Error('vaultStore: no meta to push deposit keys into')
    if (meta.v !== 1) throw new Error('vaultStore: deposit-key queue is v1 only')
    await vaultStore.setMeta({
      ...meta,
      depositKeys: [...meta.depositKeys, ...keys],
      nextKeyIndex
    })
  },

  /** Remove everything — used by disable + recovery flows. */
  async clear(): Promise<void> {
    await SecureStore.deleteItemAsync(SEAL_KEY)
    await AsyncStorage.removeItem(META_KEY)
  }
}
