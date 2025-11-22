/**
 * BSV Wallet Storage for React Native using expo-sqlite
 *
 * This module provides local storage for BSV wallet data on mobile platforms,
 * based on the @bsv/wallet-toolbox StorageIdb and StorageKnex implementations.
 *
 * Usage:
 * ```typescript
 * import { StorageExpoSQLite } from './storage'
 *
 * const storage = new StorageExpoSQLite({ chain: 'main' })
 * await storage.migrate('my-wallet', 'identity-key-123')
 *
 * // Insert a user
 * const userId = await storage.insertUser({ identityKey: 'pubkey...' })
 *
 * // Find users
 * const users = await storage.findUsers({ partial: { identityKey: 'pubkey...' } })
 * ```
 */

// Import implementation to ensure methods are attached
import './StorageExpoSQLiteImpl'

// Export main class and types
export { StorageExpoSQLite, TrxToken } from './StorageExpoSQLite'
export type {
  TableUser,
  TableProvenTx,
  TableProvenTxReq,
  TableCertificate,
  TableCertificateField,
  TableOutputBasket,
  TableTransaction,
  TableCommission,
  TableOutput,
  TableOutputTag,
  TableOutputTagMap,
  TableTxLabel,
  TableTxLabelMap,
  TableMonitorEvent,
  TableSyncState,
  FindArgs
} from './StorageExpoSQLiteMethods'

// Export schema utilities
export { createTables } from './schema/createTables'
