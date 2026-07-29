import {
  applyOutcome,
  outcomeFromReqStatus,
  outcomeOfForeignPost,
  outcomeOfOwnedPost,
  planRelease,
  type PostedResult
} from '@/utils/offline/plan'
import type { OrderableTx } from '@/utils/offline/order'
import type { OfflineActionRow } from '@/storage/methods/offlineActions'

const tx = (txid: string, inputTxids: string[] = [], extra: Partial<OrderableTx> = {}): OrderableTx => ({
  txid,
  hasProof: false,
  isTxidOnly: false,
  inputTxids,
  ...extra
})

const row = (txid: string, over: Partial<OfflineActionRow> = {}): OfflineActionRow => ({
  offlineActionId: 1,
  created_at: '2026-07-28T00:00:00.000Z',
  updated_at: '2026-07-28T00:00:00.000Z',
  userId: 1,
  txid,
  seq: 1,
  role: 'received',
  senderIdentityKey: '02'.padEnd(66, 'c'),
  receivedVia: 'awdl',
  status: 'queued',
  rejectedReason: null,
  poisonedByTxid: null,
  ...over
})

describe('planRelease', () => {
  it('orders parents first and marks which transactions we own', () => {
    const plan = planRelease({ rows: [row('B')], txs: [tx('B', ['A']), tx('A')] })
    expect(plan).toEqual([
      { txid: 'A', owned: false },
      { txid: 'B', owned: true }
    ])
  })

  it('includes a foreign ancestor that was never in the queue', () => {
    // C paid B underground, B pays us: C's transaction is in our BEEF but was
    // never our queue row, and it must still go out first.
    const plan = planRelease({ rows: [row('A')], txs: [tx('A', ['B']), tx('B', ['C']), tx('C')] })
    expect(plan.map(p => p.txid)).toEqual(['C', 'B', 'A'])
    expect(plan.map(p => p.owned)).toEqual([false, false, true])
  })

  it('skips already-sent rows', () => {
    const plan = planRelease({ rows: [row('A', { status: 'sent' })], txs: [tx('A')] })
    expect(plan.map(p => p.txid)).toEqual(['A'])
    expect(plan[0].owned).toBe(false)
  })

  it('excludes mined transactions', () => {
    const plan = planRelease({ rows: [row('B')], txs: [tx('A', [], { hasProof: true }), tx('B', ['A'])] })
    expect(plan.map(p => p.txid)).toEqual(['B'])
  })
})

describe('applyOutcome', () => {
  it('marks a success sent and keeps going', () => {
    const r = applyOutcome({ txid: 'A', outcome: 'success', txs: [tx('A')], rows: [row('A')] })
    expect(r).toEqual({ stop: false, sent: ['A'], rejected: [] })
  })

  it('stops the run on a service error without rejecting anything', () => {
    const r = applyOutcome({ txid: 'A', outcome: 'serviceError', txs: [tx('A')], rows: [row('A')] })
    expect(r.stop).toBe(true)
    expect(r.sent).toEqual([])
    expect(r.rejected).toEqual([])
  })

  it('rejects the transaction and every descendant on invalidTx', () => {
    const txs = [tx('A'), tx('B', ['A']), tx('C', ['B'])]
    const r = applyOutcome({ txid: 'A', outcome: 'invalidTx', txs, rows: [row('A'), row('B'), row('C')] })
    expect(r.stop).toBe(true)
    expect(r.rejected.map(x => x.txid).sort()).toEqual(['A', 'B', 'C'])
    expect(r.rejected.every(x => x.poisonedByTxid === 'A')).toBe(true)
  })

  it('names the reason on a double spend', () => {
    const r = applyOutcome({ txid: 'A', outcome: 'doubleSpend', txs: [tx('A')], rows: [row('A')] })
    expect(r.rejected[0].reason).toMatch(/double spend/i)
  })

  it('rejects descendants that have no queue row of their own', () => {
    const txs = [tx('A'), tx('B', ['A'])]
    const r = applyOutcome({ txid: 'A', outcome: 'invalidTx', txs, rows: [row('A')] })
    expect(r.rejected.map(x => x.txid).sort()).toEqual(['A', 'B'])
  })

  it('rejects a descendant before the transaction it spends', () => {
    // Failing a transaction releases its inputs back to spendable
    // (StorageProvider.js:365-373). Applied parent-first, the child's release
    // hands the poisoned outputs back as spendable; child-first, the parent's
    // own failure has the last word and they stay unspendable.
    const txs = [tx('C', ['B']), tx('A'), tx('B', ['A'])]
    const r = applyOutcome({ txid: 'A', outcome: 'invalidTx', txs, rows: [] })
    expect(r.rejected.map(x => x.txid)).toEqual(['C', 'B', 'A'])
  })

  it('orders the cascade topologically, not by how far each descendant looked', () => {
    // Both B and C spend A directly, and C also spends B. C is one hop from A by
    // discovery but must still be failed before B.
    const txs = [tx('A'), tx('C', ['A', 'B']), tx('B', ['A'])]
    const r = applyOutcome({ txid: 'A', outcome: 'invalidTx', txs, rows: [] })
    expect(r.rejected.map(x => x.txid)).toEqual(['C', 'B', 'A'])
  })
})

