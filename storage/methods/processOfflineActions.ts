/**
 * Releases held transactions to the network, parents first.
 *
 * The order comes from the BEEF, not from the queue: a received transaction's
 * ancestry can contain other people's unbroadcast transactions that were never
 * our queue rows, and those must go out before ours. Every held request stores
 * the full AtomicBEEF it arrived in (`proven_tx_reqs.inputBEEF`, written at
 * `storage/methods/internalizeAction.js:519`), so merging those beefs gives the
 * whole dependency graph.
 *
 * Transactions we own are posted through the toolbox's own
 * `attemptToPostReqsToNetwork`, which handles status transitions, history notes
 * and `markStaleInputsAsSpent`. Foreign ancestors have no request here, so they
 * are posted directly through `services.postBeef`.
 *
 * Every decision — the order, what a broadcast result means, who dies with whom
 * — lives in `utils/offline/plan.ts` and is unit-tested. What is left here is
 * database reads, writes and logging, which is validated on device.
 */
import { Beef } from '@bsv/sdk'
import { attemptToPostReqsToNetwork } from '@bsv/wallet-toolbox-mobile/out/src/storage/methods/attemptToPostReqsToNetwork'
import { EntityProvenTxReq } from '@bsv/wallet-toolbox-mobile/out/src/storage/schema/entities'
import type { TableProvenTxReq, TableTransaction } from '@bsv/wallet-toolbox-mobile/out/src/storage/schema/tables'
import type { StorageExpoSQLite } from '../StorageExpoSQLite'
import { findOfflineActions, updateOfflineAction, type OfflineActionRow, type OfflineDb } from './offlineActions'
import {
  applyOutcome,
  outcomeFromReqStatus,
  outcomeOfForeignPost,
  outcomeOfOwnedPost,
  planRelease,
  undecidedReqStatuses,
  type PostOutcome
} from '../../utils/offline/plan'
import type { OrderableTx } from '../../utils/offline/order'
import { devLog } from '../../utils/logging'
import { getOnline } from '../../utils/net/online'

export interface ProcessOfflineActionsResult {
  /** Queue rows moved to 'sent'. A foreign ancestor's broadcast is logged, not counted. */
  sent: number
  /** Transactions whose local records were changed to record a rejection. */
  rejected: number
  /** True if the run did not reach the end of its plan, so there is more to do. */
  stopped: boolean
  /**
   * Why the queue cannot make progress by simply being retried.
   *
   * Distinct from `stopped`, which is also true for the ordinary "signal went away
   * again" case that the next run resolves by itself. This is set only where
   * retrying changes nothing: a queued transaction whose request has gone, one
   * whose beef will not parse, or an ancestor from someone else's beef that no
   * service will accept. Left conservative, all three leave their rows at 'queued'
   * with the received outputs still spendable and tell the user nothing — nothing
   * else in the system records them, so a caller must surface this.
   */
  stalledOn?: string
}

/** A queued transaction paired with the request that carries its bytes. */
interface HeldAction {
  row: OfflineActionRow
  api: TableProvenTxReq
}

