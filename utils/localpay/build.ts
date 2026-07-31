import { P2PKH, PublicKey } from '@bsv/sdk'
import { FRAME_VERSION, type PaymentFrame } from './codec'
import { isRequestableAmount, type Session } from './session'
import { PEERPAY_LABEL, PEERPAY_PROTOCOL_ID } from './pending'
import type { Ack } from './transport/types'
import { getOnline } from '@/utils/net/online'

/** The toolbox's per-txid verdict on a `sendWith` release. */
type SendWithStatus = 'unproven' | 'sending' | 'failed'

interface CreateActionOutcome {
  tx?: number[]
  txid?: string
  signableTransaction?: { reference: string }
  sendWithResults?: { txid: string; status: string }[]
}

interface PayingWallet {
  getPublicKey(args: unknown, originator?: string): Promise<{ publicKey: string }>
  createAction(args: unknown, originator?: string): Promise<CreateActionOutcome>
  signAction(args: unknown, originator?: string): Promise<{ tx?: number[]; txid?: string }>
  /**
   * Releases the inputs a `noSend` action is holding. Required, not optional:
   * without it an abandoned build locks `amount + fee` in the payer's wallet
   * permanently — see BuiltPayment.reference.
   */
  abortAction(args: { reference: string }, originator?: string): Promise<{ aborted: boolean }>
}

/** A signed, undelivered payment plus the handles needed to unwind or release it. */
export interface BuiltPayment {
  frame: PaymentFrame
  /**
   * The `createAction` reference, for `abortAction`.
   *
   * The action is created `noSend`, which marks its inputs `spendable: false`.
   * The storage sweeper (`TaskFailAbandoned`) only reaps `unprocessed` and
   * `unsigned` actions — NOT `nosend` — so a build that is never delivered
   * locks `amount + fee` forever and silently. Callers MUST abort on every
   * path where the frame provably never left the device, and MUST NOT abort
   * once delivery is even possible: the payee may still broadcast, and
   * aborting frees inputs the payer's wallet would then respend.
   *
   * Undefined only if a wallet finalises `createAction` itself without
   * surfacing a reference; nothing can be aborted in that case.
   */
  reference?: string
  /**
   * The txid of the signed `noSend` transaction, for `broadcastPayment`.
   *
   * `options.sendWith` addresses a withheld action by txid, not by reference,
   * so this is the only handle that can release it. Undefined only if a wallet
   * returns no txid from either `createAction` or `signAction`; the action then
   * cannot be broadcast by the payer at all.
   */
  txid?: string
}

/**
 * What became of a delivered payment, from the payer's side.
 *
 * `broadcast: 'pending'` is NOT a failed payment. It means the payee acked
 * positively — the money is durably queued there and will be internalized —
 * but this device could not get the transaction out itself.
 */
export type DeliveryOutcome =
  | { kind: 'sent'; broadcast: 'ok' | 'pending'; detail?: string }
  | { kind: 'declined'; reason?: string }

/**
 * Builds the frame a payer sends. BRC-29: the output locks to a key derived
 * for the payee from the session's derivation nonces.
 *
 * The transaction is AtomicBEEF on both transports. The QR path was originally
 * specified as bare rawtx to shrink the symbol, but the payee needs ancestry to
 * internalize offline, and the fountain removed the symbol-size ceiling that
 * made a smaller QR payload worth having — so one encoding serves both paths.
 *
 * `amount` is passed in rather than read off the session because the session's
 * own amount is optional: on an open request the payer chooses. Making it an
 * explicit argument means the one figure that becomes a real output — and the
 * one the payee binds its settle check to — is chosen at exactly one call site
 * and cannot silently fall back to `undefined` satoshis. It is validated here
 * rather than trusted, since a fractional or negative value reaching
 * createAction is a malformed transaction, not a UI glitch.
 */
