/**
 * At-rest compaction against real SQLite.
 *
 * The scenario is the wedged mainnet wallet: rows written by a build without
 * the write hooks hold full ~960 KB R1-K1 blobs. Compaction must rewrite
 * exactly those, one per call, byte-recoverably, and must not loop on rows the
 * codec cannot shrink.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hash, Utils } from '@bsv/sdk'
import {
  OVERSIZE_THRESHOLD,
  compressOneAtRest,
  hasOversizeRows,
  resetCompactionSkips,
  type CompactionDb
} from '@/storage/methods/compressAtRest'
import { expandStoredScript, expandStoredTx } from '@/storage/methods/expandStored'
import { isEnvelope } from '@/services/vault/txEnvelope'
import { isCompressed } from '@/services/vault/templateCodec'
import { buildMainnetFixtureScript } from '../vault/fixtures/r1k1MainnetFixture'

const varint = (n: number): number[] =>
  n < 0xfd ? [n] : [0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]

const cat = (parts: Array<Uint8Array | number[]>): Uint8Array => {
  const chunks = parts.map(p => (p instanceof Uint8Array ? p : Uint8Array.from(p)))
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

const P2PKH = Uint8Array.from([0x76, 0xa9, 0x14, ...new Array(20).fill(1), 0x88, 0xac])

let VAULT_LOCK: Uint8Array
let VAULT_TX: Uint8Array
let VAULT_TXID: string

beforeAll(async () => {
  VAULT_LOCK = Uint8Array.from(await buildMainnetFixtureScript())
  VAULT_TX = cat([
    [1, 0, 0, 0],
    [1],
    new Uint8Array(32).fill(0xaa),
    [0, 0, 0, 0],
    varint(P2PKH.length),
    P2PKH,
    [0xff, 0xff, 0xff, 0xff],
    [1],
    [0xe0, 0x93, 4, 0, 0, 0, 0, 0],
    varint(VAULT_LOCK.length),
    VAULT_LOCK,
    [0, 0, 0, 0]
  ])
  VAULT_TXID = Utils.toHex(Hash.hash256(Array.from(VAULT_TX)).reverse())
})

/** node:sqlite adapter for the module's narrow expo-sqlite-shaped interface. */
function adapt (d: DatabaseSync): CompactionDb {
  return {
    getAllAsync: async (sql, params) => d.prepare(sql).all(...(params as Array<string | number>)),
    runAsync: async (sql, params) => d.prepare(sql).run(...(params as Array<string | number | Uint8Array>))
  }
}

function seeded (): { d: DatabaseSync; db: CompactionDb } {
  const d = new DatabaseSync(':memory:')
  d.exec('CREATE TABLE proven_txs (provenTxId INTEGER PRIMARY KEY, txid TEXT, rawTx BLOB)')
  d.exec('CREATE TABLE proven_tx_reqs (provenTxReqId INTEGER PRIMARY KEY, txid TEXT, rawTx BLOB, inputBEEF BLOB)')
  d.exec('CREATE TABLE transactions (transactionId INTEGER PRIMARY KEY, txid TEXT, rawTx BLOB, inputBEEF BLOB)')
  d.exec('CREATE TABLE outputs (outputId INTEGER PRIMARY KEY, lockingScript BLOB)')
  return { d, db: adapt(d) }
}

beforeEach(() => resetCompactionSkips())