export async function processOfflineActions(args: {
  storage: StorageExpoSQLite
}): Promise<ProcessOfflineActionsResult> {
  const { storage } = args
  const db = storage.sqliteDb
  if (!db) return { sent: 0, rejected: 0, stopped: true, stalledOn: 'the database is not open' }

  // 'posting' is included so a run interrupted mid-flight resumes rather than
  // stranding its rows. Re-posting is safe: a transaction the network already has
  // comes back as accepted (ARC's `SEEN_ON_NETWORK`), and a request storage has
  // already recorded as delivered is not posted again at all — see `postOwned`.
  const rows = await findOfflineActions(db, { status: ['queued', 'posting'] })
  if (rows.length === 0) return { sent: 0, rejected: 0, stopped: false }

  if (!(await probeOnline())) {
    devLog(`[processOfflineActions] offline, leaving ${rows.length} action(s) queued`)
    return { sent: 0, rejected: 0, stopped: true }
  }

  // Merge every held request's BEEF into one graph. Anything that cannot be read
  // is collected rather than thrown: a row missing from the graph is simply never
  // planned, which is safe but permanent, so it has to be reportable.
  const merged = new Beef()
  const held = new Map<string, HeldAction>()
  const blocked: string[] = []
  for (const row of rows) {
    const api = await findReq(storage, row.txid)
    if (!api) {
      devLog(`[processOfflineActions] queued txid has no request, cannot release it: ${row.txid}`)
      blocked.push(`${row.txid} has no request to release it with`)
      continue
    }
    // The request is remembered whatever happens below. Being in `held` does not
    // put anything in the plan — the plan comes from the graph — so a row whose
    // own beef failed can still be released properly if another row's beef
    // supplied it, ordered, as an ancestor.
    held.set(row.txid, { row, api })
    try {
      // ALL OR NOTHING, and this is why: `Beef.mergeBeef` is not atomic. It
      // parses the bytes into a standalone object first, but then merges
      // transaction by transaction into `this`, and `mergeBeefTx` can throw
      // partway through. Merging the raw transaction straight into `merged`
      // before its beef is worse still — a beef that fails to parse at all
      // leaves the child in the graph with none of its ancestors.
      //
      // Nothing downstream can tell that apart from a child whose parents are
      // already mined: `releaseOrder` finds no in-set input, calls it unblocked
      // and posts it first, the network refuses it as an orphan, and the cascade
      // marks it and everything spending it 'failed'. That is received money made
      // permanently unspendable by our own ordering error rather than by any
      // verdict the network reached — the one outcome this engine exists to
      // prevent. So each row is assembled in isolation and folded in only once
      // the whole of it parsed.
      //
      // The fold cannot itself half-succeed the way the parse can: `scratch` is
      // already a live `Beef`, and `mergeBeefTx` only throws for an entry that is
      // neither txid-only nor carrying bytes, which `BeefTx.isTxidOnly` makes
      // unrepresentable.
      const scratch = new Beef()
      scratch.mergeRawTx(api.rawTx)
      if (api.inputBEEF) scratch.mergeBeef(api.inputBEEF)
      merged.mergeBeef(scratch)
    } catch (e) {
      // Without its whole beef this transaction has no place in the graph, so it
      // is simply not planned and stays queued. Never guess at an order.
      devLog(`[processOfflineActions] could not merge the beef of ${row.txid}:`, e)
      blocked.push(`the beef of ${row.txid} could not be read`)
    }
  }
  const stalledOn = blocked.length > 0 ? blocked.join('; ') : undefined

  const txs: OrderableTx[] = merged.txs
  const plan = planRelease({ rows, txs })

  let sent = 0
  let rejected = 0
  const resolved = new Set<string>()
  for (const step of plan) {
    const action = step.owned ? held.get(step.txid) : undefined
    if (step.owned && !action) {
      // Its request is gone, so it can never be posted — and nothing downstream
      // of it may go out either, or it becomes an orphan. Stop rather than reject:
      // this is a local anomaly, not a verdict from the network, and 'failed' is
      // not reversible.
      devLog(`[processOfflineActions] stopping: no request to release ${step.txid} with`)
      await requeue(db, plan, resolved)
      return { sent, rejected, stopped: true, stalledOn: stalledOn ?? `${step.txid} has no request to release it with` }
    }
    if (action) await updateOfflineAction(db, step.txid, { status: 'posting' })

    const outcome = action ? await postOwned(storage, action.api) : await postForeign(storage, merged, step.txid)
    // A cascade needs to see what spends the refused transaction, and beefs only
    // reach backwards, so the graph the queue built cannot contain a spender that
    // is not itself queued. Widened only when a cascade is actually about to run,
    // because that widening reads every undecided request in the wallet.
    const cascadeTxs = outcome === 'success' || outcome === 'serviceError' ? txs : await withLocalSpenders(storage, txs)
    const result = applyOutcome({ txid: step.txid, outcome, txs: cascadeTxs, rows })

    for (const txid of result.sent) {
      resolved.add(txid)
      if (held.has(txid)) {
        await updateOfflineAction(db, txid, { status: 'sent' })
        sent++
      } else {
        devLog(`[processOfflineActions] foreign ancestor broadcast: ${txid}`)
      }
    }
    for (const r of result.rejected) {
      resolved.add(r.txid)
      try {
        if (await rejectOne(storage, db, held.get(r.txid)?.row, r)) rejected++
      } catch (e) {
        // The walk must reach the parent. A child's failure has already released
        // the parent's outputs back to spendable, so abandoning the cascade here
        // would leave refused money spendable — the exact outcome children-first
        // ordering exists to prevent.
        devLog(`[processOfflineActions] could not record the rejection of ${r.txid}:`, e)
      }
    }
    if (result.stop) {
      await requeue(db, plan, resolved)
      // A foreign ancestor no service would take blocks everything behind it and
      // retrying will not change that, whereas our own failed post is the ordinary
      // "signal went away" case the next run picks up.
      const foreign = !action && outcome === 'serviceError'
      const why = foreign
        ? `${step.txid} is an ancestor from another wallet's beef that no service would accept`
        : undefined
      return { sent, rejected, stopped: true, stalledOn: stalledOn ?? why }
    }
  }
  return { sent, rejected, stopped: false, stalledOn }
}

