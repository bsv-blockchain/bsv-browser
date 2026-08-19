/**
 * Byte-range reads of a stored rawTx, run against real SQLite.
 *
 * This is the path spec §2.2 identifies as the silent-fund-eviction route: a
 * wrong or truncated slice here is hashed by Services.hashOutputScript, the
 * chain answers "not a UTXO", and three separate writers persist
 * spendable = false with nothing in the logs. So the byte-exactness of the
 * offset arithmetic is asserted against the equivalent JS slice rather than
 * assumed — substr on a BLOB is 1-indexed, JS slice is 0-indexed, and an
 * off-by-one produces plausible bytes of the right length.
 */
import { DatabaseSync } from 'node:sqlite'
import { rangeReadSql } from '@/storage/methods/findSql'

/** 300 bytes with a recognisable pattern, so a shifted read is visible. */
const RAW = Array.from({ length: 300 }, (_, i) => (i * 7) % 256)

/** JS offset → the 1-indexed start substr wants. */
const start = (offset: number): number => offset + 1

function seeded(): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  d.exec('CREATE TABLE proven_txs (txid TEXT, rawTx BLOB NOT NULL)')
  d.exec('CREATE TABLE proven_tx_reqs (txid TEXT, status TEXT, rawTx BLOB)')
  d.prepare('INSERT INTO proven_txs (txid, rawTx) VALUES (?, ?)').run('aa', new Uint8Array(RAW))
  d.prepare('INSERT INTO proven_tx_reqs (txid, status, rawTx) VALUES (?, ?, ?)').run(
    'bb',
    'completed',
    new Uint8Array(RAW)
  )
  d.prepare('INSERT INTO proven_tx_reqs (txid, status, rawTx) VALUES (?, ?, ?)').run(
    'cc',
    'invalid',
    new Uint8Array(RAW)
  )
  return d
}

const read = (d: DatabaseSync, table: 'proven_txs' | 'proven_tx_reqs', offset: number, length: number, txid: string) =>
  d.prepare(rangeReadSql(table)).get(start(offset), length, txid) as { chunk?: Uint8Array } | undefined

describe('rangeReadSql against real SQLite', () => {
  it('reads an exact byte range from proven_txs', () => {
    const row = read(seeded(), 'proven_txs', 40, 10, 'aa')
    expect(Array.from(row!.chunk!)).toEqual(RAW.slice(40, 50))
  })

  it('matches a full-array slice at every boundary that could be off by one', () => {
    const d = seeded()
    for (const [offset, length] of [
      [0, 1],
      [0, 300],
      [1, 1],
      [149, 2],
      [250, 49],
      [299, 1]
    ]) {
      const row = read(d, 'proven_txs', offset, length, 'aa')
      expect(Array.from(row!.chunk!)).toEqual(RAW.slice(offset, offset + length))
    }
  })

  it('clamps a range that runs past the end, exactly as slice does', () => {
    const row = read(seeded(), 'proven_txs', 290, 100, 'aa')
    expect(Array.from(row!.chunk!)).toEqual(RAW.slice(290, 390))
  })

  it('reads from proven_tx_reqs for a usable status', () => {
    const row = read(seeded(), 'proven_tx_reqs', 0, 4, 'bb')
    expect(Array.from(row!.chunk!)).toEqual(RAW.slice(0, 4))
  })

  it('refuses a proven_tx_reqs row whose status is not usable', () => {
    // getProvenOrRawTx ignores such rows; a range read that returned bytes here
    // would make the two paths disagree about which rows exist.
    expect(read(seeded(), 'proven_tx_reqs', 0, 4, 'cc')).toBeUndefined()
  })

  it('returns no row for an unknown txid', () => {
    expect(read(seeded(), 'proven_txs', 0, 4, 'zz')).toBeUndefined()
  })

  it('reads only the requested bytes, not the whole blob', () => {
    // The entire point: a 1 MB row must not be materialised to answer a
    // 20-byte question.
    const d = new DatabaseSync(':memory:')
    d.exec('CREATE TABLE proven_txs (txid TEXT, rawTx BLOB NOT NULL)')
    const big = new Uint8Array(1_000_000)
    big[999_990] = 42
    d.prepare('INSERT INTO proven_txs (txid, rawTx) VALUES (?, ?)').run('big', big)

    const row = read(d, 'proven_txs', 999_990, 1, 'big')
    expect(row!.chunk!.length).toBe(1)
    expect(row!.chunk![0]).toBe(42)
  })
})
