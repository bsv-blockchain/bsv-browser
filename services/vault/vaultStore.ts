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

export interface VaultMeta {
  v: 1
  enrolledAt: number
  yubiSerial: string
  nickname: string
  slot: number
  /** Next unused index for keyID 'vault/<n>' — monotonic, never reused. */
  nextKeyIndex: number
  /** Precomputed deposit keys so deposits never need the YubiKey. */
  depositKeys: { keyID: string; pkh: string }[]
  lastUsedAt?: number
}

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

  /** Pop the next deposit key off the queue (persisted immediately).
   * Returns null when the queue is empty — callers replenish via ceremony. */
  async popDepositKey(): Promise<{ keyID: string; pkh: string } | null> {
    const meta = await vaultStore.getMeta()
    if (!meta || meta.depositKeys.length === 0) return null
    const [head, ...rest] = meta.depositKeys
    await vaultStore.setMeta({ ...meta, depositKeys: rest })
    return head
  },

  /** Append freshly derived deposit keys and advance the index cursor. */
  async pushDepositKeys(keys: { keyID: string; pkh: string }[], nextKeyIndex: number): Promise<void> {
    const meta = await vaultStore.getMeta()
    if (!meta) throw new Error('vaultStore: no meta to push deposit keys into')
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