/**
 * A failed connectivity probe must not stop the drain: assume online and let the
 * post itself be the evidence, exactly as the offline hold assumes online when
 * its own probe fails.
 */
async function probeOnline(): Promise<boolean> {
  try {
    return await getOnline()
  } catch (e) {
    devLog('[processOfflineActions] connectivity probe failed, assuming online:', e)
    return true
  }
}

/**
 * The release graph plus every locally-known transaction that has not been
 * decided yet, so a cascade can find the spenders of a refused transaction.
 *
 * These are exactly the descendants with no queue row of their own: the wallet
 * re-spent money it received underground, and Task 8 leaves such an outgoing
 * request to `TaskSendWaiting` rather than parking it, so nothing put it in the
 * queue. They are added for the cascade only and never for release — this engine
 * has no request bookkeeping to offer them, and the monitor already owns sending
 * them. Which statuses count as undecided is a money decision and lives with the
 * others in `utils/offline/plan.ts`.
 *
 * A failure to read them widens nothing rather than throwing, so a cascade still
 * runs over the queue's own graph. Every error here costs rejections we should
 * have made, never rejections we should not have.
 */
async function withLocalSpenders(storage: StorageExpoSQLite, txs: OrderableTx[]): Promise<OrderableTx[]> {
  const known = new Set(txs.map(t => t.txid))
  const spenders = new Beef()
  let pending: TableProvenTxReq[] = []
  try {
    pending = await storage.findProvenTxReqs({ partial: {}, status: undecidedReqStatuses })
  } catch (e) {
    devLog('[processOfflineActions] could not read undecided requests, cascading over the queue alone:', e)
    return txs
  }
  for (const api of pending) {
    if (known.has(api.txid)) continue
    try {
      spenders.mergeRawTx(api.rawTx)
    } catch (e) {
      devLog(`[processOfflineActions] could not read the raw transaction of ${api.txid}:`, e)
    }
  }
  return [...txs, ...spenders.txs.filter(t => !known.has(t.txid))]
}

/**
 * The request for a txid, or undefined if there is none or it could not be read.
 *
 * Guarded because every caller has something safer to do with a failed read than
 * abandon the run: the merge loop leaves the row unplanned, `postOwned` falls back
 * to 'serviceError' and re-holds, and `rejectOne` still records what it can.
 */
async function findReq(storage: StorageExpoSQLite, txid: string): Promise<TableProvenTxReq | undefined> {
  try {
    return (await storage.findProvenTxReqs({ partial: { txid } }))[0]
  } catch (e) {
    devLog(`[processOfflineActions] could not read the request for ${txid}:`, e)
    return undefined
  }
}

/** Return every unresolved row we may have moved to 'posting' to 'queued'. */
async function requeue(db: OfflineDb, plan: { txid: string; owned: boolean }[], resolved: Set<string>): Promise<void> {
  for (const step of plan) {
    if (!step.owned || resolved.has(step.txid)) continue
    await updateOfflineAction(db, step.txid, { status: 'queued' })
  }
}