export async function buildPaymentFrame(
  wallet: PayingWallet,
  session: Session,
  originator: string,
  amount: number
): Promise<BuiltPayment> {
  if (!isRequestableAmount(amount)) {
    throw new Error('amount must be a positive whole number of satoshis')
  }
  // A payee that named a figure is stating a binding term of the request, and
  // its settle path refuses anything else. Catching the disagreement here — on
  // the payer, before an action exists — turns a burnt build and a remote
  // decline into a plain refusal with nothing to unwind.
  if (session.amount !== undefined && session.amount !== amount) {
    throw new Error('amount does not match the payee’s request')
  }

  const { publicKey: senderIdentityKey } = await wallet.getPublicKey({ identityKey: true }, originator)

  const { publicKey: derived } = await wallet.getPublicKey(
    {
      protocolID: PEERPAY_PROTOCOL_ID,
      keyID: `${session.derivationPrefix} ${session.derivationSuffix}`,
      counterparty: session.identityKey,
      forSelf: false,
    },
    originator
  )

  const lockingScript = new P2PKH()
    .lock(PublicKey.fromString(derived).toAddress())
    .toHex()

  let result = await wallet.createAction(
    {
      description: 'Payment to a nearby device',
      labels: [PEERPAY_LABEL],
      outputs: [
        {
          lockingScript,
          satoshis: amount,
          outputDescription: 'Nearby payment',
        },
      ],
      // `signAndProcess: false` is what makes the action abortable.
      //
      // WalletPermissionsManager forces signAndProcess=false on the underlying
      // wallet regardless, so the transaction built here is byte-identical
      // either way. What changes is who finalises it: left unset, the manager
      // calls signAction itself and returns `signableTransaction: undefined`,
      // discarding the only reference the wallet ever emits. Asking for the
      // deferred result keeps that reference, so an abandoned build can release
      // its inputs instead of locking them forever.
      options: { randomizeOutputs: false, noSend: true, signAndProcess: false },
    },
    originator
  )

  const reference = result.signableTransaction?.reference

  // With signAndProcess disabled, createAction returns an unsigned
  // `signableTransaction` rather than a final `tx`. We have no caller-supplied
  // inputs — all inputs are wallet-funded — so finalize by signing with empty
  // `spends`, the same shape the 402 flow uses in
  // utils/webview/bsvPaymentHandler.ts. noSend stays true: the payee
  // internalizes and broadcasts, not the payer.
  if (!result.tx && result.signableTransaction) {
    const signed = await wallet.signAction(
      {
        reference: result.signableTransaction.reference,
        spends: {},
        options: { noSend: true },
      },
      originator
    )
    result = { ...result, ...signed }
  }

  if (!result.tx) throw new Error('createAction returned no transaction')

  return {
    frame: {
      version: FRAME_VERSION,
      kind: 'bsv' as const,
      senderIdentityKey,
      outputIndex: 0,
      derivationPrefix: session.derivationPrefix,
      derivationSuffix: session.derivationSuffix,
      transaction: new Uint8Array(result.tx),
    },
    reference,
    txid: result.txid,
  }
}

/**
 * Releases the `noSend` payment identified by `txid` so this device broadcasts it.
 *
 * BRC-100 releases a previously withheld action by naming its txid in
 * `options.sendWith` on a follow-up `createAction` that creates nothing of its
 * own. Verified end to end in @bsv/wallet-toolbox-mobile / @bsv/sdk:
 *
 *  · sdk validationHelpers.js:458-460 — `isSendWith = sendWith.length > 0`, and
 *    `isNewTx` stays FALSE when there are no inputs and no outputs, so this
 *    builds nothing. `description` is still mandatory (5–2000 bytes, :438).
 *  · signer/methods/createAction.js:10-46 — with `isNewTx` false it skips
 *    straight to `processAction`, whose args carry `sendWith` and a null
 *    reference/txid/rawTx.
 *  · storage/methods/processAction.js:26 — the sendWith txids become
 *    `txidsOfReqsToShareWithWorld` and go to `shareReqsWithWorld`.
 *  · storage/storageProviderHelpers.js:14 — `readyToSendStatuses` includes
 *    'nosend', so a withheld req classifies as `readyToSend` (:28-35) →
 *    `SendWithResult.status = 'sending'` (processAction.js:64-66).
 *  · processAction.js:127-136 — on the default delayed path the req moves to
 *    'unsent' and the transaction to 'sending'. That is the escape from
 *    'nosend': monitor/tasks/TaskFailAbandoned.js:35 only ever sweeps
 *    ['unprocessed', 'unsigned'], so nothing else would have moved it.
 *
 * Reaching this through WalletPermissionsManager raises no prompt and cannot
 * abort the action: with no inputs or outputs the underlying createAction
 * returns no `signableTransaction`, and the manager returns at
 * WalletPermissionsManager.js:2856 before its spending-authorization gate.
 *
 * Throws when the toolbox reports 'failed' for this txid. Callers must treat
 * that as retryable, never as a failed payment — see finalizeDelivery.
 */
export async function broadcastPayment(
  wallet: PayingWallet,
  txid: string,
  originator: string
): Promise<SendWithStatus | undefined> {
  const result = await wallet.createAction(
    {
      // Mandatory even though this creates nothing; must be 5–2000 bytes.
      description: 'Broadcast a nearby payment',
      options: { sendWith: [txid] },
    },
    originator
  )
  const status = result.sendWithResults?.find(r => r.txid === txid)?.status
  if (status === 'failed') {
    throw new Error(`the wallet could not broadcast ${txid}`)
  }
  return status === 'unproven' || status === 'sending' ? status : undefined
}

