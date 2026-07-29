/**
 * Driver-level coverage for the release drain.
 *
 * There is no SQLite harness in this repo, so the database is a hand-rolled
 * `OfflineDb` (the shape `__tests__/payScreen.test.tsx` already fakes) and
 * `storage` is reduced to the handful of methods this module calls. What is
 * pinned here is not the SQL — it is the GRAPH the release plan is built from.
 *
 * A transaction that reaches the plan without its unbroadcast ancestors is
 * posted first, refused as an orphan, and then cascaded to `failed` along with
 * everything spending it: received money made permanently unspendable by our own
 * ordering error rather than by any verdict the network reached. `Beef.mergeBeef`
 * is not atomic — it parses the bytes into a standalone object and then merges
 * transaction by transaction into `this` — so a row whose stored `inputBEEF` is
 * unreadable is exactly how that happens.
 */
jest.mock('@/utils/net/online', () => ({ getOnline: jest.fn(async () => true) }))

// `mock`-prefixed so jest's out-of-scope guard allows the factory to close over it.
const mockPostReqs = jest.fn()
jest.mock('@bsv/wallet-toolbox-mobile/out/src/storage/methods/attemptToPostReqsToNetwork', () => ({
  attemptToPostReqsToNetwork: (...args: unknown[]) => mockPostReqs(...args)
}))

import { Beef, LockingScript, Transaction, UnlockingScript } from '@bsv/sdk'
import type { TableProvenTxReq } from '@bsv/wallet-toolbox-mobile/out/src/storage/schema/tables'
import { processOfflineActions } from '@/storage/methods/processOfflineActions'
import type { BindValue, OfflineActionRow } from '@/storage/methods/offlineActions'

/** A spendable-looking transaction. Never signed: nothing here evaluates script. */
function txSpending(sourceTXID: string): Transaction {
  const tx = new Transaction()
  tx.addInput({ sourceTXID, sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex('') })
  tx.addOutput({ satoshis: 1000, lockingScript: LockingScript.fromHex('51') })
  return tx
}

const row = (overrides: Partial<OfflineActionRow>): OfflineActionRow => ({
  offlineActionId: 1,
  created_at: '2026-07-28T00:00:00.000Z',
  updated_at: '2026-07-28T00:00:00.000Z',
  userId: 1,
  txid: 'a'.repeat(64),
  seq: 1,
  role: 'received',
  senderIdentityKey: null,
  receivedVia: null,
  status: 'queued',
  rejectedReason: null,
  poisonedByTxid: null,
  ...overrides
})

const req = (overrides: Partial<TableProvenTxReq>): TableProvenTxReq =>
  ({
    provenTxReqId: 1,
    created_at: new Date(),
    updated_at: new Date(),
    txid: 'a'.repeat(64),
    status: 'nosend',
    attempts: 0,
    notified: false,
    history: '{}',
    notify: '{"transactionIds":[11]}',
    rawTx: [],
    ...overrides
  }) as unknown as TableProvenTxReq

/** Records every UPDATE the drain issues, so a plan step is visible without SQL. */
function fakeDb(rows: OfflineActionRow[]) {
  const writes: { sql: string; params: BindValue[] }[] = []
  return {
    writes,
    getAllAsync: async () => rows,
    runAsync: async (sql: string, params: BindValue[]) => {
      writes.push({ sql, params })
    },
    getFirstAsync: async () => undefined
  }
}

function fakeStorage(args: { db: ReturnType<typeof fakeDb>; reqs: TableProvenTxReq[]; postBeef?: jest.Mock }) {
  return {
    sqliteDb: args.db,
    findProvenTxReqs: async (a: { partial: { txid?: string } }) =>
      args.reqs.filter(r => a.partial.txid === undefined || r.txid === a.partial.txid),
    findTransactions: async () => [{ transactionId: 11, status: 'unproven' }],
    updateProvenTxReq: jest.fn(),
    updateTransactionStatus: jest.fn(),
    getServices: () => ({ postBeef: args.postBeef ?? jest.fn(async () => []) })
  }
}

