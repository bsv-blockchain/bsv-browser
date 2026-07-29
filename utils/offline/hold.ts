/**
 * The result shape `shareReqsWithWorld` expects back from
 * `attemptToPostReqsToNetwork` when we have parked a request instead of
 * broadcasting it.
 *
 * `status: 'success'` here means "accepted for delivery", not "the network has
 * it". Nothing in the stored state claims otherwise: the request sits at
 * `nosend` rather than `unmined`, `wasBroadcast` stays false, and a row in
 * `offline_actions` records that it still needs sending. `aggregateActionResults`
 * maps this to a notDelayedResult of `success`
 * (`utility/aggregateResults.js:17-21`), which is what stops
 * `internalizeAction` from rolling back the payment it just verified.
 *
 * Pure by design: no I/O belongs in this file, so the semantics above stay
 * unit-testable without a database.
 */
export interface HeldReq {
  txid: string
}

export interface OfflineHoldResult<T extends HeldReq> {
  status: 'success'
  details: { txid: string; req: T; status: 'success' }[]
}

/**
 * Generic over the request type so the caller's own request objects pass
 * straight through: `attemptToPostReqsToNetwork` returns `EntityProvenTxReq`
 * in `details[].req`, and callers (`TaskSendWaiting`'s logging, for one) read
 * fields off it. Rebuilding a bare `{ txid }` stand-in here would satisfy the
 * type but hand back a different object than every other code path does.
 */
export function buildOfflineHoldResult<T extends HeldReq>(reqs: T[]): OfflineHoldResult<T> {
  return {
    status: 'success',
    details: reqs.map(req => ({ txid: req.txid, req, status: 'success' as const }))
  }
}
