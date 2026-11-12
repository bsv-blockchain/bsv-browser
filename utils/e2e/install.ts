/**
 * Called from index.js before expo-router registers, and only when
 * EXPO_PUBLIC_E2E is "1". Installs the storage shim and asks i18n for English
 * so Maestro's text selectors match the strings in the flows.
 */

import { installE2EStorageShim } from './storageShim'

export function installE2EHooks(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const asyncStorageModule = require('@react-native-async-storage/async-storage')
  const storage = asyncStorageModule.default ?? asyncStorageModule
  installE2EStorageShim(storage)

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const i18nModule = require('@bsv/expo-wallet-toolbox/core/i18n/translations')
    const i18n = i18nModule.default ?? i18nModule
    if (i18n && typeof i18n.changeLanguage === 'function') {
      void i18n.changeLanguage('en')
    }
  } catch (error) {
    console.warn('[E2E] could not force English', error)
  }
}
