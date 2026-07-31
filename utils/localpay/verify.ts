import { P2PKH, PublicKey, Transaction } from '@bsv/sdk'
import type { PaymentFrame } from './codec'
import { PEERPAY_PROTOCOL_ID } from './pending'
import { isRequestableAmount } from './session'

/**
 * Why a frame could not be shown to pay this device.
 *
 * Two kinds, because the payee's decline reason differs: bytes that are not a
 * transaction are a decode problem the payer can retry from, whereas a
 * transaction that pays someone else is a frame that was never for us.
 */
export type FrameVerifyKind = 'unparseable' | 'not_mine'

export class FrameVerifyError extends Error {
  readonly kind: FrameVerifyKind
  constructor(kind: FrameVerifyKind, message: string) {
    super(message)
    this.name = 'FrameVerifyError'
    this.kind = kind
  }
}

/** The one wallet capability this module needs: BRC-42 derivation. */
export interface DerivingWallet {
  getPublicKey(args: unknown, originator?: string): Promise<{ publicKey: string }>
}

/**
 * The satoshis a delivered frame actually pays this device.
 *
 * `internalizeAction` credits the output, not any field beside it, so the
 * figure a payee renders as a receipt has to come from the transaction — and
 * is only worth reading once the output is shown to be ours. The derivation
 * below is the payee-side mirror of the payer's in `build.ts`: same protocol,
 * same keyID, same counterparty, `forSelf` flipped. If the script matches, the
 * output is spendable by this device and its satoshi count is the payment.
 *
 * Throws on every failure and returns on none, so a caller cannot mistake a
 * refusal for a zero-value payment. MUST be called before the settle path
 * latches or writes anything: every throw here has to remain a provable
 * "queued nothing" decline.
 */
export async function verifyFramePayment(
  wallet: DerivingWallet,
  frame: PaymentFrame,
  originator: string
): Promise<{ satoshis: number }> {
  let tx: Transaction
  try {
    tx = Transaction.fromAtomicBEEF(frame.transaction)
  } catch (e) {
    throw new FrameVerifyError('unparseable', `frame transaction is not readable AtomicBEEF: ${messageOf(e)}`)
  }

  const output = tx.outputs[frame.outputIndex]
  if (!output) {
    throw new FrameVerifyError(
      'unparseable',
      `frame names outputIndex ${frame.outputIndex}, but the transaction has ${tx.outputs.length} outputs`
    )
  }

  const { publicKey } = await wallet.getPublicKey(
    {
      protocolID: PEERPAY_PROTOCOL_ID,
      keyID: `${frame.derivationPrefix} ${frame.derivationSuffix}`,
      counterparty: frame.senderIdentityKey,
      forSelf: true
    },
    originator
  )

  let expected: string
  try {
    expected = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex()
  } catch (e) {
    // The derived key is ours and should always parse; a failure here means we
    // cannot say the output is ours, which is the same refusal either way.
    throw new FrameVerifyError('not_mine', `could not derive this device’s expected script: ${messageOf(e)}`)
  }

  if (output.lockingScript.toHex() !== expected) {
    throw new FrameVerifyError('not_mine', 'the named output does not pay this device')
  }

  // Optional on the SDK type, and a zero or fractional value would render as a
  // receipt for money that never moved.
  if (!isRequestableAmount(output.satoshis)) {
    throw new FrameVerifyError('not_mine', `the named output carries no usable satoshi value: ${output.satoshis}`)
  }

  return { satoshis: output.satoshis }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
