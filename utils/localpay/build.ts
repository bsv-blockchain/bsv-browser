import { P2PKH, PublicKey } from '@bsv/sdk'
import { FRAME_VERSION, type PaymentFrame } from './codec'
import type { Session } from './session'
import { PEERPAY_LABEL, PEERPAY_PROTOCOL_ID } from './pending'

interface PayingWallet {
  getPublicKey(args: unknown, originator?: string): Promise<{ publicKey: string }>
  createAction(args: unknown, originator?: string): Promise<{
    tx?: number[]
    txid?: string
    signableTransaction?: { reference: string }
  }>
  signAction(args: unknown, originator?: string): Promise<{ tx?: number[]; txid?: string }>
  /**
   * Releases the inputs a `noSend` action is holding. Required, not optional:
   * without it an abandoned build locks `amount + fee` in the payer's wallet
   * permanently — see BuiltPayment.reference.
   */
  abortAction(args: { reference: string }, originator?: string): Promise<{ aborted: boolean }>
}

/** A signed, undelivered payment plus the handle needed to unwind it. */
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
}

/**
 * Builds the frame a payer sends. BRC-29: the output locks to a key derived
 * for the payee from the session's derivation nonces.
 *
 * The transaction is AtomicBEEF on both transports. The QR path was originally
 * specified as bare rawtx to shrink the symbol, but the payee needs ancestry to
 * internalize offline, and MAX_FRAME_QR_CHARS already rejects frames too large
 * to render — so one encoding serves both paths.
 */
export async function buildPaymentFrame(
  wallet: PayingWallet,
  session: Session,
  originator: string
): Promise<BuiltPayment> {
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
          satoshis: session.amount,
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
      senderIdentityKey,
      amount: session.amount,
      outputIndex: 0,
      derivationPrefix: session.derivationPrefix,
      derivationSuffix: session.derivationSuffix,
      transaction: new Uint8Array(result.tx),
    },
    reference,
  }
}
