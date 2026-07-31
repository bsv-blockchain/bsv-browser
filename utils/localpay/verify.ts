import { BigNumber, Curve, Hash, P2PKH, PublicKey, Transaction, Utils } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import type { PaymentFrame } from './codec'
import { PEERPAY_PROTOCOL_ID } from './pending'
import { isRequestableAmount } from './session'

// mandala's FT derivation protocol — the payer locks token outputs under it
// with OUR payee-minted nonces as keyID, preserving the frame-to-session binding
export const FT_PROTOCOL_ID: [2, string] = [2, 'mandala token']

export type VerifiedPayment =
  | { kind: 'bsv'; satoshis: number }
  | { kind: 'token'; assetId: string; amount: number }

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
): Promise<VerifiedPayment> {
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

  if (frame.kind === 'bsv') {
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

    return { kind: 'bsv', satoshis: output.satoshis }
  }

  if (!frame.token) throw new FrameVerifyError('unparseable', 'token frame without token block')

  let decoded: { assetId: string; amount: number; pubKeyHash: number[] }
  try {
    decoded = MandalaToken.decode(output.lockingScript)
  } catch (e) {
    throw new FrameVerifyError('not_mine', `the named output is not a token script: ${messageOf(e)}`)
  }
  if (decoded.assetId !== frame.token.assetId) {
    throw new FrameVerifyError('not_mine', 'the output moves a different asset than the frame declares')
  }
  const { publicKey } = await wallet.getPublicKey(
    {
      protocolID: FT_PROTOCOL_ID,
      keyID: `${frame.derivationPrefix} ${frame.derivationSuffix}`,
      counterparty: frame.senderIdentityKey,
      forSelf: true
    },
    originator
  )
  const expectedPkh = Hash.hash160(Utils.toArray(publicKey, 'hex'))
  const mine = decoded.pubKeyHash.length === expectedPkh.length &&
    decoded.pubKeyHash.every((b, i) => b === expectedPkh[i])
  if (!mine) throw new FrameVerifyError('not_mine', 'the named token output does not pay this device')
  if (!Number.isSafeInteger(decoded.amount) || decoded.amount < 1) {
    throw new FrameVerifyError('not_mine', `the named output carries no usable token amount: ${decoded.amount}`)
  }
  return { kind: 'token', assetId: decoded.assetId, amount: decoded.amount }
}

/** The one wallet capability `verifyRecipientLinkage` needs: BRC-72 decryption. */
export interface LinkageDecryptingWallet {
  decrypt(args: unknown, originator?: string): Promise<{ plaintext: number[] }>
}

/**
 * Prove the payer minted honest linkage for OUR output: decrypt the
 * BRC-72 blob (we are its verifier), recover derivedKey = counterparty +
 * L·G, and require its hash160 to equal the output's pubKeyHash. This
 * shows the payer CAN produce valid linkage — the overlay's own verdict
 * at submission remains the real admission gate.
 */
export async function verifyRecipientLinkage(
  wallet: LinkageDecryptingWallet,
  recipientLinkage: Uint8Array,
  expectedPubKeyHash: number[],
  originator: string
): Promise<void> {
  let linkage: {
    prover: string; counterparty: string
    protocolID: [number, string]; keyID: string; encryptedLinkage: number[]
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(recipientLinkage)) as Record<string, unknown>
    if (
      typeof parsed.prover !== 'string' || parsed.prover.length !== 66 ||
      typeof parsed.counterparty !== 'string' || parsed.counterparty.length !== 66 ||
      !Array.isArray(parsed.protocolID) || typeof parsed.keyID !== 'string' ||
      !Array.isArray(parsed.encryptedLinkage)
    ) throw new Error('missing linkage fields')
    linkage = parsed as typeof linkage
  } catch (e) {
    throw new FrameVerifyError('unparseable', `recipientLinkage is not a readable SpecificLinkage: ${messageOf(e)}`)
  }
  let plaintext: number[]
  try {
    ;({ plaintext } = await wallet.decrypt(
      {
        ciphertext: linkage.encryptedLinkage,
        protocolID: [2, `specific linkage revelation ${linkage.protocolID[0]} ${linkage.protocolID[1]}`],
        keyID: linkage.keyID,
        counterparty: linkage.prover
      },
      originator
    ))
  } catch (e) {
    throw new FrameVerifyError('not_mine', `recipientLinkage did not decrypt for this device: ${messageOf(e)}`)
  }
  let derivedPkh: number[]
  try {
    const curve = new Curve()
    const sum = PublicKey.fromString(linkage.counterparty).add(curve.g.mul(new BigNumber(plaintext)))
    derivedPkh = Hash.hash160(Utils.toArray(new PublicKey(sum.x, sum.y).toString(), 'hex'))
  } catch (e) {
    // `linkage.counterparty` is 66 hex chars by the shape check above, but
    // hex-shaped is not curve-valid: hostile JSON can still name a point this
    // library refuses to parse or add. That is a platform Error, not a
    // FrameVerifyError, so it must be caught here to keep this module's
    // every-failure-is-FrameVerifyError contract.
    throw new FrameVerifyError('not_mine', `recipientLinkage counterparty key is unusable: ${messageOf(e)}`)
  }
  const matches = derivedPkh.length === expectedPubKeyHash.length &&
    derivedPkh.every((b, i) => b === expectedPubKeyHash[i])
  if (!matches) throw new FrameVerifyError('not_mine', 'recipientLinkage does not control the paid output')
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
