import { holdSentPaymentOffline } from '@/utils/offline/payerHold'
import { insertOfflineAction } from '@/storage/methods/offlineActions'
import type { StorageExpoSQLite } from '@/storage/StorageExpoSQLite'

// The DB mapper is its own tested unit (`storage/methods/offlineActions.ts`);
// here it's mocked so these tests pin exactly what `holdSentPaymentOffline`
// hands it, without duplicating its own SQL coverage.
jest.mock('@/storage/methods/offlineActions', () => ({
  insertOfflineAction: jest.fn().mockResolvedValue(undefined)
}))

const mockedInsert = insertOfflineAction as jest.Mock

const TXID = 'aa'.repeat(32)

function storageStub(
  opts: {
    sqliteDb?: unknown
    tx?: { transactionId: number; userId: number } | null
    updateTransactionStatus?: jest.Mock
  } = {}
) {
  const tx = opts.tx === undefined ? { transactionId: 42, userId: 7 } : opts.tx
  return {
    sqliteDb: 'sqliteDb' in opts ? opts.sqliteDb : {},
    findTransactions: jest.fn().mockResolvedValue(tx ? [tx] : []),
    updateTransactionStatus: opts.updateTransactionStatus ?? jest.fn().mockResolvedValue(undefined)
  }
}

describe('holdSentPaymentOffline', () => {
  beforeEach(() => {
    mockedInsert.mockClear()
    mockedInsert.mockResolvedValue(undefined)
  })

  it('resolves transactionId and userId from the transaction row, not a guess', async () => {
    const storage = storageStub({ tx: { transactionId: 99, userId: 5 } })
    await holdSentPaymentOffline({ storage: storage as unknown as StorageExpoSQLite, txid: TXID })

    expect(storage.findTransactions).toHaveBeenCalledWith({ partial: { txid: TXID }, noRawTx: true })
    expect(storage.updateTransactionStatus).toHaveBeenCalledWith('unproven', 99)
    expect(mockedInsert).toHaveBeenCalledWith(storage.sqliteDb, { userId: 5, txid: TXID, role: 'sent' })
  })

  // ORDER MATTERS: the queue-row insert is durable and the status promotion is
  // not (nothing re-drives a hold that fails partway), so a failure between
  // the two must leave the drain still able to find and post this txid.
  it('inserts the queue row before promoting the transaction status', async () => {
    const calls: string[] = []
    mockedInsert.mockImplementation(async () => {
      calls.push('insert')
    })
    const updateTransactionStatus = jest.fn().mockImplementation(async () => {
      calls.push('promote')
    })
    const storage = storageStub({ updateTransactionStatus })

    await holdSentPaymentOffline({ storage: storage as unknown as StorageExpoSQLite, txid: TXID })

    expect(calls).toEqual(['insert', 'promote'])
  })

  it('throws when the database is not open, before touching storage', async () => {
    const storage = storageStub({ sqliteDb: undefined })

    await expect(
      holdSentPaymentOffline({ storage: storage as unknown as StorageExpoSQLite, txid: TXID })
    ).rejects.toThrow(/database is not open/)
    expect(storage.findTransactions).not.toHaveBeenCalled()
    expect(storage.updateTransactionStatus).not.toHaveBeenCalled()
    expect(mockedInsert).not.toHaveBeenCalled()
  })

  it('throws when no transaction row matches the txid, rather than guessing a userId', async () => {
    const storage = storageStub({ tx: null })

    await expect(
      holdSentPaymentOffline({ storage: storage as unknown as StorageExpoSQLite, txid: TXID })
    ).rejects.toThrow(/no transaction record/)
    expect(storage.updateTransactionStatus).not.toHaveBeenCalled()
    expect(mockedInsert).not.toHaveBeenCalled()
  })

  it('lets a thrown promotion propagate, having already queued the txid', async () => {
    const updateTransactionStatus = jest.fn().mockRejectedValue(new Error('db locked'))
    const storage = storageStub({ updateTransactionStatus })

    await expect(
      holdSentPaymentOffline({ storage: storage as unknown as StorageExpoSQLite, txid: TXID })
    ).rejects.toThrow('db locked')
    // The queue row insert already ran (and, per the ordering test above,
    // ran first), so the drain can still find and post this txid even though
    // this call reports failure to its caller.
    expect(mockedInsert).toHaveBeenCalledTimes(1)
  })
})
