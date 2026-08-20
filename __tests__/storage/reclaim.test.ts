/**
 * The reclaim predicate, run against real SQLite.
 *
 * Every assertion checks the surviving rows by txid rather than only counting
 * them, so a predicate that is too BROAD fails loudly. Reclaiming more than
 * intended is the failure mode that matters here — the column being nulled is
 * not part of the spend path, but a predicate that drifted onto rows still in
 * flight would be.
 */
import { DatabaseSync } from 'node:sqlite'
import {
  RECLAIM_CANDIDATES_SQL,
  RECLAIM_EXCLUDED_SQL,
  RECLAIM_INPUT_BEEF_SQL,
  RECLAIM_SIZES_SQL
} from '@/storage/methods/reclaim'

const TIP = 1000
const CUTOFF = '2027-01-01'
const NOW = '2026-08-19T00:00:00Z'

function db(): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  d.exec(`CREATE TABLE transactions (transactionId INTEGER PRIMARY KEY, updated_at TEXT, status TEXT,
    provenTxId INTEGER, txid TEXT, inputBEEF BLOB, rawTx BLOB)`)
  d.exec(`CREATE TABLE proven_txs (provenTxId INTEGER PRIMARY KEY, txid TEXT, height INTEGER,
    rawTx BLOB, merklePath BLOB)`)
  d.exec(`CREATE TABLE proven_tx_reqs (provenTxReqId INTEGER PRIMARY KEY, txid TEXT, status TEXT,
    rawTx BLOB, inputBEEF BLOB)`)
  d.exec('CREATE TABLE offline_actions (id INTEGER PRIMARY KEY, txid TEXT, status TEXT)')
  d.exec('CREATE TABLE outputs (outputId INTEGER PRIMARY KEY, lockingScript BLOB)')
  return d
}

/** A settled transaction with a reclaimable inputBEEF. */
function settled(d: DatabaseSync, id: number, txid: string, beefBytes = 5000, height = 100): void {
  d.prepare('INSERT INTO proven_txs (provenTxId, txid, height) VALUES (?,?,?)').run(id, txid, height)
  d.prepare(
    `INSERT INTO transactions (transactionId, updated_at, status, provenTxId, txid, inputBEEF)
     VALUES (?,?,?,?,?,?)`
  ).run(id, '2026-01-01', 'completed', id, txid, new Uint8Array(beefBytes))
}

const candidates = (d: DatabaseSync) =>
  d.prepare(RECLAIM_CANDIDATES_SQL).all(TIP, CUTOFF) as { txid: string; bytes: number }[]

const survivors = (d: DatabaseSync) =>
  (d.prepare('SELECT txid FROM transactions WHERE inputBEEF IS NOT NULL').all() as { txid: string }[]).map(
    r => r.txid
  )

describe('reclaim predicate', () => {
  it('admits a settled, deeply-proven transaction', () => {
    const d = db()
    settled(d, 1, 'aa')
    expect(candidates(d)).toEqual([{ txid: 'aa', transactionId: 1, bytes: 5000 }])
  })

  it('holds back a transaction whose broadcast is still in flight', () => {
    const d = db()
    settled(d, 1, 'aa')
    settled(d, 2, 'bb')
    d.prepare('INSERT INTO proven_tx_reqs (provenTxReqId, txid, status) VALUES (?,?,?)').run(1, 'bb', 'sending')

    expect(candidates(d).map(c => c.txid)).toEqual(['aa'])
  })

  it('holds back a transaction with a queued offline action', () => {
    const d = db()
    settled(d, 1, 'aa')
    settled(d, 2, 'bb')
    d.prepare('INSERT INTO offline_actions (id, txid, status) VALUES (?,?,?)').run(1, 'bb', 'queued')

    expect(candidates(d).map(c => c.txid)).toEqual(['aa'])
  })

  it('holds back anything inside the 100-confirmation reorg horizon', () => {
    // If the proven block is orphaned, the BEEF path falls back to rebuilding
    // from ancestors — so the bytes must still be there.
    const d = db()
    settled(d, 1, 'aa', 5000, 100)
    settled(d, 2, 'bb', 5000, TIP - 50)

    expect(candidates(d).map(c => c.txid)).toEqual(['aa'])
  })

  it('holds back a transaction that is not completed, and one that is not proven', () => {
    const d = db()
    d.prepare(
      `INSERT INTO transactions (transactionId, updated_at, status, provenTxId, txid, inputBEEF)
       VALUES (?,?,?,?,?,?)`
    ).run(1, '2026-01-01', 'sending', null, 'aa', new Uint8Array(5000))
    d.prepare(
      `INSERT INTO transactions (transactionId, updated_at, status, provenTxId, txid, inputBEEF)
       VALUES (?,?,?,?,?,?)`
    ).run(2, '2026-01-01', 'completed', null, 'bb', new Uint8Array(5000))

    expect(candidates(d)).toEqual([])
  })

  it('holds back a transaction updated after the cutoff', () => {
    const d = db()
    settled(d, 1, 'aa')
    d.prepare('UPDATE transactions SET updated_at = ? WHERE txid = ?').run('2028-01-01', 'aa')
    expect(candidates(d)).toEqual([])
  })
})

