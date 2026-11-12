/**
 * Wraps AsyncStorage for an e2e build.
 *
 * - The wallet profile is always testnet, including values the UI later writes.
 * - Every chain's custom Arcade URL is the local mock, which refuses broadcasts.
 *
 * The real AsyncStorage object is patched in place because the toolbox calls
 * `AsyncStorage.getItem` on the singleton. Replacing the methods is enough;
 * callers that already captured the function reference are not used by the
 * toolbox (it calls the method each time).
 */

import { E2E_ARC_URL, E2E_PROFILES_KEY, forceTestnetProfiles, isArcStorageKey } from './policy'

export interface StorageLike {
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
}

export function installE2EStorageShim(storage: StorageLike): void {
  const getItem = storage.getItem.bind(storage)
  const setItem = storage.setItem.bind(storage)

  storage.getItem = async (key: string) => {
    if (key === E2E_PROFILES_KEY) return forceTestnetProfiles(await getItem(key))
    if (isArcStorageKey(key)) return E2E_ARC_URL
    return getItem(key)
  }

  storage.setItem = async (key: string, value: string) => {
    if (key === E2E_PROFILES_KEY) {
      await setItem(key, forceTestnetProfiles(value))
      return
    }
    if (isArcStorageKey(key)) {
      await setItem(key, E2E_ARC_URL)
      return
    }
    await setItem(key, value)
  }
}
