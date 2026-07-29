/*
 * Deciding whether a request may be held for later delivery, and what to report
 * when it is.
 *
 * `status: 'success'` from a hold means "accepted for delivery", not "the
 * network has it". Nothing in the stored state claims otherwise: the request
 * sits at `nosend` rather than `unmined`, `wasBroadcast` stays false, and a row
 * in `offline_actions` records that it still needs sending.
 * `aggregateActionResults` maps this to a notDelayedResult of `success`
 * (`utility/aggregateResults.js:17-21`), which is what stops `internalizeAction`
 * from rolling back the payment it just verified.
 *
 * Pure by design: no I/O belongs in this file. The caller does the database
 * reads and hands the rows in, so the rules that decide whether money may be
 * parked — and under whose name — are unit-testable rather than device-only.
 */
import type { OfflineActionRole } from '@/storage/methods/offlineActions'

export interface HeldReq {
  txid: string
}

export interface OfflineHoldResult<T extends HeldReq> {
  status: 'success'
  details: { txid: string; req: T; status: 'success' }[]
}

/**
 * The result shape `shareReqsWithWorld` expects back from
 * `attemptToPostReqsToNetwork` when a request was parked instead of broadcast.
 *
 * Generic over the request type so the caller's own request objects pass
 * straight through: `attemptToPostReqsToNetwork` returns `EntityProvenTxReq` in
 * `details[].req`, and callers (`TaskSendWaiting`'s logging, for one) read
 * fields off it. Rebuilding a bare `{ txid }` stand-in here would satisfy the
 * type but hand back a different object than every other code path does.
 */
export function buildOfflineHoldResult<T extends HeldReq>(reqs: T[]): OfflineHoldResult<T> {
  return {
    status: 'success',
    details: reqs.map(req => ({ txid: req.txid, req, status: 'success' as const }))
  }
}

/**
 * The transaction-row facts a hold decision needs. Structurally satisfied by
 * `TableTransaction`, so the caller passes rows straight in.
 */
export interface HoldTx {
  userId: number
  isOutgoing: boolean
  status: string
}

export interface OfflineHoldGroup {
  userId: number
  role: OfflineActionRole
  reqs: { txid: string }[]
}

/**
 * Transaction statuses that survive having their request parked at 'nosend'.
 *
 * Holding a request stops the broadcast but writes nothing to the transaction
 * row, so that row's existing status must already be one no monitor task acts on
 * and that keeps the coins usable:
 *
 * - 'unproven' — what `internalizeAction` sets
 *   (`storage/methods/internalizeAction.js:352`). Ignored by `TaskFailAbandoned`
 *   and accepted by `allocateChangeInput`, so the received outputs stay
 *   spendable while the broadcast waits. This is the case the feature needs.
 * - 'nosend' — a deliberately withheld transaction, likewise swept by nothing.
 *
 * Everything else is refused, and 'unprocessed' is why this list exists. A
 * non-delayed `createAction` leaves its transaction at 'unprocessed'
 * (`storage/methods/processAction.js:156-159`) and relies on
 * `updateReqsFromAggregateResults` — which a hold skips — to promote it to
 * 'unproven' via `postStatus`. Held at 'unprocessed' it would instead be failed
 * by `TaskFailAbandoned` within `abandonedMsecs` (5 minutes,
 * `monitor/Monitor.js:39`; it selects `['unprocessed','unsigned']` at
 * `monitor/tasks/TaskFailAbandoned.js:35`), which restores its inputs to
 * spendable while the `offline_actions` row still reads 'queued' — leaving a
 * drain to broadcast a transaction the wallet has already failed and may have
 * re-spent the inputs of.
 *
 * Refusing instead returns that request to the behaviour it has today: a
 * `serviceError` leaves the request at 'sending', which `TaskSendWaiting`
 * already retries on its own.
 */
export const holdSafeTxStatuses: readonly string[] = ['unproven', 'nosend']

/**
 * Decide whether every request in a call may be held, and group those that may
 * by the `(userId, role)` their `offline_actions` row needs.
 *
 * All-or-nothing: returns undefined if **any** pair is unattributable or sits on
 * a transaction status that is not hold-safe, which tells the caller to refuse
 * the whole call and let the ordinary broadcast run. A partial hold is not
 * offered, because the result the caller must return covers every txid it was
 * given — reporting 'success' for a held subset while the rest went nowhere
 * would be exactly the false claim holding is careful to avoid — and because a
 * `sendWith` batch has its merged BEEF verified as a unit and is released as a
 * unit.
 *
 * `role` follows the money: `isOutgoing` is true for the wallet's own sends
 * (`storage/methods/createAction.js:377`) and false for what it receives
 * (`storage/methods/internalizeAction.js:364`).
 *
 * Grouped per pair rather than resolved from the first one: a single non-delayed
 * call can carry a whole `options.sendWith` batch, and such a batch can mix a
 * released incoming transaction with the user's own outgoing one, so the role
 * genuinely varies within a call.
 */
export function groupOfflineHolds<T extends HeldReq>(
  pairs: { req: T; tx: HoldTx | undefined }[]
): Map<string, OfflineHoldGroup> | undefined {
  const groups = new Map<string, OfflineHoldGroup>()
  for (const { req, tx } of pairs) {
    if (!tx || !holdSafeTxStatuses.includes(tx.status)) return undefined
    const role: OfflineActionRole = tx.isOutgoing ? 'sent' : 'received'
    const key = `${tx.userId} ${role}`
    const group = groups.get(key) ?? { userId: tx.userId, role, reqs: [] }
    group.reqs.push({ txid: req.txid })
    groups.set(key, group)
  }
  return groups
}
