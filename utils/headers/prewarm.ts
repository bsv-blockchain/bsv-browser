/**
 * Seeds the header store with roots this wallet has already had validated.
 *
 * `proven_txs` rows are written only after `TaskCheckForProofs` has confirmed
 * the proof against chaintracks, so their `merkleRoot` values are not the
 * server's unverified word — they are our own past verifications. Copying them
 * costs no network and covers exactly the heights a counterparty's BEEF will
 * reference, because our outputs become their inputs.
 */
import type { HeaderStore } from './headerStore'

export interface ProvenTxRootRow {
  height: number
  merkleRoot: string
}

export async function prewarmOwnRoots(args: { rows: ProvenTxRootRow[]; store: HeaderStore }): Promise<number> {
  const { rows, store } = args
  let added = 0
  for (const row of rows) {
    if (!Number.isInteger(row.height) || row.height <= 0) continue
    if (typeof row.merkleRoot !== 'string' || row.merkleRoot.length !== 64) continue
    if (store.rootForHeight(row.height) !== undefined) continue
    await store.putExtraRoot(row.height, row.merkleRoot)
    added++
  }
  return added
}
