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
import type { TableProvenTxReq } from '@bsv/wallet-toolbox-mobile/out/src/storage/schema/tables'
import type { ProvenTxReqStatus } from '@bsv/wallet-toolbox-mobile/out/src/sdk/types'
import type { StorageExpoSQLite } from '../StorageExpoSQLite'
import { findOfflineActions, updateOfflineAction, type OfflineActionRow, type OfflineDb } from './offlineActions'
import {
  applyOutcome,
  outcomeFromReqStatus,
  outcomeOfForeignPost,
  outcomeOfOwnedPost,
  planRelease,
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
  if (!db) return { sent: 0, rejected: 0, stopped: true }

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

  // Merge every held request's BEEF into one graph.
  const merged = new Beef()
  const held = new Map<string, HeldAction>()
  for (const row of rows) {
    const api = (await storage.findProvenTxReqs({ partial: { txid: row.txid } }))[0]
    if (!api) {
      devLog(`[processOfflineActions] queued txid has no request, cannot release it: ${row.txid}`)
      continue
    }
    held.set(row.txid, { row, api })
    try {
      merged.mergeRawTx(api.rawTx)
      if (api.inputBEEF) merged.mergeBeef(api.inputBEEF)
    } catch (e) {
      // Without its beef this transaction has no place in the graph, so it is
      // simply not planned and stays queued. Never guess at an order.
      devLog(`[processOfflineActions] could not merge the beef of ${row.txid}:`, e)
    }
  }

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
      return { sent, rejected, stopped: true }
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
      if (await rejectOne(storage, db, held.get(r.txid)?.row, r)) rejected++
    }
    if (result.stop) {
      await requeue(db, plan, resolved)
      return { sent, rejected, stopped: true }
    }
  }
  return { sent, rejected, stopped: false }
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
 * Request statuses that carry no verdict yet, so the transaction behind them
 * could still turn out to be spending poisoned money. The complement of
 * `alreadySentStatuses` and the terminal failures, over `ProvenTxReqStatus`
 * (`sdk/types.d.ts:51`).
 */
const undecidedReqStatuses: ProvenTxReqStatus[] = ['unsent', 'sending', 'nosend', 'unprocessed', 'nonfinal', 'unknown']

/**
 * The release graph plus every locally-known transaction that has not been
 * decided yet, so a cascade can find the spenders of a refused transaction.
 *
 * These are exactly the descendants with no queue row of their own: the wallet
 * re-spent money it received underground, and Task 8 leaves such an outgoing
 * request to `TaskSendWaiting` rather than parking it, so nothing put it in the
 * queue. They are added for the cascade only and never for release — this engine
 * has no request bookkeeping to offer them, and the monitor already owns sending
 * them.
 */
async function withLocalSpenders(storage: StorageExpoSQLite, txs: OrderableTx[]): Promise<OrderableTx[]> {
  const known = new Set(txs.map(t => t.txid))
  const spenders = new Beef()
  const pending = await storage.findProvenTxReqs({ partial: {}, status: undecidedReqStatuses })
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
 */
async function postOwned(storage: StorageExpoSQLite, api: TableProvenTxReq): Promise<PostOutcome> {
  const recorded = outcomeFromReqStatus(api.status)
  if (recorded !== undefined) {
    devLog(`[processOfflineActions] storage already records '${api.status}' for ${api.txid}, not posting`)
    return recorded
  }

  const attemptsBefore = api.attempts
  const req = new EntityProvenTxReq(api)
  const posted = await attemptToPostReqsToNetwork(storage, [req])
  const detailStatus = posted.details.find(d => d.txid === api.txid)?.status
  // An independent read: whatever the post claimed, storage is the witness that
  // the transaction actually left.
  const persisted = (await storage.findProvenTxReqs({ partial: { txid: api.txid } }))[0]
  const outcome = outcomeOfOwnedPost({ detailStatus, reqStatus: persisted?.status })
  devLog(
    `[processOfflineActions] posted ${api.txid}: reported '${detailStatus}', stored '${persisted?.status}' => ${outcome}`
  )
  if (outcome !== 'serviceError') return outcome

  // Re-hold, and put the transaction back to 'unproven' so the received outputs
  // stay spendable and nothing sweeps it while we wait for signal. `attempts` is
  // restored too, so repeated releases while signal comes and goes cannot age a
  // held request toward 'invalid'.
  await storage.updateProvenTxReq(api.provenTxReqId, { status: 'nosend', attempts: attemptsBefore })
  for (const transactionId of req.notify.transactionIds ?? []) {
    try {
      await storage.updateTransactionStatus('unproven', transactionId)
    } catch (e) {
      devLog(`[processOfflineActions] could not restore transaction ${transactionId} to 'unproven':`, e)
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
 * Every write is attempted independently. A cascade must not abandon the
 * descendants still to be failed because one transaction refused its status
 * change — `updateTransactionStatus` throws for an already-completed or proven
 * transaction (`StorageProvider.js:414-420`).
 */
async function rejectOne(
  storage: StorageExpoSQLite,
  db: OfflineDb,
  row: OfflineActionRow | undefined,
  r: { txid: string; reason: string; poisonedByTxid: string }
): Promise<boolean> {
  let recorded = false
  const api = (await storage.findProvenTxReqs({ partial: { txid: r.txid } }))[0]
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
    await updateOfflineAction(db, r.txid, {
      status: 'rejected',
      rejectedReason: r.reason,
      poisonedByTxid: r.poisonedByTxid
    })
    recorded = true
  }
  devLog(`[processOfflineActions] rejected ${r.txid} (poisoned by ${r.poisonedByTxid}): ${r.reason}`)
  return recorded
}
