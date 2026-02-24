/**
 * Adapter to make StorageExpoSQLite work with the wallet-toolbox ecosystem
 *
 * This is a temporary adapter that allows using local SQLite storage
 * until StorageExpoSQLite fully implements the WalletStorageProvider interface
 */

import { StorageProvider } from '@bsv/wallet-toolbox-mobile'
import { StorageExpoSQLite } from './StorageExpoSQLite'

export interface LocalStorageConfig {
  network: 'main' | 'test'
  identityKey: string
  storageName?: string
}

/**
 * Initialize local storage for the wallet
 */
export async function initializeLocalStorage(config: LocalStorageConfig): Promise<StorageExpoSQLite> {
  const { network, identityKey, storageName = 'bsv-wallet' } = config

  // Create storage instance
  const storage = new StorageExpoSQLite({
    ...StorageProvider.createStorageBaseOptions(network)
  })

  // Initialize database
  await storage.migrate(storageName, identityKey)

  // Verify it's ready
  await storage.makeAvailable()

  return storage
}

/**
 * Check if a storage URL indicates local storage
 */
export function isLocalStorage(storageUrl: string): boolean {
  return storageUrl === 'local'
}

/**
 * Get storage display name
 */
export function getStorageDisplayName(storageUrl: string): string {
  if (isLocalStorage(storageUrl)) {
    return 'Local Storage (On Device)'
  }
  try {
    return new URL(storageUrl).hostname
  } catch {
    return storageUrl
  }
}
