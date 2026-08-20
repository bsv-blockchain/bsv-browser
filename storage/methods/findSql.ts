/**
 * SQL construction for the storage layer's read paths.
 *
 * Extracted from StorageExpoSQLite so the generated SQL is testable without a
 * device: everything here is a pure string function.
 *
 * The reason this exists at all is `SELECT *`. Every finder used to read every
 * column, which meant `validateEntity` ran `Array.from` over each BLOB (an
 * ~8x heap multiplier under Hermes for a byte array) and `findOutputs` /
 * `findTransactions` then threw the value away when the caller had asked for
 * `noScript` / `noRawTx`. Five callers already ask for the cheap path. A vault
 * transaction's rawTx is ~960 KB, so a page of them was tens of megabytes of
 * transient heap to answer a question about integers.
 */

/**
 * Columns of every table this module can project, in schema declaration order.
 *
 * SOURCE OF TRUTH: storage/schema/createTables.ts. These lists are duplicated
 * here deliberately — SQLite has no `SELECT * EXCEPT`, so an explicit projection
 * needs the names — and __tests__/storage/findSql.test.ts parses createTables.ts
 * and fails if the two ever diverge. Add a column there and the test tells you
 * to add it here.
 */
export const TABLE_COLUMNS: Record<string, string[]> = {
  proven_txs: [
    'provenTxId',
    'created_at',
    'updated_at',
    'txid',
    'height',
    'index',
    'merklePath',
    'rawTx',
    'blockHash',
    'merkleRoot'
  ],
  proven_tx_reqs: [
    'provenTxReqId',
    'created_at',
    'updated_at',
    'txid',
    'status',
    'attempts',
    'notified',
    'history',
    'notify',
    'rawTx',
    'inputBEEF',
    'batch',
    'provenTxId',
    'wasBroadcast',
    'rebroadcastAttempts'
  ],
  transactions: [
    'transactionId',
    'created_at',
    'updated_at',
    'userId',
    'status',
    'reference',
    'isOutgoing',
    'satoshis',
    'description',
    'version',
    'lockTime',
    'txid',
    'inputBEEF',
    'rawTx',
    'provenTxId'
  ],
  outputs: [
    'outputId',
    'created_at',
    'updated_at',
    'userId',
    'transactionId',
    'basketId',
    'spendable',
    'change',
    'outputDescription',
    'vout',
    'satoshis',
    'providedBy',
    'purpose',
    'type',
    'txid',
    'senderIdentityKey',
    'derivationPrefix',
    'derivationSuffix',
    'customInstructions',
    'spentBy',
    'sequenceNumber',
    'spendingDescription',
    'scriptLength',
    'scriptOffset',
    'lockingScript'
  ],
  commissions: [
    'commissionId',
    'created_at',
    'updated_at',
    'userId',
    'transactionId',
    'satoshis',
    'keyOffset',
    'isRedeemed',
    'lockingScript'
  ]
}

/** The BLOB columns per table — the ones worth not reading. */
export const BLOB_COLUMNS: Record<string, string[]> = {
  proven_txs: ['merklePath', 'rawTx'],
  proven_tx_reqs: ['rawTx', 'inputBEEF'],
  transactions: ['inputBEEF', 'rawTx'],
  outputs: ['lockingScript'],
  commissions: ['lockingScript']
}

/**
 * Every column of `table` except `exclude`, or undefined when nothing is
 * excluded.
 *
 * Undefined means "emit SELECT *" — the pre-existing behaviour. Returning it
 * rather than the full list keeps the generated SQL identical for every caller
 * that has no reason to project, so this change cannot alter their result rows.
 */
export function columnsExcluding(table: string, exclude: string[]): string[] | undefined {
  if (exclude.length === 0) return undefined
  const all = TABLE_COLUMNS[table]
  if (!all) return undefined
  const drop = new Set(exclude)
  return all.filter(c => !drop.has(c))
}

export interface FindSqlOptions {
  table: string
  /** Pre-built WHERE clause (possibly empty) from buildWhere. */
  whereSql: string
  hasSince: boolean
  extraConditions?: string[]
  pkCol: string
  orderDescending?: boolean
  limit?: number
  offset?: number
  /** Explicit projection. Undefined emits SELECT *. */
  columns?: string[]
}

/**
 * Build a finder query.
 *
 * Clause order and the WHERE/AND choice are copied from the original inline
 * implementation and must not be reordered: whether `since` and the extra
 * conditions introduce `WHERE` or extend it with `AND` depends on what came
 * before them.
 *
 * Every identifier is quoted, which is not cosmetic — proven_txs has a column
 * literally named `index`.
 */
