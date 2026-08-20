/**
 * Measuring, and then reclaiming, wallet database space.
 *
 * MEASURE FIRST. The destructive half of this file touches exactly one column,
 * and the report exists so that decision can be made from real device numbers
 * rather than from a guess. The prediction on record is that nearly all
 * reclaimable space is `transactions.inputBEEF` plus duplicated vault blobs — in
 * which case nulling that one column plus the script codec is the whole feature.
 *
 * WHY ROW DELETION IS NOT HERE. "Drop the oldest transactions whose outputs are
 * all spent" fails on three independent grounds:
 *
 *  1. Spent-ness is REVERSIBLE. A spend reserves its inputs by setting
 *     spendable = 0; if it later fails, releaseInputsAllocatedToFailedTransaction
 *     restores them. Prune in that window and the coin is permanently
 *     unspendable, because change spends run ignoreServices: true and there is
 *     no network recovery.
 *  2. Proven-ness does not close the ancestry requirement, which is transitive
 *     through the outputs.spentBy graph.
 *  3. The backup delta protocol carries no deletes, so pruning is invisible
 *     within a generation — testing shows the backup unaffected — and then the
 *     next rotation writes a full snapshot of the PRUNED database. The loss
 *     surfaces weeks later, on another device, during a recovery.
 *
 * WHY inputBEEF IS THE SAFE TARGET. Nothing reads it for BEEF: getProvenOrRawTx
 * consults proven_txs and then proven_tx_reqs, never transactions.inputBEEF, and
 * processAction already declares the intent to clear it right after signing. Its
 * only reader is processAction's own pre-signing validation of a still-unsigned
 * row. That is why the predicate below carries NO spent-ness term at all — the
 * dangerous clauses are unnecessary precisely because this column is not part of
 * the spend path.
 */

/** Blob byte totals per table, computed in SQL so nothing is materialised. */
export const RECLAIM_SIZES_SQL = `
  SELECT 'proven_txs' AS "table", COUNT(*) AS rows,
         COALESCE(SUM(LENGTH(rawTx)), 0) + COALESCE(SUM(LENGTH(merklePath)), 0) AS blobBytes
  FROM proven_txs
  UNION ALL
  SELECT 'proven_tx_reqs', COUNT(*),
         COALESCE(SUM(LENGTH(rawTx)), 0) + COALESCE(SUM(LENGTH(inputBEEF)), 0)
  FROM proven_tx_reqs
  UNION ALL
  SELECT 'transactions', COUNT(*),
         COALESCE(SUM(LENGTH(rawTx)), 0) + COALESCE(SUM(LENGTH(inputBEEF)), 0)
  FROM transactions
  UNION ALL
  SELECT 'outputs', COUNT(*), COALESCE(SUM(LENGTH(lockingScript)), 0) FROM outputs
`.trim()

/**
 * The predicate, as a SELECT, so the report and the UPDATE cannot drift.
 *
 * Parameters, in order: tipHeight, cutoff.
 */
const RECLAIM_PREDICATE = `
  inputBEEF IS NOT NULL
  AND status = 'completed'
  AND provenTxId IS NOT NULL
  AND EXISTS (SELECT 1 FROM proven_txs p
              WHERE p.provenTxId = transactions.provenTxId AND p.height <= ? - 100)
  AND NOT EXISTS (SELECT 1 FROM proven_tx_reqs r
                  WHERE r.txid = transactions.txid AND r.status <> 'completed')
  AND NOT EXISTS (SELECT 1 FROM offline_actions a
                  WHERE a.txid = transactions.txid AND a.status IN ('queued','posting'))
  AND updated_at < ?
`.trim()

/** Rows the predicate admits, with the bytes each would free. */
export const RECLAIM_CANDIDATES_SQL = `
  SELECT txid, transactionId, LENGTH(inputBEEF) AS bytes
  FROM transactions
  WHERE ${RECLAIM_PREDICATE}
`.trim()

/**
 * Rows holding an inputBEEF that the predicate REFUSES, and why.
 *
 * Reported so a near-miss is visible. A reclaim that silently frees less than
 * the user expected is indistinguishable from one that failed, and the guard
 * that excluded a row is the interesting part.
 */
export const RECLAIM_EXCLUDED_SQL = `
  SELECT
    CASE
      WHEN status <> 'completed' THEN 'not completed'
      WHEN provenTxId IS NULL THEN 'not proven'
      WHEN NOT EXISTS (SELECT 1 FROM proven_txs p
                       WHERE p.provenTxId = transactions.provenTxId AND p.height <= ? - 100)
        THEN 'inside the reorg horizon'
      WHEN EXISTS (SELECT 1 FROM proven_tx_reqs r
                   WHERE r.txid = transactions.txid AND r.status <> 'completed')
        THEN 'broadcast still in flight'
      WHEN EXISTS (SELECT 1 FROM offline_actions a
                   WHERE a.txid = transactions.txid AND a.status IN ('queued','posting'))
        THEN 'queued for sending'
      ELSE 'too recent'
    END AS reason,
    COUNT(*) AS rows,
    COALESCE(SUM(LENGTH(inputBEEF)), 0) AS bytes
  FROM transactions
  WHERE inputBEEF IS NOT NULL AND NOT (${RECLAIM_PREDICATE})
  GROUP BY reason
`.trim()

/**
 * Null the column for every admitted row.
 *
 * Parameters, in order: now, tipHeight, cutoff.
 *
 * Raw SQL because updateTransaction cannot write NULL: sqlUpdate skips undefined
 * values, so an update that means "clear this" is silently dropped.
 */
export const RECLAIM_INPUT_BEEF_SQL = `
  UPDATE transactions SET inputBEEF = NULL, updated_at = ?
  WHERE ${RECLAIM_PREDICATE}
`.trim()

export interface ReclaimTableSize {
  table: string
  rows: number
  blobBytes: number
}

export interface ReclaimReport {
  /** Size of the database file, or null when it could not be read. */
  dbBytes: number | null
  /** Free space on the volume, or null when unreadable. */
  freeBytes: number | null
  perTable: ReclaimTableSize[]
  /** What nulling inputBEEF would free right now. */
  reclaimable: { rows: number; bytes: number }
  /** Rows held back, by the guard that held them. */
  excluded: { reason: string; rows: number; bytes: number }[]
}
