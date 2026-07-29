/**
 * What to release, in what order, and what a broadcast result means.
 *
 * Split from the driver so the two decisions that can lose money — ordering and
 * cascading — are unit-testable without a database or a network. Reading a
 * broadcast result is here for the same reason: "did this actually reach the
 * network" is a decision, not plumbing, and getting it wrong marks a queue row
 * 'sent' for a transaction nobody has.
 */
import { descendantsOf, releaseOrder, type OrderableTx } from './order'
import type { OfflineActionRow } from '@/storage/methods/offlineActions'
import type { ProvenTxReqStatus } from '@bsv/wallet-toolbox-mobile/out/src/sdk/types'

export type PostOutcome = 'success' | 'serviceError' | 'invalidTx' | 'doubleSpend'

/**
 * Dependency-ordered release list.
 *
 * `owned` distinguishes a transaction this wallet has a request for — post it
 * through `attemptToPostReqsToNetwork` so the toolbox does its own status
 * bookkeeping — from a foreign ancestor that arrived inside somebody's BEEF and
 * has no request here, which must be posted directly. Getting this wrong is how
 * a child becomes an orphan: EF carries input scripts but not parent
 * transactions, so an unbroadcast ancestor has to go out on its own first.
 */
export function planRelease(args: {
  rows: OfflineActionRow[]
  txs: OrderableTx[]
}): { txid: string; owned: boolean }[] {
  const owned = new Set(args.rows.filter(r => r.status !== 'sent').map(r => r.txid))
  return releaseOrder(args.txs).map(txid => ({ txid, owned: owned.has(txid) }))
}

/**
 * Turn one broadcast result into state changes.
 *
 *  · success      — this transaction is out; continue down the list.
 *  · serviceError — no evidence of invalidity, only of no network. Stop the run
 *                   and leave everything queued. Never reject on this.
 *  · invalidTx /
 *    doubleSpend  — the network refuses it, so no descendant of it can ever be
 *                   valid. Reject it and every descendant, and stop, because
 *                   anything later in the order may depend on it.
 *
 * `rows` is accepted so a caller hands the same pair of arguments to this and to
 * `planRelease`, but the cascade deliberately never consults it. Descendants are
 * read from the BEEF alone: a transaction the wallet built while offline by
 * spending the poisoned money has a request and a transaction row but no queue
 * row of its own, and it is exactly the thing that must stop being spendable.
 *
 * `rejected` comes back in the order it must be applied — descendants first, the
 * refused transaction last. Failing a transaction releases its inputs back to
 * spendable (`StorageProvider.releaseInputsAllocatedToFailedTransaction`,
 * `StorageProvider.js:365-373`) before marking its own outputs unspendable, so a
 * child failed after its parent hands the poisoned outputs back as spendable.
 * Applied child-first, the parent's own failure has the last word.
 */
export function applyOutcome(args: {
  txid: string
  outcome: PostOutcome
  txs: OrderableTx[]
  rows: OfflineActionRow[]
}): {
  stop: boolean
  sent: string[]
  rejected: { txid: string; reason: string; poisonedByTxid: string }[]
} {
  const { txid, outcome, txs } = args
  if (outcome === 'success') return { stop: false, sent: [txid], rejected: [] }
  if (outcome === 'serviceError') return { stop: true, sent: [], rejected: [] }

  const reason =
    outcome === 'doubleSpend'
      ? 'the network reported a double spend of an input'
      : 'the transaction was rejected as invalid'
  const poisoned = [txid, ...descendantsOf(txid, txs)]
  const cascade = new Set(poisoned)
  // Reverse dependency order. `descendantsOf` reports by discovery, which is not
  // a topological order — a transaction can spend both the refused one and one of
  // its own siblings — so the order is taken from `releaseOrder` and reversed.
  const sorted = releaseOrder(txs.filter(t => cascade.has(t.txid))).reverse()
  // A poisoned transaction `releaseOrder` declines to order is mined or txid-only,
  // neither of which a held transaction can be. Rejected anyway, and rejected
  // FIRST: an excluded entry can only ever be a descendant, because the refused
  // transaction itself came out of `planRelease` and is therefore sendable. Placed
  // last it would release its parent's outputs back to spendable with nothing left
  // to run — undoing children-first on the one branch that has no ordering of its
  // own. First is unconditionally the safe end.
  const ordered = [...poisoned.filter(t => !sorted.includes(t)), ...sorted]
  const rejected = ordered.map(t => ({
    txid: t,
    reason: t === txid ? reason : `an ancestor was rejected: ${reason}`,
    poisonedByTxid: txid
  }))
  return { stop: true, sent: [], rejected }
}

/**
 * Every `ProvenTxReqStatus` (`sdk/types.d.ts:51`), classified by the verdict it
 * records.
 *
 *  · 'success'     — `alreadySentStatuses` (`storageProviderHelpers.js:12`): the
 *                    wallet's own record that the transaction reached the network,
 *                    and the only witness this module trusts for delivery.
 *  · 'doubleSpend' /
 *    'invalidTx'   — a refusal already recorded against it.
 *  · 'undecided'   — no verdict yet, so the transaction behind it could still turn
 *                    out to be spending poisoned money and a cascade has to be
 *                    able to see it.
 *
 * One `Record` keyed by the union rather than several hand-kept lists, because a
 * status this file does not know about is a poisoned descendant that keeps its
 * outputs spendable. Keyed that way, a status added or removed upstream is a
 * compile error here; the partition below is pinned by tests as well, so a
 * reclassification is caught too. Note `unfail`: `ProvenTxReqTerminalStatus` is
 * only `['completed','invalid','doubleSpend']` (`sdk/types.js:7`), so a request
 * being resurrected is undecided and must not be overlooked.
 */