describe('processOfflineActions', () => {
  let log: jest.SpyInstance

  beforeEach(() => {
    mockPostReqs.mockReset()
    // devLog is on under Jest (__DEV__ is true), and this module narrates every
    // decision it makes.
    log = jest.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => log.mockRestore())

  it('never plans a transaction whose stored beef will not parse', async () => {
    // The child alone parses; its ancestry does not. Merging the raw transaction
    // before the beef would leave the child in the graph with no ancestors, and
    // nothing downstream can tell that apart from a child whose parents are
    // already mined: `releaseOrder` finds no in-set input, calls it unblocked,
    // and posts it first.
    const parent = txSpending('11'.repeat(32))
    const child = txSpending(parent.id('hex'))
    const childId = child.id('hex')

    const db = fakeDb([row({ txid: childId })])
    const postBeef = jest.fn(async () => [])
    const storage = fakeStorage({
      db,
      reqs: [req({ txid: childId, rawTx: child.toBinary(), inputBEEF: [9, 9, 9] })],
      postBeef
    })

    const r = await processOfflineActions({ storage: storage as never })

    expect(mockPostReqs).not.toHaveBeenCalled()
    expect(postBeef).not.toHaveBeenCalled()
    expect(r).toMatchObject({ sent: 0, rejected: 0 })
    // The row has to stay reportable: nothing else in the system records it, and
    // it will never make progress on its own.
    expect(r.stalledOn).toMatch(/beef/i)
    // Not even moved to 'posting' — a row that is not in the plan is not touched.
    expect(db.writes).toHaveLength(0)
  })

  it('leaves the rest of the queue releasable when one row’s beef is unreadable', async () => {
    // The unreadable row must cost only itself. Its parent has a request and a
    // row of its own, so it is still perfectly releasable.
    const parent = txSpending('11'.repeat(32))
    const child = txSpending(parent.id('hex'))
    const parentId = parent.id('hex')
    const childId = child.id('hex')

    const parentReq = req({ provenTxReqId: 1, txid: parentId, rawTx: parent.toBinary() })
    const childReq = req({ provenTxReqId: 2, txid: childId, rawTx: child.toBinary(), inputBEEF: [9, 9, 9] })
    mockPostReqs.mockImplementation(async () => {
      parentReq.status = 'unmined'
      return { details: [{ txid: parentId, status: 'success' }] }
    })

    const db = fakeDb([row({ txid: parentId, seq: 1 }), row({ offlineActionId: 2, txid: childId, seq: 2 })])
    const storage = fakeStorage({ db, reqs: [parentReq, childReq] })

    const r = await processOfflineActions({ storage: storage as never })

    expect(mockPostReqs).toHaveBeenCalledTimes(1)
    expect(r.sent).toBe(1)
    expect(r.stalledOn).toMatch(/beef/i)
  })

  it('posts a foreign ancestor out of the merged beef before the child that spends it', async () => {
    // Positive control for the fold: the ancestor exists only inside the child's
    // stored beef, so it can only reach the plan if that beef really was merged.
    const parent = txSpending('11'.repeat(32))
    const child = txSpending(parent.id('hex'))
    const parentId = parent.id('hex')
    const childId = child.id('hex')

    const ancestry = new Beef()
    ancestry.mergeRawTx(parent.toBinary())

    const childReq = req({ txid: childId, rawTx: child.toBinary(), inputBEEF: ancestry.toBinary() })
    const order: string[] = []
    mockPostReqs.mockImplementation(async () => {
      order.push('owned')
      childReq.status = 'unmined'
      return { details: [{ txid: childId, status: 'success' }] }
    })
    const postBeef = jest.fn(async () => {
      order.push('foreign')
      return [{ txidResults: [{ txid: parentId, status: 'success' }] }]
    })

    const db = fakeDb([row({ txid: childId })])
    const storage = fakeStorage({ db, reqs: [childReq], postBeef })

    const r = await processOfflineActions({ storage: storage as never })

    expect(order).toEqual(['foreign', 'owned'])
    // Only the queue row counts as sent; a foreign ancestor is logged, not counted.
    expect(r).toMatchObject({ sent: 1, rejected: 0, stopped: false })
    expect(r.stalledOn).toBeUndefined()
  })
})