/**
 * The payer's post-delivery decision. Extracted from the screen so the whole
 * state machine is testable, because it is the point where real money is
 * either released or reclaimed.
 *
 *   POSITIVE ack — the payee has DURABLY QUEUED the payment. Broadcast now.
 *     Never abort: the payee holds a copy and will internalize it, and freeing
 *     the inputs here lets this wallet respend them into a conflict.
 *
 *   NEGATIVE ack — the payee provably queued nothing (see DeclineReason).
 *     Abort to release the inputs, and never broadcast.
 *
 *   NO ack (a throw from the transport) — not this function's business. The
 *     caller must neither abort nor broadcast: a lost ack does not prove
 *     non-delivery, so the frame may still be with the payee.
 *
 * A broadcast failure after a positive ack returns `broadcast: 'pending'`, not
 * a failure. The money is safe at the payee; what is stuck is this device's
 * copy of the transaction, which is a retryable notice, not a failed payment.
 *
 * OFFLINE: with no network there is nothing to broadcast to, so a positive ack
 * enqueues instead. The transaction is promoted from `nosend` to `unproven` by
 * the hold, which is what lets the payer fund a SECOND offline payment from this
 * one's change — `allocateChangeInput` excludes `nosend`
 * (storage/StorageExpoSQLite.ts:1284). The outcome is the existing
 * `broadcast: 'pending'`, which the UI already renders as "queued", so no new
 * state reaches the screens. `deps` is injected — not read from `@/utils/net/online`
 * or a database directly — so this stays unit-testable without either; the real
 * app supplies both at the NearbyFlow call site.
 */
export async function finalizeDelivery(
  wallet: PayingWallet,
  built: BuiltPayment,
  ack: Ack,
  originator: string,
  /**
   * Required, and so is `hold` inside it, because the offline branch cannot
   * honestly report a queue it has no way to make. A call site that omitted it
   * would leave the transaction at `nosend` — change unspendable, no queue row,
   * no monitor task that sweeps it — while telling the user it was waiting to be
   * broadcast. `online` stays optional: its default is the real probe, and
   * getting that wrong costs a retry rather than a stranded payment.
   */
  deps: {
    online?: () => Promise<boolean>
    /** Promotes the transaction to `unproven` and queues the txid for release. */
    hold: (txid: string) => Promise<void>
  }
): Promise<DeliveryOutcome> {
  if (!ack.ok) {
    if (built.reference) {
      // Fire and forget: a failed abort is a stuck UTXO, not a lost payment,
      // and must not displace the decline reason the caller is about to show.
      await wallet
        .abortAction({ reference: built.reference }, originator)
        .catch((e: unknown) => console.warn('[localpay] abortAction failed:', messageOf(e)))
    }
    return { kind: 'declined', reason: ack.error }
  }

  if (!built.txid) {
    return { kind: 'sent', broadcast: 'pending', detail: 'the wallet returned no txid to broadcast' }
  }

  const online = deps?.online ?? getOnline
  // A failed connectivity probe must not change what this function does: assume
  // online and fall through to the ordinary broadcast, which is exactly what ran
  // before this branch existed. If the device is genuinely offline, that attempt
  // fails on its own and lands on the same `broadcast: 'pending'` the hold would
  // have returned anyway — so a probe failure costs nothing either way. This
  // mirrors the same guard already used around every other call to `getOnline`
  // in this codebase (`StorageExpoSQLite.attemptToPostReqsToNetwork`,
  // `processOfflineActions.probeOnline`).
  let isOnline = true
  try {
    isOnline = await online()
  } catch (e) {
    console.warn('[localpay] connectivity probe failed, assuming online:', messageOf(e))
  }
  if (!isOnline) {
    try {
      // The signature requires `hold`; this catches a JS caller or a cast that
      // got past it. Reported rather than ignored, and deliberately NOT fallen
      // through to the broadcast: offline, a delayed `sendWith` comes back
      // 'sending', which this function reports as `broadcast: 'ok'` — green on
      // the payer's screen for a transaction nothing has.
      if (typeof deps?.hold !== 'function') {
        throw new Error('offline, and no hold was supplied to queue this payment with')
      }
      await deps.hold(built.txid)
      return { kind: 'sent', broadcast: 'pending', detail: 'offline — queued until this device reconnects' }
    } catch (e) {
      // The payee holds a copy and will internalize it, so this is still a sent
      // payment — never a failure. But be honest about what a failed hold
      // actually costs: nothing re-drives it. No monitor task sweeps a plain
      // `nosend` transaction to broadcast it (`TaskSendWaiting` selects only
      // `['unsent','sending']`; `TaskCheckNoSends`, the only task that even
      // reads `nosend` rows, only checks whether one got mined by some OTHER
      // means — it never calls `sendWith`), and `processOfflineActions`'s
      // drain only ever looks at `offline_actions` rows, so a hold that threw
      // before its own writes landed is invisible to it too. See
      // `holdSentPaymentOffline` for why its queue-row insert runs before its
      // status promotion, which is what keeps a partial failure recoverable.
      return { kind: 'sent', broadcast: 'pending', detail: messageOf(e) }
    }
  }

  try {
    await broadcastPayment(wallet, built.txid, originator)
    return { kind: 'sent', broadcast: 'ok' }
  } catch (e) {
    return { kind: 'sent', broadcast: 'pending', detail: messageOf(e) }
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error && e.message ? e.message : String(e)
}