export function buildFindSql(opts: FindSqlOptions): string {
  const projection = opts.columns ? opts.columns.map(c => `"${c}"`).join(', ') : '*'
  let query = `SELECT ${projection} FROM "${opts.table}" ${opts.whereSql}`

  if (opts.hasSince) {
    query += `${opts.whereSql ? ' AND' : ' WHERE'} updated_at >= ?`
  }
  for (const c of opts.extraConditions ?? []) {
    query += `${opts.whereSql || opts.hasSince ? ' AND' : ' WHERE'} ${c}`
  }
  query += ` ORDER BY "${opts.pkCol}" ${opts.orderDescending ? 'DESC' : 'ASC'}`
  if (opts.limit) {
    query += ` LIMIT ${opts.limit}`
    if (opts.offset) query += ` OFFSET ${opts.offset}`
  }
  return query
}

/**
 * Byte-range read of a stored rawTx.
 *
 * `substr` on a BLOB is byte-based and 1-INDEXED, so a JS offset n is passed as
 * n + 1. Doing the range in SQL is what stops a caller that wants one output's
 * locking script from materialising a whole ~960 KB vault transaction (and then
 * an ~960 K-element JS array) to slice it.
 *
 * The proven_tx_reqs variant carries the same status filter getProvenOrRawTx
 * applies, so the two paths cannot disagree about which rows are usable.
 */
export function rangeReadSql(table: 'proven_txs' | 'proven_tx_reqs'): string {
  const usable = "AND status IN ('unsent','unmined','unconfirmed','sending','nosend','completed')"
  // The marker byte comes back alongside the range so one query can tell whether
  // slicing was even legitimate. A stored transaction envelope begins 0xfe, and
  // slicing THAT at an offset into the uncompressed transaction returns
  // plausible-looking wrong bytes with no error — which downstream becomes a
  // hashed script, a "not a UTXO" answer and a persisted spendable = false. So
  // the caller re-reads the whole row and serves the range from the envelope's
  // span list instead. Ordinary rows keep the cheap path.
  return `SELECT substr(rawTx, 1, 1) AS marker, substr(rawTx, ?, ?) AS chunk FROM "${table}" WHERE txid = ? ${
    table === 'proven_tx_reqs' ? usable : ''
  }`.trimEnd()
}

/** Whole rawTx for one txid — the envelope path's fallback. */
export function fullReadSql(table: 'proven_txs' | 'proven_tx_reqs'): string {
  const usable = "AND status IN ('unsent','unmined','unconfirmed','sending','nosend','completed')"
  return `SELECT rawTx FROM "${table}" WHERE txid = ? ${table === 'proven_tx_reqs' ? usable : ''}`.trimEnd()
}

/**
 * txid → height for every proven transaction.
 *
 * The CSV export used findProvenTxs({ partial: {} }) for this, which is an
 * unbounded SELECT * that reads and Array.from-expands every rawTx and
 * merklePath in the wallet to build a map of two small columns.
 */
export const PROVEN_HEIGHTS_SQL = 'SELECT txid, height FROM proven_txs'

/**
 * The transactions that have reserved the given outpoints, by `reference`.
 *
 * `reference` and not `txid` deliberately: this exists to heal a vault UTXO left
 * reserved by an attempt that died BEFORE signing, so the reserving row has no
 * txid at all — which is exactly why the old heal had to page every action and
 * match on its input list. `abortAction` takes a reference anyway.
 *
 * One OR-group per outpoint rather than a row-value IN, so the query works on
 * any SQLite build.
 */
export function spendingReferencesSql(pairCount: number): string {
  const groups = Array.from({ length: pairCount }, () => '("o"."txid" = ? AND "o"."vout" = ?)').join(' OR ')
  return (
    'SELECT DISTINCT "t"."reference" AS reference, "t"."status" AS status ' +
    'FROM "outputs" "o" JOIN "transactions" "t" ON "t"."transactionId" = "o"."spentBy" ' +
    `WHERE "o"."spentBy" IS NOT NULL AND (${groups})`
  )
}

/** Split a `txid.vout` or `txid:vout` outpoint into its parts, or null. */
export function splitOutpoint(outpoint: string): { txid: string; vout: number } | null {
  const m = /^([0-9a-fA-F]{64})[.:](\d+)$/.exec(outpoint.trim())
  if (!m) return null
  return { txid: m[1].toLowerCase(), vout: Number(m[2]) }
}
