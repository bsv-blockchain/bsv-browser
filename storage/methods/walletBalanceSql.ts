/**
 * The wallet balance, as one SQL aggregate — and ONE definition of what the
 * balance is, used from both ends:
 *
 *  - `listOutputsSql`, when the toolbox asks for the `specOpWalletBalance` basket
 *  - the wallet screen, which calls this directly
 *
 * Calling it directly matters. Every read through `WalletStorageManager` queues
 * on a single FIFO reader lock, and the monitor's tasks hold that lock — along
 * with the writer and sync locks — across NETWORK calls: `attemptToPostReqsToNetwork`
 * broadcasts from inside `runAsStorageProvider`. A balance read issued while a
 * transaction is being broadcast therefore waits for the broadcast, not for the
 * database. That is where the multi-second balance reads on device came from,
 * not from the ~145 rows the query actually touches.
 *
 * This is a side-effect-free read of our own SQLite file, so it does not need
 * the lock the writes need.
 */

/** The basket the toolbox counts as the wallet balance, and the transaction
 * states in which an output's satoshis are really yours. Mirrors what
 * `listOutputsSql` builds for every other outputs query. */
export const BALANCE_BASKET = 'default'
export const BALANCE_TX_STATUS = ['completed', 'unproven', 'nosend']

/** The slice of StorageExpoSQLite this needs. Structural, so a caller can pass
 * the real provider and a test can pass one backed by any SQLite handle. */
export interface BalanceStorage {
  findOutputBaskets(args: { partial: { userId: number; name: string } }): Promise<{ basketId: number }[]>
  sumOutputSatoshis(
    args: { partial: Record<string, unknown>; txStatus?: string[]; noScript?: boolean },
    tagIds?: number[],
    isQueryModeAll?: boolean
  ): Promise<{ count: number; total: number }>
}

/**
 * Sum the spendable satoshis in the default basket for one user.
 *
 * Returns `null` when the basket does not exist yet — a wallet that has never
 * held anything. Callers should treat that as "no figure available" rather than
 * as a balance of zero, so a wallet still building does not flash 0 over a
 * cached figure.
 */
export async function readWalletBalance(storage: BalanceStorage, userId: number): Promise<number | null> {
  const baskets = await storage.findOutputBaskets({ partial: { userId, name: BALANCE_BASKET } })
  if (baskets.length !== 1) return null

  const { total } = await storage.sumOutputSatoshis({
    partial: { userId, basketId: baskets[0].basketId, spendable: true },
    txStatus: BALANCE_TX_STATUS,
    noScript: true
  })
  return total
}