/**
 * Post a transaction this wallet owns, reusing the toolbox's bookkeeping.
 *
 * The module function is imported and called directly rather than as
 * `storage.attemptToPostReqsToNetwork`, so Task 8's offline override cannot
 * intercept it. That matters for more than tidiness: the override returns
 * `status: 'success'` for a request it merely parked, and a drain that read that
 * as delivery would mark the queue row 'sent' for a transaction nobody has. The
 * outcome is therefore taken from what storage records, not from what the post
 * reports — see `outcomeOfOwnedPost`.
 *
 * The request is left at 'nosend' for the post. `attemptToPostReqsToNetwork` has
 * no status gate (it screens on rawTx, notify.transactionIds and inputBEEF only,
 * `attemptToPostReqsToNetwork.js:61-99`), so promoting it first would buy nothing
 * and would briefly publish it at 'unsent' — the status `TaskSendWaiting` selects
 * — handing the monitor a chance to broadcast it out of dependency order.
 *
 * On anything but success the hold is restored. A service error otherwise leaves
 * the request at 'sending' with `attempts` incremented
 * (`attemptToPostReqsToNetwork.js:249-253`), which is exactly the state
 * `TaskSendWaiting` picks up every five minutes and `applyProofTimeout` eventually
 * marks 'invalid' (`EntityProvenTxReq.js:426-433`). Leaving it there would hand
 * back the very failure the hold exists to prevent, and out of dependency order at
 * that.
 *
 * That makes the post itself throwing the dangerous case, because the toolbox
 * persists the request's new status and only afterwards touches the transaction
 * rows and — on a failure — runs `markStaleInputsAsSpent`, which does live chain
 * queries. A throw past that first write would otherwise leave 'sending' behind
 * with no re-hold. So the post is guarded and a throw simply leaves `detailStatus`
 * undefined, letting the persisted status decide, which is what decides anyway.
 * The drain recovers from a stalled run; it cannot recover from an out-of-order
 * broadcast.
 */
async function postOwned(storage: StorageExpoSQLite, api: TableProvenTxReq): Promise<PostOutcome> {
  const recorded = outcomeFromReqStatus(api.status)
  if (recorded !== undefined) {
    devLog(`[processOfflineActions] storage already records '${api.status}' for ${api.txid}, not posting`)
    return recorded
  }

  const attemptsBefore = api.attempts
  const req = new EntityProvenTxReq(api)
  // What to restore each transaction to, read before the post overwrites it.
  // `holdSafeTxStatuses` admits 'nosend' as well as 'unproven', and a deliberately
  // withheld transaction must not come back claiming it had been broadcast.
  const txStatusBefore = new Map<number, TableTransaction['status']>()
  for (const transactionId of req.notify.transactionIds ?? []) {
    try {
      const tx = (await storage.findTransactions({ partial: { transactionId }, noRawTx: true }))[0]
      if (tx) txStatusBefore.set(transactionId, tx.status)
    } catch (e) {
      devLog(`[processOfflineActions] could not read the status of transaction ${transactionId}:`, e)
    }
  }

  let detailStatus: string | undefined
  try {
    const posted = await attemptToPostReqsToNetwork(storage, [req])
    detailStatus = posted.details.find(d => d.txid === api.txid)?.status
  } catch (e) {
    devLog(`[processOfflineActions] posting ${api.txid} threw:`, e)
  }
  // An independent read: whatever the post claimed, or failed to claim, storage is
  // the witness that the transaction actually left.
  const reqStatus = (await findReq(storage, api.txid))?.status
  const outcome = outcomeOfOwnedPost({ detailStatus, reqStatus })
  devLog(`[processOfflineActions] posted ${api.txid}: reported '${detailStatus}', stored '${reqStatus}' => ${outcome}`)
  if (outcome !== 'serviceError') return outcome

  // Re-hold, and put each transaction back to the hold-safe status it actually
  // had, so its outputs stay spendable and nothing sweeps it while we wait for
  // signal. `attempts` is restored too, so repeated releases while signal comes and
  // goes cannot age a held request toward 'invalid'. The request first, because it
  // is the write that keeps the monitor out and the transaction writes can throw.
  await storage.updateProvenTxReq(api.provenTxReqId, { status: 'nosend', attempts: attemptsBefore })
  for (const [transactionId, status] of txStatusBefore) {
    try {
      await storage.updateTransactionStatus(status, transactionId)
    } catch (e) {
      devLog(`[processOfflineActions] could not restore transaction ${transactionId} to '${status}':`, e)
    }
  }
  return 'serviceError'
}

