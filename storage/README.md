# BSV Wallet Storage - Expo SQLite

Local storage implementation for BSV wallet data on mobile platforms using expo-sqlite. This implementation is based on the `@bsv/wallet-toolbox` `StorageIdb` and `StorageKnex` implementations, adapted for React Native with Expo.

## Features

- **Full wallet storage**: Supports all wallet data types including transactions, outputs, certificates, labels, and tags
- **SQLite-based**: Uses expo-sqlite for reliable local storage on iOS and Android
- **Transaction support**: Atomic operations with rollback capabilities
- **Type-safe**: Full TypeScript support with comprehensive type definitions
- **Schema migrations**: Automatic table creation and initialization
- **Compatible with wallet-toolbox**: Designed to work with `@bsv/wallet-toolbox` ecosystem

## Installation

The storage module requires expo-sqlite, which is already installed in this project:

```bash
npm install expo-sqlite
```

## Usage

### Basic Setup

```typescript
import { StorageExpoSQLite } from './storage'

// Create storage instance
const storage = new StorageExpoSQLite({
  chain: 'main', // or 'test'
  databaseName: 'my-wallet.db' // optional, defaults to 'wallet-toolbox-{chain}net.db'
})

// Initialize database
await storage.migrate('wallet-name', 'storage-identity-key')

// Check availability
if (storage.isAvailable()) {
  console.log('Storage is ready')
}
```

### Working with Users

```typescript
// Create or find a user
const { user, isNew } = await storage.findOrInsertUser('user-identity-key')

console.log('User ID:', user.userId)
console.log('Is new user:', isNew)

// Update user
await storage.updateUser(user.userId, {
  activeStorage: 'new-storage-key'
})

// Find users
const users = await storage.findUsers({
  partial: { identityKey: 'user-identity-key' }
})
```

### Managing Transactions

```typescript
// Create a transaction
const txId = await storage.insertTransaction({
  userId: user.userId,
  status: 'completed',
  reference: 'unique-tx-reference',
  satoshis: 100000,
  description: 'Payment for services',
  isOutgoing: false,
  version: 1,
  lockTime: 0
})

// Find transactions
const transactions = await storage.findTransactions({
  partial: {
    userId: user.userId,
    status: 'completed'
  },
  orderDescending: true,
  limit: 10
})

// Update transaction
await storage.updateTransaction(txId, {
  status: 'unproven'
})

// Count transactions
const count = await storage.countTransactions({
  partial: { userId: user.userId }
})
```

### Managing Outputs

```typescript
// Create output basket
const basket = await storage.findOrInsertOutputBasket(user.userId, 'default')

// Insert output
const outputId = await storage.insertOutput({
  userId: user.userId,
  transactionId: txId,
  vout: 0,
  satoshis: 100000,
  basketId: basket.basketId,
  spendable: true,
  change: false,
  outpoint: 'txid:0',
  providedBy: 'you'
})

// Find spendable outputs
const outputs = await storage.findOutputs({
  partial: {
    userId: user.userId,
    spendable: true
  }
})

// Update output (mark as spent)
await storage.updateOutput(outputId, {
  spendable: false,
  spentBy: 'spending-txid'
})
```

### Using Transactions (Atomic Operations)

```typescript
// Ensure all operations succeed or fail together
await storage.transaction(async (trx) => {
  // Create transaction
  const txId = await storage.insertTransaction({
    userId: user.userId,
    status: 'completed',
    reference: 'atomic-ref',
    satoshis: 50000
  }, trx)

  // Create output
  await storage.insertOutput({
    userId: user.userId,
    transactionId: txId,
    vout: 0,
    satoshis: 50000,
    basketId: basket.basketId,
    outpoint: 'atomic-ref:0',
    providedBy: 'you'
  }, trx)

  // If any operation fails, everything rolls back
})
```

### Labels and Tags

```typescript
// Create transaction label
const label = await storage.findOrInsertTxLabel(user.userId, 'payment')

// Map label to transaction
await storage.insertTxLabelMap({
  txLabelId: label.txLabelId,
  transactionId: txId
})

// Create output tag
const tag = await storage.findOrInsertOutputTag(user.userId, 'income')

// Map tag to output
await storage.insertOutputTagMap({
  outputTagId: tag.outputTagId,
  outputId: outputId
})
```

### Certificates

```typescript
// Insert certificate
const certId = await storage.insertCertificate({
  userId: user.userId,
  type: 'identity',
  subject: 'user-subject',
  serialNumber: 'cert-serial-123',
  certifier: 'certifier-key',
  revocationOutpoint: 'outpoint',
  signature: 'signature'
})

// Add certificate field
await storage.insertCertificateField({
  certificateId: certId,
  userId: user.userId,
  fieldName: 'email',
  fieldValue: 'encrypted-email',
  masterKey: 'master-key'
})

// Find certificates
const certs = await storage.findCertificates({
  partial: { userId: user.userId, type: 'identity' }
})
```

