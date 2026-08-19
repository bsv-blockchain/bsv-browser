/**
 * The CSV export's txid -> height map, verified against real SQLite.
 *
 * The point of the change is what is NOT read: the previous implementation used
 * findProvenTxs({ partial: {} }), an unbounded SELECT * that pulled every rawTx
 * and merklePath in the wallet through Array.from to build a map of two small
 * columns.
 */
import { DatabaseSync } from 'node:sqlite'
import { PROVEN_HEIGHTS_SQL } from '@/storage/methods/findSql'

function seeded(): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  d.exec('CREATE TABLE proven_txs (txid TEXT, height INTEGER, rawTx BLOB, merklePath BLOB)')
  const insert = d.prepare('INSERT INTO proven_txs (txid, height, rawTx, merklePath) VALUES (?, ?, ?, ?)')
  // A vault-sized row, so a SELECT * would be visibly expensive.
  insert.run('aa', 42, new Uint8Array(960_000), new Uint8Array(1_000))
  insert.run('bb', 43, new Uint8Array(250), new Uint8Array(1_000))
  return d
}

describe('PROVEN_HEIGHTS_SQL', () => {
  it('returns the rows the height map needs', () => {
    const rows = seeded().prepare(PROVEN_HEIGHTS_SQL).all() as { txid: string; height: number }[]
    expect(rows).toEqual([
      { txid: 'aa', height: 42 },
      { txid: 'bb', height: 43 }
    ])
  })

  it('does not return the blob columns at all', () => {
    const rows = seeded().prepare(PROVEN_HEIGHTS_SQL).all() as Record<string, unknown>[]
    expect(Object.keys(rows[0])).toEqual(['txid', 'height'])
    expect(Object.keys(rows[0])).not.toContain('rawTx')
    expect(Object.keys(rows[0])).not.toContain('merklePath')
  })
})