describe('outcomeFromReqStatus', () => {
  it('reads an already-broadcast status as delivered', () => {
    for (const status of ['unmined', 'callback', 'unconfirmed', 'completed']) {
      expect(outcomeFromReqStatus(status)).toBe('success')
    }
  })

  it('has no verdict for a request that still needs posting', () => {
    for (const status of ['nosend', 'unsent', 'sending', 'unprocessed', 'unknown', undefined]) {
      expect(outcomeFromReqStatus(status)).toBeUndefined()
    }
  })

  it('reads a recorded failure', () => {
    expect(outcomeFromReqStatus('doubleSpend')).toBe('doubleSpend')
    expect(outcomeFromReqStatus('invalid')).toBe('invalidTx')
  })
})

describe('outcomeOfOwnedPost', () => {
  it('refuses to call a post delivered on the reported status alone', () => {
    // A hold reports 'success' meaning "accepted for delivery", not "the network
    // has it". Storage is the only witness that it actually went out.
    expect(outcomeOfOwnedPost({ detailStatus: 'success', reqStatus: 'nosend' })).toBe('serviceError')
  })

  it('confirms delivery from the persisted request status', () => {
    expect(outcomeOfOwnedPost({ detailStatus: 'success', reqStatus: 'unmined' })).toBe('success')
  })

  it('confirms delivery when the post reported no verdict at all', () => {
    // A request already beyond broadcast is skipped by
    // updateReqsFromAggregateResults, which leaves its detail at 'unknown'.
    expect(outcomeOfOwnedPost({ detailStatus: 'unknown', reqStatus: 'unmined' })).toBe('success')
  })

  it('reports a double spend from either witness', () => {
    expect(outcomeOfOwnedPost({ detailStatus: 'doubleSpend', reqStatus: 'sending' })).toBe('doubleSpend')
    expect(outcomeOfOwnedPost({ detailStatus: 'unknown', reqStatus: 'doubleSpend' })).toBe('doubleSpend')
  })

  it('reports an invalid transaction from either witness', () => {
    expect(outcomeOfOwnedPost({ detailStatus: 'invalidTx', reqStatus: 'sending' })).toBe('invalidTx')
    expect(outcomeOfOwnedPost({ detailStatus: 'invalid', reqStatus: 'sending' })).toBe('invalidTx')
    expect(outcomeOfOwnedPost({ detailStatus: 'unknown', reqStatus: 'invalid' })).toBe('invalidTx')
  })

  it('falls back to a service error, which never rejects anything', () => {
    expect(outcomeOfOwnedPost({ detailStatus: 'serviceError', reqStatus: 'sending' })).toBe('serviceError')
    expect(outcomeOfOwnedPost({})).toBe('serviceError')
  })
})

describe('outcomeOfForeignPost', () => {
  const posted = (...txidResults: PostedResult['txidResults']): PostedResult[] => [{ txidResults }]

  it('accepts a success', () => {
    expect(outcomeOfForeignPost({ txid: 'A', results: posted({ txid: 'A', status: 'success' }) })).toBe('success')
  })

  it('treats an already-known transaction as delivered', () => {
    const results = posted({ txid: 'A', status: 'error', alreadyKnown: true })
    expect(outcomeOfForeignPost({ txid: 'A', results })).toBe('success')
  })

  it('lets a double spend beat a success, as the toolbox aggregate does', () => {
    const results: PostedResult[] = [
      { txidResults: [{ txid: 'A', status: 'error', doubleSpend: true }] },
      { txidResults: [{ txid: 'A', status: 'success' }] }
    ]
    expect(outcomeOfForeignPost({ txid: 'A', results })).toBe('doubleSpend')
  })

  it('never rejects a foreign ancestor on a plain error', () => {
    // Its BEEF was already script- and SPV-verified by internalizeAction, so a
    // bare error is far more likely to be our own incomplete BEEF than a verdict.
    const results = posted({ txid: 'A', status: 'error' })
    expect(outcomeOfForeignPost({ txid: 'A', results })).toBe('serviceError')
  })

  it('reports a service error when no service mentioned the txid', () => {
    const results = posted({ txid: 'other', status: 'success' })
    expect(outcomeOfForeignPost({ txid: 'A', results })).toBe('serviceError')
    expect(outcomeOfForeignPost({ txid: 'A', results: [] })).toBe('serviceError')
  })
})
