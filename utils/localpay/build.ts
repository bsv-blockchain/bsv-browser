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
}

/**
 * Builds the frame a payer sends. BRC-29: the output locks to a key derived
 * for the payee from the session's derivation nonces.
 */
export async function buildPaymentFrame(
  wallet: PayingWallet,
  session: Session,
  transportKind: 'awdl' | 'qr',
  originator: string
): Promise<PaymentFrame> {
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
      options: { randomizeOutputs: false, noSend: true },
    },
    originator
  )

  // createAction may return an unsigned `signableTransaction` instead of a
  // final `tx` when signing is deferred — reachable via WalletPermissionsManager
  // after a spending-authorization grant (same failure mode as the 402 flow in
  // utils/webview/bsvPaymentHandler.ts). We have no caller-supplied inputs — all
  // inputs are wallet-funded — so finalize by signing with empty `spends`.
  // noSend stays true: the payee internalizes and broadcasts, not the payer.
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
    version: FRAME_VERSION,
    senderIdentityKey,
    amount: session.amount,
    outputIndex: 0,
    derivationPrefix: session.derivationPrefix,
    derivationSuffix: session.derivationSuffix,
    transaction: new Uint8Array(result.tx),
  }
}
