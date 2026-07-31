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
  // Filter and dedup entirely in memory, then write once via putExtraRoots.
  // Calling putExtraRoot per row would rewrite the whole extra-roots file on
  // every iteration — O(n) file writes for n rows, which is invisible at the
  // tens-of-rows scale but costs whole seconds of JS-thread time at the
  // thousands-of-rows scale a long-lived wallet can reach.
  const seenHeights = new Set<number>()
  const toAdd: { height: number; root: string }[] = []
  for (const row of rows) {
    if (!Number.isInteger(row.height) || row.height <= 0) continue
    if (typeof row.merkleRoot !== 'string' || row.merkleRoot.length !== 64) continue
    if (seenHeights.has(row.height)) continue
    if (store.rootForHeight(row.height) !== undefined) continue
    seenHeights.add(row.height)
    toAdd.push({ height: row.height, root: row.merkleRoot })
  }
  if (toAdd.length === 0) return 0
  return store.putExtraRoots(toAdd)
}
