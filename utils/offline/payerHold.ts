/**
 * The payer's side of the offline queue: record that this payment still needs
 * broadcasting, then promote the withheld transaction so its change is
 * spendable.
 *
 * `buildPaymentFrame` creates the payment with `noSend: true`, which
 * `determineReqTxStatus` (`storage/methods/processAction.js:150-159`) leaves
 * BOTH the request and the transaction at `nosend`. The request staying
 * `nosend` is exactly what the release drain wants — `processOfflineActions`'s
 * `postOwned` posts a request it finds at `nosend` as-is, and deliberately does
 * not promote it first (see that function's comment on why promoting the
 * request would buy nothing and could hand the monitor a chance to broadcast
 * out of order). The TRANSACTION is the one row that must move: a `nosend`
 * transaction's change is invisible to `allocateChangeInput`
 * (`storage/StorageExpoSQLite.ts:1284`, whose status list is
 * `['completed','unproven']` plus optionally `'sending'`), so until this
 * promotion runs, a payer stuck underground could never fund a second offline
 * payment out of the first one's change. `nosend -> unproven` is a pure status
 * write with no output side-effects — only `failed` has any
 * (`StorageProvider.js:397-436`).
 *
 * ORDER MATTERS. The queue-row insert runs FIRST, deliberately, because it is
 * durable and the status promotion is not: nothing in this app re-drives a
 * hold that failed partway (see `finalizeDelivery`'s catch — a thrown hold is
 * reported as `broadcast: 'pending'`, not retried). If the insert lands and
 * the promotion then throws, `processOfflineActions`'s drain still finds this
 * txid's row and will post it — `postOwned` reads whatever transaction status
 * a request's outputs are ALREADY at before posting and only restores that
 * same status on a service error (`processOfflineActions.ts` — "holdSafeTxStatuses
 * admits 'nosend' as well as 'unproven'"), and `attemptToPostReqsToNetwork`
 * promotes the transaction forward on any successful post regardless of what
 * it started at (`attemptToPostReqsToNetwork.js:189-197,268`). So a failed
 * promotion only costs this device the ability to spend this change while
 * still offline; it resolves itself the moment the drain successfully posts
 * the transaction, with no data lost. The reverse order would risk the
 * opposite failure: a promoted-but-unqueued transaction that nothing will
 * ever broadcast, because `processOfflineActions` only ever looks at
 * `offline_actions` rows, and no monitor task sweeps a plain `nosend`
 * transaction to send it — `TaskSendWaiting` selects only
 * `['unsent','sending']`, and `TaskCheckNoSends` (the only task that reads
 * `nosend` rows at all) only requests merkle proofs for transactions that may
 * have been broadcast BY SOME OTHER MEANS; it never calls `sendWith` and never
 * advances status.
 *
 * Deliberately NOT built on `holdReqsOffline` (Task 8): that method's contract
 * is the opposite of this one's job. It takes the transaction status as a
 * PRECONDITION and leaves it untouched — its whole point, on the receiving
 * side, is that `internalizeAction` already left the transaction `unproven`
 * before it runs. Coupling this payer-side promotion into it would mean either
 * bending that documented invariant (risking the receiving path it protects)
 * or calling it and then promoting the transaction separately anyway, which
 * shares nothing. What genuinely is shared — the `offline_actions` insert — is
 * reused directly via `insertOfflineAction`.
 */
import { insertOfflineAction } from '@/storage/methods/offlineActions'
import { TaskSendOffline } from '@/utils/monitor/TaskSendOffline'
import type { StorageExpoSQLite } from '@/storage/StorageExpoSQLite'

export async function holdSentPaymentOffline(args: {
  storage: StorageExpoSQLite
  txid: string
  /** The full bsvpayf1: QR string, persisted so the code can be re-shown later. */
  framePayload?: string
}): Promise<void> {
  const { storage, txid, framePayload } = args
  const db = storage.sqliteDb
  if (!db) throw new Error('the database is not open, cannot queue this payment for release')

  // The transaction row is the one authority this needs for both facts: its
  // own transactionId, to promote, and its userId, to attribute the queue row.
  // Resolving userId any other way risks a value unconnected to this payment —
  // and `offline_actions.userId` is a foreign key with enforcement OFF in this
  // app (no `PRAGMA foreign_keys` anywhere), so a wrong id would not fail loudly,
  // it would silently park the payment under a user nothing ever queries. If the
  // transaction cannot be found at all, there is no safe id to fall back to, so
  // this throws rather than guessing — the caller (`finalizeDelivery`) already
  // treats a failed hold as a non-fatal `broadcast: 'pending'`, because the
  // payee holds its own durable copy regardless of whether this device's queue
  // bookkeeping succeeds.
  const tx = (await storage.findTransactions({ partial: { txid }, noRawTx: true }))[0]
  if (!tx) throw new Error(`no transaction record for ${txid}, cannot queue it for release`)

  // Insert before promote — see the ORDER MATTERS note above.
  await insertOfflineAction(db, { userId: tx.userId, txid, role: 'sent', framePayload })
  TaskSendOffline.noteEnqueued()
  await storage.updateTransactionStatus('unproven', tx.transactionId)
}
