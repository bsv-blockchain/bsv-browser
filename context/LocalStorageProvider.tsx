import React, { createContext, useCallback, useContext, useMemo } from 'react'
import * as SecureStore from 'expo-secure-store'
import AsyncStorage from '@react-native-async-storage/async-storage'
import i18n from '@/context/i18n/translations'

export interface LocalStorageContextType {
  /* secure */
  setMnemonic: (mnemonic: string) => Promise<boolean>
  getMnemonic: () => Promise<string | null>
  deleteMnemonic: () => Promise<void>
  setRecoveredKey: (wif: string) => Promise<boolean>
  getRecoveredKey: () => Promise<string | null>
  deleteRecoveredKey: () => Promise<void>

  /* general */
  setItem: (item: string, value: string) => Promise<void>
  getItem: (item: string) => Promise<string | null>
  deleteItem: (item: string) => Promise<void>
}

const MNEMONIC_KEY = 'mnemonic'
const RECOVERED_KEY = 'recoveredKey'
// Fast-path hint (plaintext AsyncStorage): "a wallet secret was stored". Lets us
// avoid a pointless biometric prompt when there is genuinely no wallet, and lets
// callers tell "no wallet" apart from "wallet exists but its key is unreadable".
export const HAS_WALLET_KEYS = 'hasWalletKeys'

// Dedicated keychain service for the auth-bound secrets. This MUST stay
// separate from the app's non-authenticated SecureStore usage (e.g. the
// WalletConnect sequence counters): expo-secure-store cannot mix authenticated
// and unauthenticated items under the same keychainService.
const SECURE_KEYCHAIN_SERVICE = 'bsv-wallet-secure'

// Auth is enforced by the OS and bound to the keychain item via
// requireAuthentication — Face ID / Touch ID / device credential fires on every
// read, not a JS-side check a debugger or direct getItemAsync could skip. The
// library is patched (patches/expo-secure-store) so the item uses biometryAny /
// setInvalidatedByBiometricEnrollment(false) and survives biometric enrollment
// changes instead of being wiped.
const SECURE_WRITE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: SECURE_KEYCHAIN_SERVICE,
  requireAuthentication: true,
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
}

const secureReadOptions = (): SecureStore.SecureStoreOptions => ({
  keychainService: SECURE_KEYCHAIN_SERVICE,
  requireAuthentication: true,
  authenticationPrompt: i18n.t('biometric_load_wallet')
})

const SECURE_DELETE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: SECURE_KEYCHAIN_SERVICE
}

export const LocalStorageContext = createContext<LocalStorageContextType>({
  /* secure */
  setMnemonic: async () => false,
  getMnemonic: async () => null,
  deleteMnemonic: async () => {},
  setRecoveredKey: async () => false,
  getRecoveredKey: async () => null,
  deleteRecoveredKey: async () => {},

  /* general */
  getItem: AsyncStorage.getItem,
  setItem: AsyncStorage.setItem,
  deleteItem: AsyncStorage.removeItem
})

export const useLocalStorage = () => useContext(LocalStorageContext)

export default function LocalStorageProvider({ children }: { children: React.ReactNode }) {
  /* -------------------------------- secure --------------------------------- */

  const setMnemonic = useCallback(async (mnemonic: string): Promise<boolean> => {
    try {
      await SecureStore.setItemAsync(MNEMONIC_KEY, mnemonic, SECURE_WRITE_OPTIONS)
      await AsyncStorage.setItem(HAS_WALLET_KEYS, 'true')
      return true
    } catch (err) {
      console.warn('[setMnemonic]', err)
      return false
    }
  }, [])

  const getMnemonic = useCallback(async (): Promise<string | null> => {
    // Fast path: never trigger a biometric prompt when there is genuinely no
    // wallet. Absence/invalidation resolves to null; an auth cancel rejects and
    // is allowed to propagate so callers can keep the wallet locked and retry
    // rather than mistaking a cancel for "no wallet".
    const hasKeys = await AsyncStorage.getItem(HAS_WALLET_KEYS)
    if (!hasKeys) return null
    return await SecureStore.getItemAsync(MNEMONIC_KEY, secureReadOptions())
  }, [])

  const deleteMnemonic = useCallback(async (): Promise<void> => {
    try {
      await SecureStore.deleteItemAsync(MNEMONIC_KEY, SECURE_DELETE_OPTIONS)
      await AsyncStorage.removeItem(HAS_WALLET_KEYS)
    } catch (err) {
      console.warn('[deleteMnemonic]', err)
    }
  }, [])

  /* ----------------------------- recovered key ------------------------------ */

  const setRecoveredKey = useCallback(async (wif: string): Promise<boolean> => {
    try {
      await SecureStore.setItemAsync(RECOVERED_KEY, wif, SECURE_WRITE_OPTIONS)
      await AsyncStorage.setItem(HAS_WALLET_KEYS, 'true')
      return true
    } catch (err) {
      console.warn('[setRecoveredKey]', err)
      return false
    }
  }, [])

  const getRecoveredKey = useCallback(async (): Promise<string | null> => {
    const hasKeys = await AsyncStorage.getItem(HAS_WALLET_KEYS)
    if (!hasKeys) return null
    return await SecureStore.getItemAsync(RECOVERED_KEY, secureReadOptions())
  }, [])

  const deleteRecoveredKey = useCallback(async (): Promise<void> => {
    try {
      await SecureStore.deleteItemAsync(RECOVERED_KEY, SECURE_DELETE_OPTIONS)
      await AsyncStorage.removeItem(HAS_WALLET_KEYS)
    } catch (err) {
      console.warn('[deleteRecoveredKey]', err)
    }
  }, [])

  /* -------------------------------- output --------------------------------- */

  const value: LocalStorageContextType = useMemo(
    () => ({
      /* secure */
      setMnemonic,
      getMnemonic,
      deleteMnemonic,
      setRecoveredKey,
      getRecoveredKey,
      deleteRecoveredKey,

      /* general */
      getItem: AsyncStorage.getItem,
      setItem: AsyncStorage.setItem,
      deleteItem: AsyncStorage.removeItem
    }),
    [setMnemonic, getMnemonic, deleteMnemonic, setRecoveredKey, getRecoveredKey, deleteRecoveredKey]
  )

  return <LocalStorageContext.Provider value={value}>{children}</LocalStorageContext.Provider>
}
