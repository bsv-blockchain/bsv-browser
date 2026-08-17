import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import i18n from '@/context/i18n/translations'
import {
  autoUnlockKek,
  deleteAllSecrets,
  deleteSecret,
  getSecret,
  getUnlockState,
  hasSecret,
  isUnlocked,
  migrateLegacySecrets,
  putSecret,
  readLegacySecret,
  subscribeUnlockState,
  unlockKek,
  type MigrationResult,
  type UnlockState
} from '@/services/secrets'

/**
 * Wallet secrets are held by services/secrets, which wraps them in AES-256-GCM
 * under a key the OS will only release after a biometric match. This provider
 * is the React surface over that: it runs the one-time migration off the old
 * plaintext scheme, exposes the unlock state to the UI, and keeps the
 * historical get/set/delete shape so callers did not have to change.
 *
 * The biometric prompt happens at most once per process, when the wallet is
 * first instantiated — but unlike the previous design, skipping it does not
 * yield the mnemonic, because there is nothing to read without the key.
 */
export interface LocalStorageContextType {
  /* secure */
  setMnemonic: (mnemonic: string) => Promise<boolean>
  getMnemonic: () => Promise<string | null>
  deleteMnemonic: () => Promise<void>
  setRecoveredKey: (wif: string) => Promise<boolean>
  getRecoveredKey: () => Promise<string | null>
  deleteRecoveredKey: () => Promise<void>
  deleteAllWalletKeys: () => Promise<void>

  /* unlock */
  /** False until the legacy migration has settled. Reading a secret before
   * this flips would report "no wallet" for an existing user. */
  secretsReady: boolean
  unlockState: UnlockState
  /** Explicit user-initiated unlock, for the lock screen's retry button. */
  unlock: () => Promise<UnlockState>
  migration: MigrationResult | null

  /* general */
  setItem: (item: string, value: string) => Promise<void>
  getItem: (item: string) => Promise<string | null>
  deleteItem: (item: string) => Promise<void>
}

export const LocalStorageContext = createContext<LocalStorageContextType>({
  /* secure */
  setMnemonic: async () => false,
  getMnemonic: async () => null,
  deleteMnemonic: async () => {},
  setRecoveredKey: async () => false,
  getRecoveredKey: async () => null,
  deleteRecoveredKey: async () => {},
  deleteAllWalletKeys: async () => {},

  /* unlock */
  secretsReady: false,
  unlockState: { status: 'locked' },
  unlock: async () => ({ status: 'locked' }),
  migration: null,

  /* general */
  getItem: AsyncStorage.getItem,
  setItem: AsyncStorage.setItem,
  deleteItem: AsyncStorage.removeItem
})

export const useLocalStorage = () => useContext(LocalStorageContext)

export default function LocalStorageProvider({ children }: { children: React.ReactNode }) {
  const [secretsReady, setSecretsReady] = useState(false)
  const [migration, setMigration] = useState<MigrationResult | null>(null)
  const [unlockState, setUnlockState] = useState<UnlockState>(getUnlockState)
  /** Set when migration failed: this session keeps serving the legacy plaintext
   * so the user still has a working wallet, and we retry on the next launch. */
  const legacyFallback = useRef(false)

  useEffect(() => subscribeUnlockState(setUnlockState), [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let result: MigrationResult
      try {
        result = await migrateLegacySecrets()
      } catch (err) {
        console.warn('[LocalStorageProvider] migration threw', (err as Error)?.message)
        result = { outcome: 'failed', stage: 'unknown', retryable: true }
      }
      if (cancelled) return
      legacyFallback.current = result.outcome === 'failed'
      setMigration(result)
      setSecretsReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /* --------------------------------- unlock -------------------------------- */

  const unlock = useCallback(
    () => unlockKek(i18n.t('biometric_unlock_wallet')),
    []
  )

  /**
   * The single implicit ceremony. Called on the read path so the returning
   * user sees exactly what they see today — one sheet at wallet build, no
   * extra tap — while `autoUnlockKek` guarantees we never initiate a second
   * one after a cancellation.
   */
  const ensureUnlocked = useCallback(async (): Promise<boolean> => {
    if (isUnlocked()) return true
    const state = await autoUnlockKek(i18n.t('biometric_unlock_wallet'))
    return state.status === 'unlocked'
  }, [])

  /* -------------------------------- secure --------------------------------- */

  const setMnemonic = useCallback(
    (mnemonic: string) => putSecret('mnemonic', mnemonic),
    []
  )

  const getMnemonic = useCallback(async (): Promise<string | null> => {
    if (legacyFallback.current) return readLegacySecret('mnemonic')
    if (!(await hasSecret('mnemonic'))) return null
    if (!(await ensureUnlocked())) return null
    return getSecret('mnemonic')
  }, [ensureUnlocked])

  const deleteMnemonic = useCallback(() => deleteSecret('mnemonic'), [])

  const setRecoveredKey = useCallback(
    (wif: string) => putSecret('recoveredKey', wif),
    []
  )

  const getRecoveredKey = useCallback(async (): Promise<string | null> => {
    if (legacyFallback.current) return readLegacySecret('recoveredKey')
    if (!(await hasSecret('recoveredKey'))) return null
    if (!(await ensureUnlocked())) return null
    return getSecret('recoveredKey')
  }, [ensureUnlocked])

  const deleteRecoveredKey = useCallback(() => deleteSecret('recoveredKey'), [])

  /** Wipes the secrets and the key protecting them, so the next launch reads as
   * a clean install instead of prompting for a wallet that no longer exists.
   * Works while locked or lost — deleting ciphertext needs no key. */
  const deleteAllWalletKeys = useCallback(() => deleteAllSecrets(), [])

  /* -------------------------------- output --------------------------------- */

  const value: LocalStorageContextType = useMemo(
    () => ({
      setMnemonic,
      getMnemonic,
      deleteMnemonic,
      setRecoveredKey,
      getRecoveredKey,
      deleteRecoveredKey,
      deleteAllWalletKeys,

      secretsReady,
      unlockState,
      unlock,
      migration,

      getItem: AsyncStorage.getItem,
      setItem: AsyncStorage.setItem,
      deleteItem: AsyncStorage.removeItem
    }),
    [
      setMnemonic,
      getMnemonic,
      deleteMnemonic,
      setRecoveredKey,
      getRecoveredKey,
      deleteRecoveredKey,
      deleteAllWalletKeys,
      secretsReady,
      unlockState,
      unlock,
      migration
    ]
  )

  return <LocalStorageContext.Provider value={value}>{children}</LocalStorageContext.Provider>
}