### Proven Transactions

```typescript
// Insert proven transaction
const provenTxId = await storage.insertProvenTx({
  txid: 'transaction-hash',
  height: 800000,
  idx: 5,
  merklePath: merklePathArray,
  rawTx: rawTxArray,
  blockHash: 'block-hash',
  merkleRoot: 'merkle-root'
})

// Create proof request
const reqId = await storage.insertProvenTxReq({
  txid: 'transaction-hash',
  status: 'pending',
  attempts: 0,
  notified: 0
})

// Update proof request when proven
await storage.updateProvenTxReq(reqId, {
  status: 'completed',
  provenTxId: provenTxId
})
```

## Database Schema

The storage implementation creates the following tables:

- **users**: User identities and settings
- **transactions**: Transaction records with status tracking
- **outputs**: Transaction outputs (UTXOs)
- **output_baskets**: Logical groupings of outputs
- **output_tags**: Tags for categorizing outputs
- **output_tags_map**: Many-to-many relationship between outputs and tags
- **tx_labels**: Labels for categorizing transactions
- **tx_labels_map**: Many-to-many relationship between transactions and labels
- **certificates**: Identity certificates
- **certificate_fields**: Certificate field data
- **proven_txs**: Transactions with merkle proofs
- **proven_tx_reqs**: Requests for transaction proofs
- **commissions**: Commission outputs
- **sync_states**: Synchronization state tracking
- **monitor_events**: Event monitoring logs
- **settings**: Storage configuration (singleton)

## Type Definitions

All tables have corresponding TypeScript interfaces exported from the module:

```typescript
import type {
  TableUser,
  TableTransaction,
  TableOutput,
  TableOutputBasket,
  TableCertificate,
  // ... and more
} from './storage'
```

## API Reference

### Core Methods

- `migrate(storageName, storageIdentityKey)`: Initialize database
- `isAvailable()`: Check if storage is ready
- `makeAvailable()`: Ensure storage is initialized and return settings
- `getSettings()`: Get storage configuration
- `destroy()`: Close database connection
- `dropAllData()`: Delete all data (useful for testing)
- `transaction(scope)`: Execute operations atomically

### Insert Methods

All entities have `insert*` methods:
- `insertUser(user)`
- `insertTransaction(tx)`
- `insertOutput(output)`
- `insertCertificate(cert)`
- etc.

### Update Methods

All entities have `update*` methods:
- `updateUser(id, update)`
- `updateTransaction(id, update)`
- `updateOutput(id, update)`
- etc.

### Find Methods

All entities have `find*` methods with filtering:
- `findUsers(args)`
- `findTransactions(args)`
- `findOutputs(args)`
- etc.

Find arguments support:
```typescript
interface FindArgs<T> {
  partial: Partial<T>      // Filter by fields
  since?: Date             // Filter by update time
  limit?: number           // Pagination limit
  offset?: number          // Pagination offset
  orderDescending?: boolean // Sort order
  trx?: TrxToken          // Transaction context
}
```

### Find By ID Methods

Direct lookups by primary key:
- `findUserById(id)`
- `findTransactionById(id)`
- `findOutputById(id)`
- etc.

### Count Methods

Count records matching criteria:
- `countUsers(args)`
- `countTransactions(args)`
- `countOutputs(args)`
- etc.

### Find Or Insert Methods

Convenience methods that create if not exists:
- `findOrInsertUser(identityKey)`
- `findOrInsertTransaction(newTx)`
- `findOrInsertOutputBasket(userId, name)`
- `findOrInsertTxLabel(userId, label)`
- `findOrInsertOutputTag(userId, tag)`

## Data Type Conversions

The storage implementation handles several automatic conversions:

- **Dates**: Stored as ISO strings, returned as Date objects
- **Booleans**: Stored as integers (0/1), returned as booleans
- **BLOBs**: Number arrays converted to Uint8Array for storage
- **Timestamps**: Automatically managed (created_at, updated_at)

## Examples

See [example.ts](./example.ts) for comprehensive usage examples including:
- Basic CRUD operations
- Transaction usage
- Query and filtering
- Labels and tags
- Cleanup operations

## Integration with wallet-toolbox

This storage implementation follows the same patterns as `@bsv/wallet-toolbox` StorageIdb and can be used as a drop-in replacement for mobile platforms. The table structures and method signatures are designed to be compatible with the wallet-toolbox ecosystem.

## Future Enhancements

Potential areas for improvement:
- Add support for advanced querying (complex WHERE clauses)
- Implement filter methods (for streaming large result sets)
- Add sync methods for multi-device synchronization
- Implement storage provider interface for compatibility with WalletStorageManager
- Add migration support for schema updates
- Performance optimizations (indexes, query optimization)

## Development

To test the storage implementation:

```typescript
import { basicExample, transactionExample, queryExample } from './storage/example'

// Run examples
await basicExample()
await transactionExample()
await queryExample()
```

## License

Open BSV License
