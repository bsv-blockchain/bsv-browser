/**
 * One-row-at-a-time compaction of full-size R1-K1 blobs already at rest.
 *
 * The write hooks keep NEW rows compressed, but a database written by an older
 * build can already hold the full ~960 KB forms — the first mainnet vault
 * wallet holds three: proven_txs.rawTx (960,075 B), outputs.lockingScript
 * (959,632 B) and the proven_tx_reqs row behind them. The standing rule is
 * that those bytes never sit at full size ANYWHERE in the database, so this
 * module rewrites them in place through the exact same codec the hooks use.
 *
 * WHY ONE ROW PER CALL. Compressing a 960 KB transaction is synchronous CPU
 * work (~200 ms in CI, more on a phone under Hermes). Monitor tasks run
 * back-to-back without yielding, and the project's standing rule is that the
 * chrome is never JS-blocked — so the monitor task calls this once per pass
 * and the backlog drains across passes, exactly like TaskBackupPush.
 *
 * WHY updated_at IS LEFT ALONE. The backup delta protocol keys on updated_at.
 * A row this touches was either never pushed (a full-size row cannot fit a
 * blob, which is how the wedge happened) — in which case it is still ahead of
 * the cursor and will be pushed compressed regardless — or was pushed small
 * and is untouched here (the threshold). Bumping updated_at would re-push
 * rows for a rewrite that changes no wallet-visible content.
 *
 * WHY FAILURES ARE SKIPPED IN MEMORY, NOT PERSISTED. A blob over the
 * threshold that the codec does not recognise (not a genuine R1-K1 template)
 * compresses to itself and would be re-selected forever — a hot loop. Such
 * rows are remembered per process and retried on the next launch, which is
 * free and means a codec that LEARNS a new template version later (the
 * registry is append-only) picks them up without any migration.
 */
import {
  compressOutputScript,
  compressStoredBeef,
  compressStoredTx
} from './expandStored'

/**
 * Anything smaller can never contain a full R1-K1 region (the smallest is the
 * ~959 KB scriptCode), and staying far above real-world script sizes keeps the
 * LENGTH() probe from ever selecting ordinary rows. LENGTH() on a BLOB reads
 * the size from the record header, so the probe does not materialise blobs.
 */
export const OVERSIZE_THRESHOLD = 65_536

/** The narrow slice of expo-sqlite's async API this module needs; tests supply
 * a node:sqlite adapter. */
export interface CompactionDb {
  getAllAsync: (sql: string, params: Array<string | number>) => Promise<unknown[]>
  runAsync: (sql: string, params: Array<string | number | Uint8Array>) => Promise<unknown>
}

export interface CompactionStep {
  table: 'proven_txs' | 'proven_tx_reqs' | 'transactions' | 'outputs'
  column: 'rawTx' | 'inputBEEF' | 'lockingScript'
  id: number
  before: number
  after: number
}

interface Candidate {
  table: CompactionStep['table']
  column: CompactionStep['column']
  idColumn: string
  id: number
  txid?: string
  bytes: Uint8Array
}

/** Rows tried this process that did not shrink; keyed table:column:id. */
const skipped = new Set<string>()

/** Test seam; also lets a fresh sign-in retry rows a previous key skipped. */
export function resetCompactionSkips (): void {
  skipped.clear()
}

const keyOf = (table: string, column: string, id: number): string => `${table}:${column}:${id}`

/**
 * The per-table probes, in the order that matters: proven_txs is the row that
 * wedges backups, so it goes first. Each probe returns a handful of candidates
 * so an unshrinkable row cannot mask a shrinkable one behind it.
 */