/**
 * Post a foreign ancestor that arrived inside someone's BEEF.
 *
 * Only its own dependency closure is sent, not the whole merged graph, so each
 * transaction reaches the network in the order this engine chose rather than in
 * whatever order a service happens to unpack a batch.
 *
 * Services come from `storage.getServices()` rather than being passed in, so the
 * owned path — which calls `getServices()` itself inside the toolbox — and this
 * one cannot end up posting the same graph to two different sets of providers.
 */
async function postForeign(storage: StorageExpoSQLite, merged: Beef, txid: string): Promise<PostOutcome> {
  try {
    const atomic = Beef.fromBinary(merged.toBinaryAtomic(txid))
    const results = await storage.getServices().postBeef(atomic, [txid])
    const outcome = outcomeOfForeignPost({ txid, results })
    devLog(`[processOfflineActions] posted foreign ancestor ${txid} => ${outcome}`)
    return outcome
  } catch (e) {
    devLog(`[processOfflineActions] posting foreign ancestor ${txid} threw, treating as retryable:`, e)
    return 'serviceError'
  }
}

/**
 * Record one rejection, and report whether anything local actually changed.
 *
 * Every read and every write is attempted independently, so one refusal costs only
 * the record it was for rather than the records after it —
 * `updateTransactionStatus` throws for an already-completed or proven transaction
 * (`StorageProvider.js:414-420`). What guarantees the cascade reaches the parent is
 * the caller's per-entry guard, not this function: unpacking the request entity can
 * still throw on corrupt stored JSON, and by then the child's failure has already
 * released the parent's outputs back to spendable.
 */
async function rejectOne(
  storage: StorageExpoSQLite,
  db: OfflineDb,
  row: OfflineActionRow | undefined,
  r: { txid: string; reason: string; poisonedByTxid: string }
): Promise<boolean> {
  let recorded = false
  const api = await findReq(storage, r.txid)
  if (api) {
    const req = new EntityProvenTxReq(api)
    // The attribution record: who handed us the poisoned transaction, over what
    // transport, and when. This is the only durable evidence the user will have.
    req.addHistoryNote({
      when: new Date().toISOString(),
      what: 'offlineRejected',
      poisonedBy: r.poisonedByTxid,
      reason: r.reason,
      senderIdentityKey: row?.senderIdentityKey ?? 'unknown',
      receivedVia: row?.receivedVia ?? 'unknown',
      receivedAt: row?.created_at ?? 'unknown'
    })
    req.status = 'invalid'
    try {
      await req.updateStorageDynamicProperties(storage)
      recorded = true
    } catch (e) {
      devLog(`[processOfflineActions] could not mark request ${r.txid} invalid:`, e)
    }
    for (const transactionId of req.notify.transactionIds ?? []) {
      try {
        // 'failed' releases allocated inputs and marks the outputs not spendable
        // (StorageProvider.js:421-424) — the money must stop being spendable.
        await storage.updateTransactionStatus('failed', transactionId)
        recorded = true
      } catch (e) {
        devLog(`[processOfflineActions] could not fail transaction ${transactionId} of ${r.txid}:`, e)
      }
    }
  }
  if (row) {
    try {
      await updateOfflineAction(db, r.txid, {
        status: 'rejected',
        rejectedReason: r.reason,
        poisonedByTxid: r.poisonedByTxid
      })
      recorded = true
    } catch (e) {
      devLog(`[processOfflineActions] could not mark the queue row of ${r.txid} rejected:`, e)
    }
  }
  devLog(`[processOfflineActions] rejected ${r.txid} (poisoned by ${r.poisonedByTxid}): ${r.reason}`)
  return recorded
}
