/**
 * Example usage of StorageExpoSQLite
 *
 * This file demonstrates how to use the storage implementation
 * for BSV wallet data on mobile platforms.
 */

import { StorageExpoSQLite } from './index'
import type { TableUser, TableTransaction, TableOutput } from './index'

/**
 * Basic example: Create storage, add a user, and create a transaction
 */
export async function basicExample() {
  // Initialize storage
  const storage = new StorageExpoSQLite({ chain: 'main' })

  // Migrate/initialize the database
  await storage.migrate('my-bsv-wallet', 'storage-identity-key-123')

  // Check if available
  if (!storage.isAvailable()) {
    throw new Error('Storage not available')
  }

  // Get settings
  const settings = await storage.getSettings()
  console.log('Storage settings:', settings)

  // Create or find a user
  const { user, isNew } = await storage.findOrInsertUser('033d5c7f4e8ed5c5b4e9f3d2a1b0c9f8e7d6c5b4a3928170605040302010abcd')
  console.log('User:', user, 'Is new:', isNew)

  // Create an output basket for the user
  const basket = await storage.findOrInsertOutputBasket(user.userId!, 'default')
  console.log('Output basket:', basket)

  // Create a transaction
  const txId = await storage.insertTransaction({
    userId: user.userId!,
    status: 'completed',
    reference: 'tx-ref-' + Date.now(),
    satoshis: 100000,
    description: 'Test transaction',
    isOutgoing: false,
    version: 1,
    lockTime: 0
  })
  console.log('Created transaction ID:', txId)

  // Find the transaction
  const transactions = await storage.findTransactions({
    partial: { transactionId: txId }
  })
  console.log('Found transaction:', transactions[0])

  // Create an output for the transaction
  const outputId = await storage.insertOutput({
    userId: user.userId!,
    transactionId: txId,
    vout: 0,
    satoshis: 100000,
    basketId: basket.basketId!,
    spendable: true,
    change: false,
    outpoint: `${transactions[0].reference}:0`,
    providedBy: 'you'
  })
  console.log('Created output ID:', outputId)

  // Find outputs for the user
  const outputs = await storage.findOutputs({
    partial: { userId: user.userId! }
  })
  console.log('User outputs:', outputs)

  // Update transaction status
  await storage.updateTransaction(txId, { status: 'unproven' })
  console.log('Updated transaction status')

  // Count outputs
  const outputCount = await storage.countOutputs({
    partial: { userId: user.userId!, spendable: true }
  })
  console.log('Spendable outputs count:', outputCount)

  return {
    user,
    transaction: transactions[0],
    outputs,
    outputCount
  }
}

/**
 * Transaction example: Using transactions for atomic operations
 */
export async function transactionExample() {
  const storage = new StorageExpoSQLite({ chain: 'main' })
  await storage.migrate('my-bsv-wallet', 'storage-identity-key-456')

  // Create a user
  const { user } = await storage.findOrInsertUser('022d5c7f4e8ed5c5b4e9f3d2a1b0c9f8e7d6c5b4a3928170605040302010abef')
  const basket = await storage.findOrInsertOutputBasket(user.userId!, 'default')

  // Use transaction to ensure atomic operations
  await storage.transaction(async trx => {
    // Create transaction
    const txId = await storage.insertTransaction(
      {
        userId: user.userId!,
        status: 'completed',
        reference: 'atomic-tx-' + Date.now(),
        satoshis: 50000
      },
      trx
    )

    // Create output
    await storage.insertOutput(
      {
        userId: user.userId!,
        transactionId: txId,
        vout: 0,
        satoshis: 50000,
        basketId: basket.basketId!,
        outpoint: `atomic-tx-${Date.now()}:0`,
        providedBy: 'you'
      },
      trx
    )

    // If any operation fails, the entire transaction will be rolled back
    console.log('Transaction and output created atomically')
  })
}

/**
 * Query example: Finding and filtering data
 */
export async function queryExample() {
  const storage = new StorageExpoSQLite({ chain: 'main' })
  await storage.migrate('my-bsv-wallet', 'storage-identity-key-789')

  const { user } = await storage.findOrInsertUser('011d5c7f4e8ed5c5b4e9f3d2a1b0c9f8e7d6c5b4a3928170605040302010ab12')

  // Find transactions with filters
  const completedTxs = await storage.findTransactions({
    partial: { userId: user.userId!, status: 'completed' },
    orderDescending: true,
    limit: 10
  })
  console.log('Completed transactions:', completedTxs.length)

  // Find outputs with pagination
  const outputs = await storage.findOutputs({
    partial: { userId: user.userId!, spendable: true },
    limit: 20,
    offset: 0
  })
  console.log('Paginated outputs:', outputs.length)

  // Count records
  const totalOutputs = await storage.countOutputs({
    partial: { userId: user.userId! }
  })
  console.log('Total outputs:', totalOutputs)

  // Find by ID
  if (outputs.length > 0) {
    const output = await storage.findOutputById(outputs[0].outputId!)
    console.log('Found output by ID:', output)
  }
}

/**
 * Labels and tags example
 */
export async function labelsAndTagsExample() {
  const storage = new StorageExpoSQLite({ chain: 'main' })
  await storage.migrate('my-bsv-wallet', 'storage-identity-key-abc')

  const { user } = await storage.findOrInsertUser('044d5c7f4e8ed5c5b4e9f3d2a1b0c9f8e7d6c5b4a3928170605040302010cd34')
  const basket = await storage.findOrInsertOutputBasket(user.userId!, 'default')

  // Create transaction
  const txId = await storage.insertTransaction({
    userId: user.userId!,
    status: 'completed',
    reference: 'labeled-tx-' + Date.now(),
    satoshis: 75000
  })

  // Create label
  const label = await storage.findOrInsertTxLabel(user.userId!, 'payment')

  // Map label to transaction
  await storage.insertTxLabelMap({
    txLabelId: label.txLabelId!,
    transactionId: txId
  })

  // Create output
  const outputId = await storage.insertOutput({
    userId: user.userId!,
    transactionId: txId,
    vout: 0,
    satoshis: 75000,
    basketId: basket.basketId!,
    outpoint: `labeled-tx-${Date.now()}:0`,
    providedBy: 'you'
  })

  // Create tag for output
  const tag = await storage.findOrInsertOutputTag(user.userId!, 'income')

  // Map tag to output
  await storage.insertOutputTagMap({
    outputTagId: tag.outputTagId!,
    outputId
  })

  console.log('Created labeled transaction and tagged output')
}

/**
 * Cleanup example: Drop all data
 */
export async function cleanupExample() {
  const storage = new StorageExpoSQLite({ chain: 'main' })
  await storage.migrate('my-bsv-wallet', 'storage-identity-key-xyz')

  // Drop all data (useful for testing)
  await storage.dropAllData()
  console.log('All data dropped')

  // Destroy storage connection
  await storage.destroy()
  console.log('Storage connection closed')
}