const PROBES: ReadonlyArray<{
  table: CandidateTable
  column: CompactionStep['column']
  idColumn: string
  sql: string
}> = [
  {
    table: 'proven_txs',
    column: 'rawTx',
    idColumn: 'provenTxId',
    sql: 'SELECT provenTxId AS id, txid, rawTx AS bytes FROM proven_txs WHERE LENGTH(rawTx) > ? LIMIT 5'
  },
  {
    table: 'proven_tx_reqs',
    column: 'rawTx',
    idColumn: 'provenTxReqId',
    sql: 'SELECT provenTxReqId AS id, txid, rawTx AS bytes FROM proven_tx_reqs WHERE LENGTH(rawTx) > ? LIMIT 5'
  },
  {
    table: 'proven_tx_reqs',
    column: 'inputBEEF',
    idColumn: 'provenTxReqId',
    sql: 'SELECT provenTxReqId AS id, txid, inputBEEF AS bytes FROM proven_tx_reqs WHERE LENGTH(inputBEEF) > ? LIMIT 5'
  },
  {
    table: 'transactions',
    column: 'rawTx',
    idColumn: 'transactionId',
    sql: 'SELECT transactionId AS id, txid, rawTx AS bytes FROM transactions WHERE LENGTH(rawTx) > ? LIMIT 5'
  },
  {
    table: 'transactions',
    column: 'inputBEEF',
    idColumn: 'transactionId',
    sql: 'SELECT transactionId AS id, txid, inputBEEF AS bytes FROM transactions WHERE LENGTH(inputBEEF) > ? LIMIT 5'
  },
  {
    table: 'outputs',
    column: 'lockingScript',
    idColumn: 'outputId',
    sql: 'SELECT outputId AS id, lockingScript AS bytes FROM outputs WHERE LENGTH(lockingScript) > ? LIMIT 5'
  }
]

type CandidateTable = CompactionStep['table']

async function nextCandidate (db: CompactionDb): Promise<Candidate | undefined> {
  for (const probe of PROBES) {
    const rows = (await db.getAllAsync(probe.sql, [OVERSIZE_THRESHOLD])) as Array<{
      id: number
      txid?: string
      bytes: Uint8Array
    }>
    for (const row of rows) {
      if (skipped.has(keyOf(probe.table, probe.column, row.id))) continue
      return { table: probe.table, column: probe.column, idColumn: probe.idColumn, id: row.id, txid: row.txid, bytes: row.bytes }
    }
  }
  return undefined
}

/** True when nothing over the threshold remains unskipped — the task's idle signal. */
export async function hasOversizeRows (db: CompactionDb): Promise<boolean> {
  return (await nextCandidate(db)) !== undefined
}

/**
 * Compress at most one oversize row in place. Returns what happened, or
 * undefined when nothing (further) qualifies. Never throws for a row the codec
 * cannot help: the row is skipped for this process and the next one is tried
 * on the following call.
 */
export async function compressOneAtRest (db: CompactionDb): Promise<CompactionStep | undefined> {
  const c = await nextCandidate(db)
  if (!c) return undefined

  const before = c.bytes.length
  let compressed: Uint8Array | number[] | undefined
  try {
    if (c.column === 'lockingScript') {
      compressed = await compressOutputScript(c.bytes)
    } else if (c.column === 'inputBEEF') {
      compressed = await compressStoredBeef(c.bytes)
    } else {
      compressed = await compressStoredTx(c.bytes, c.txid)
    }
  } catch (e) {
    console.warn(
      `[storage] at-rest compaction failed for ${c.table}.${c.column} id=${c.id}: ${
        (e as Error)?.message ?? 'unknown'
      }`
    )
    compressed = c.bytes
  }

  const out = compressed instanceof Uint8Array ? compressed : Uint8Array.from(compressed ?? [])
  if (out.length >= before) {
    // Not a recognisable R1-K1 carrier at today's registry. Leave it, remember
    // it, and let the next call move on to the row behind it.
    skipped.add(keyOf(c.table, c.column, c.id))
    return await compressOneAtRest(db)
  }

  await db.runAsync(`UPDATE "${c.table}" SET ${c.column} = ? WHERE ${c.idColumn} = ?`, [out, c.id])
  return { table: c.table, column: c.column, id: c.id, before, after: out.length }
}