describe('compressOneAtRest', () => {
  it('rewrites a full-size proven_txs.rawTx and the result expands byte-exactly', async () => {
    const { d, db } = seeded()
    d.prepare('INSERT INTO proven_txs (txid, rawTx) VALUES (?, ?)').run(VAULT_TXID, VAULT_TX)

    const step = await compressOneAtRest(db)
    expect(step).toMatchObject({ table: 'proven_txs', column: 'rawTx', before: VAULT_TX.length })
    expect(step!.after).toBeLessThan(2000)

    const stored = (d.prepare('SELECT rawTx FROM proven_txs').get() as any).rawTx as Uint8Array
    expect(isEnvelope(stored)).toBe(true)
    expect(await expandStoredTx(Array.from(stored))).toEqual(Array.from(VAULT_TX))
  })

  it('rewrites a full-size outputs.lockingScript', async () => {
    const { d, db } = seeded()
    d.prepare('INSERT INTO outputs (lockingScript) VALUES (?)').run(VAULT_LOCK)

    const step = await compressOneAtRest(db)
    expect(step).toMatchObject({ table: 'outputs', column: 'lockingScript' })

    const stored = (d.prepare('SELECT lockingScript FROM outputs').get() as any).lockingScript as Uint8Array
    expect(isCompressed(stored)).toBe(true)
    expect(await expandStoredScript(Array.from(stored))).toEqual(Array.from(VAULT_LOCK))
  })

  it('handles one row per call and drains across calls', async () => {
    const { db, d } = seeded()
    d.prepare('INSERT INTO proven_txs (txid, rawTx) VALUES (?, ?)').run(VAULT_TXID, VAULT_TX)
    d.prepare('INSERT INTO outputs (lockingScript) VALUES (?)').run(VAULT_LOCK)

    expect(await hasOversizeRows(db)).toBe(true)
    expect((await compressOneAtRest(db))!.table).toBe('proven_txs')
    expect((await compressOneAtRest(db))!.table).toBe('outputs')
    expect(await compressOneAtRest(db)).toBeUndefined()
    expect(await hasOversizeRows(db)).toBe(false)
  })

  it('ignores rows at or below the threshold', async () => {
    const { db, d } = seeded()
    d.prepare('INSERT INTO outputs (lockingScript) VALUES (?)').run(new Uint8Array(OVERSIZE_THRESHOLD))
    expect(await compressOneAtRest(db)).toBeUndefined()
  })

  it('skips an oversize row the codec cannot shrink instead of looping on it', async () => {
    const { db, d } = seeded()
    // Oversize but not a template instance: random-ish incompressible bytes.
    const junk = Uint8Array.from({ length: OVERSIZE_THRESHOLD + 10 }, (_, i) => (i * 31 + 7) % 256)
    d.prepare('INSERT INTO outputs (lockingScript) VALUES (?)').run(junk)
    d.prepare('INSERT INTO proven_txs (txid, rawTx) VALUES (?, ?)').run(VAULT_TXID, VAULT_TX)

    // The junk row is skipped and the real one behind it is still found.
    const step = await compressOneAtRest(db)
    expect(step!.table).toBe('proven_txs')
    expect(await compressOneAtRest(db)).toBeUndefined()

    const stored = (d.prepare('SELECT lockingScript FROM outputs').get() as any).lockingScript as Uint8Array
    expect(Array.from(stored)).toEqual(Array.from(junk))
  })

  it('leaves an already-compressed row alone (idempotence across restarts)', async () => {
    const { db, d } = seeded()
    d.prepare('INSERT INTO proven_txs (txid, rawTx) VALUES (?, ?)').run(VAULT_TXID, VAULT_TX)
    await compressOneAtRest(db)
    resetCompactionSkips()
    // The rewritten row is now far below the threshold, so nothing qualifies.
    expect(await compressOneAtRest(db)).toBeUndefined()
  })

  it('compresses a full-size transactions.inputBEEF container', async () => {
    const { db, d } = seeded()
    // A minimal BEEF V2 container wrapping the vault transaction: version
    // 0200beef, one BUMP count (0), one tx count (1), rawTx flagged 0 (no bump).
    const beef = cat([[2, 0, 0xbe, 0xef], [0], [1], VAULT_TX, [0]])
    d.prepare('INSERT INTO transactions (txid, rawTx, inputBEEF) VALUES (?, ?, ?)').run(
      VAULT_TXID,
      new Uint8Array([1, 0, 0, 0, 0]),
      beef
    )

    const step = await compressOneAtRest(db)
    expect(step).toMatchObject({ table: 'transactions', column: 'inputBEEF' })
    const stored = (d.prepare('SELECT inputBEEF FROM transactions').get() as any).inputBEEF as Uint8Array
    expect(isEnvelope(stored)).toBe(true)
    expect(await expandStoredTx(Array.from(stored))).toEqual(Array.from(beef))
  })
})