const reqStatusVerdicts: Record<ProvenTxReqStatus, 'success' | 'doubleSpend' | 'invalidTx' | 'undecided'> = {
  unmined: 'success',
  callback: 'success',
  unconfirmed: 'success',
  completed: 'success',
  doubleSpend: 'doubleSpend',
  invalid: 'invalidTx',
  sending: 'undecided',
  unsent: 'undecided',
  nosend: 'undecided',
  unknown: 'undecided',
  nonfinal: 'undecided',
  unprocessed: 'undecided',
  unfail: 'undecided'
}

function statusesVerdicted(...verdicts: (typeof reqStatusVerdicts)[ProvenTxReqStatus][]): ProvenTxReqStatus[] {
  const keys = Object.keys(reqStatusVerdicts) as ProvenTxReqStatus[]
  return keys.filter(s => verdicts.includes(reqStatusVerdicts[s]))
}

/** Every request status there is, so a test can prove the partition is complete. */
export const allReqStatuses: readonly ProvenTxReqStatus[] = Object.keys(reqStatusVerdicts) as ProvenTxReqStatus[]

/** Statuses that mean the transaction has already been handed to the network. */
export const alreadySentStatuses: readonly ProvenTxReqStatus[] = statusesVerdicted('success')

/** Statuses that already carry a recorded refusal. */
export const refusedReqStatuses: readonly ProvenTxReqStatus[] = statusesVerdicted('doubleSpend', 'invalidTx')

/**
 * Statuses carrying no verdict yet.
 *
 * This is the set a cascade must widen its graph over: the wallet re-spent money
 * it received underground, and Task 8 leaves such an outgoing request to
 * `TaskSendWaiting` rather than parking it, so nothing put that transaction in the
 * queue or in any held beef. A status wrongly missing from here is a poisoned
 * descendant that keeps its outputs spendable.
 */
export const undecidedReqStatuses: ProvenTxReqStatus[] = statusesVerdicted('undecided')

/**
 * The verdict already recorded against a request in storage, or undefined if the
 * request still needs posting.
 *
 * Used twice: before a post, to skip a request a previous interrupted run had
 * already got out (or already had refused); and after one, as the authority on
 * whether the post landed. An unrecognised status reads as undecided, which
 * neither claims delivery nor rejects anything.
 */
export function outcomeFromReqStatus(status: string | undefined): PostOutcome | undefined {
  if (status === undefined) return undefined
  const verdict = reqStatusVerdicts[status as ProvenTxReqStatus]
  return verdict === undefined || verdict === 'undecided' ? undefined : verdict
}

/**
 * Read the result of posting a transaction this wallet owns.
 *
 * Storage decides delivery, not the returned status. A `'success'` from
 * `attemptToPostReqsToNetwork` can also come from an offline hold, which means
 * "accepted for delivery" rather than "the network has it"; if connectivity drops
 * between this engine's own online check and its post, that is precisely what
 * comes back. A real broadcast always leaves the request at 'unmined'
 * (`attemptToPostReqsToNetwork.js:236-239`), so requiring that persisted status
 * cannot mistake a hold for a delivery — and the safe direction of the remaining
 * doubt is 'serviceError', which retries and never rejects.
 *
 * A failure is believed from either witness: `reqStatus` catches the case where
 * the post reported no verdict because storage had already recorded one.
 */
export function outcomeOfOwnedPost(args: { detailStatus?: string; reqStatus?: string }): PostOutcome {
  const recorded = outcomeFromReqStatus(args.reqStatus)
  if (recorded !== undefined) return recorded
  if (args.detailStatus === 'doubleSpend') return 'doubleSpend'
  if (args.detailStatus === 'invalid' || args.detailStatus === 'invalidTx') return 'invalidTx'
  return 'serviceError'
}

/** One service's per-txid outcome. Structurally satisfied by `PostTxResultForTxid`. */
export interface PostedTxidResult {
  txid: string
  status: string
  /** The service already had this transaction, which its own docs say to read as success. */
  alreadyKnown?: boolean
  doubleSpend?: boolean
}

/** One service's reply. Structurally satisfied by `PostBeefResult`. */
export interface PostedResult {
  txidResults: PostedTxidResult[]
}

/**
 * Read the result of posting a foreign ancestor, which has no request here to
 * record a verdict on, so the reply is the only witness there is.
 *
 * A double spend outranks a success, matching the toolbox's own aggregate
 * (`attemptToPostReqsToNetwork.js:174-181`) so the codebase has one rule for it.
 *
 * A plain error is never read as invalidity. This ancestor arrived inside a BEEF
 * that `internalizeAction` had already verified — scripts and SPV both — so a
 * bare rejection is far more likely to mean our merged BEEF is missing bytes
 * this service needed than that the transaction is bad, and rejecting it would
 * cascade into money the user legitimately holds. Left retryable, the drain
 * simply stalls, which loses nothing.
 */
export function outcomeOfForeignPost(args: { txid: string; results: PostedResult[] }): PostOutcome {
  let success = false
  for (const result of args.results) {
    for (const r of result.txidResults) {
      if (r.txid !== args.txid) continue
      if (r.doubleSpend === true) return 'doubleSpend'
      if (r.status === 'success' || r.alreadyKnown === true) success = true
    }
  }
  return success ? 'success' : 'serviceError'
}