describe('RECLAIM_INPUT_BEEF_SQL', () => {
  it('nulls exactly the admitted rows and leaves the rest intact', () => {
    const d = db()
    settled(d, 1, 'aa')
    settled(d, 2, 'bb')
    settled(d, 3, 'cc')
    d.prepare('INSERT INTO proven_tx_reqs (provenTxReqId, txid, status) VALUES (?,?,?)').run(1, 'bb', 'unmined')
    d.prepare('INSERT INTO offline_actions (id, txid, status) VALUES (?,?,?)').run(1, 'cc', 'posting')

    const info = d.prepare(RECLAIM_INPUT_BEEF_SQL).run(NOW, TIP, CUTOFF)
    expect(Number(info.changes)).toBe(1)
    expect(survivors(d).sort()).toEqual(['bb', 'cc'])
  })

  it('stamps updated_at so the backup cursor sees the change', () => {
    const d = db()
    settled(d, 1, 'aa')
    d.prepare(RECLAIM_INPUT_BEEF_SQL).run(NOW, TIP, CUTOFF)
    const row = d.prepare('SELECT updated_at FROM transactions WHERE txid = ?').get('aa') as { updated_at: string }
    expect(row.updated_at).toBe(NOW)
  })

  it('is a no-op on a database with nothing reclaimable', () => {
    const d = db()
    const info = d.prepare(RECLAIM_INPUT_BEEF_SQL).run(NOW, TIP, CUTOFF)
    expect(Number(info.changes)).toBe(0)
  })

  it('is idempotent — a second pass finds nothing', () => {
    const d = db()
    settled(d, 1, 'aa')
    d.prepare(RECLAIM_INPUT_BEEF_SQL).run(NOW, TIP, CUTOFF)
    const second = d.prepare(RECLAIM_INPUT_BEEF_SQL).run(NOW, TIP, CUTOFF)
    expect(Number(second.changes)).toBe(0)
  })

  it('never touches rawTx', () => {
    // The column that IS part of the spend path. Nulling it is spec item E3,
    // deliberately not implemented.
    const d = db()
    settled(d, 1, 'aa')
    d.prepare('UPDATE transactions SET rawTx = ? WHERE txid = ?').run(new Uint8Array(999), 'aa')
    d.prepare(RECLAIM_INPUT_BEEF_SQL).run(NOW, TIP, CUTOFF)
    const row = d.prepare('SELECT LENGTH(rawTx) AS n FROM transactions WHERE txid = ?').get('aa') as { n: number }
    expect(row.n).toBe(999)
  })
})

describe('RECLAIM_EXCLUDED_SQL', () => {
  it('reports why each held-back row was refused', () => {
    const d = db()
    settled(d, 1, 'aa')
    settled(d, 2, 'bb')
    d.prepare('INSERT INTO proven_tx_reqs (provenTxReqId, txid, status) VALUES (?,?,?)').run(1, 'bb', 'sending')
    settled(d, 3, 'cc', 5000, TIP - 10)

    const rows = d.prepare(RECLAIM_EXCLUDED_SQL).all(TIP, TIP, CUTOFF) as {
      reason: string
      rows: number
      bytes: number
    }[]
    const byReason = Object.fromEntries(rows.map(r => [r.reason, r.rows]))
    expect(byReason['broadcast still in flight']).toBe(1)
    expect(byReason['inside the reorg horizon']).toBe(1)
    expect(byReason['too recent']).toBeUndefined()
  })
})

describe('RECLAIM_SIZES_SQL', () => {
  it('sums blob bytes per table without loading them', () => {
    const d = db()
    d.prepare('INSERT INTO proven_txs (provenTxId, txid, height, rawTx, merklePath) VALUES (?,?,?,?,?)').run(
      1,
      'aa',
      1,
      new Uint8Array(960_000),
      new Uint8Array(1000)
    )
    d.prepare('INSERT INTO outputs (outputId, lockingScript) VALUES (?,?)').run(1, new Uint8Array(959_632))

    const rows = d.prepare(RECLAIM_SIZES_SQL).all() as { table: string; rows: number; blobBytes: number }[]
    const by = Object.fromEntries(rows.map(r => [r.table, r]))
    expect(by.proven_txs.blobBytes).toBe(961_000)
    expect(by.outputs.blobBytes).toBe(959_632)
    // Empty tables report zero rather than null, so the report can add them up.
    expect(by.transactions.blobBytes).toBe(0)
    expect(by.proven_tx_reqs.rows).toBe(0)
  })
})
