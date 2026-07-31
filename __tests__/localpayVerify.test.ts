/**
 * What a delivered frame actually pays this device.
 *
 * The figure a payee renders as a receipt has to come from the transaction
 * `internalizeAction` will credit, and is only worth reading once that output
 * is shown to lock to a key this device derives. These tests pin both halves,
 * and in particular the hole the module closes: correct derivation nonces with
 * an output paying somebody else.
 */
import { Beef, BigNumber, Curve, Hash, LockingScript, P2PKH, PrivateKey, PublicKey, Transaction, Utils } from '@bsv/sdk'
import { FrameVerifyError, FT_PROTOCOL_ID, verifyFramePayment, verifyRecipientLinkage } from '@/utils/localpay/verify'
import { PEERPAY_PROTOCOL_ID } from '@/utils/localpay/pending'
import type { PaymentFrame } from '@/utils/localpay/codec'
import { MandalaToken } from '@bsv/templates'

const payeeKey = PrivateKey.fromRandom().toPublicKey()
const senderIdentityKey = '02' + 'ab'.repeat(32)

/** The script a correct payer produces for this payee and these nonces. */
function minesScript(): string {
  return new P2PKH().lock(payeeKey.toAddress()).toHex()
}

/** A real AtomicBEEF carrying `outputs`, in order. */
function beefOf(outputs: { satoshis: number; scriptHex: string }[]): Uint8Array {
  const tx = new Transaction()
  for (const o of outputs) {
    tx.addOutput({ satoshis: o.satoshis, lockingScript: LockingScript.fromHex(o.scriptHex) })
  }
  const beef = new Beef()
  beef.mergeTransaction(tx)
  return new Uint8Array(beef.toBinaryAtomic(tx.id('hex')))
}

function frameFor(transaction: Uint8Array, outputIndex = 0): PaymentFrame {
  return {
    version: 1,
    kind: 'bsv' as const,
    senderIdentityKey,
    amount: 0, // still on the type at this task; unread by verify
    outputIndex,
    derivationPrefix: 'cHJlZml4',
    derivationSuffix: 'c3VmZml4',
    transaction
  } as PaymentFrame
}

/** A payee wallet that derives exactly one key, and records how it was asked. */
function payeeWallet() {
  return {
    getPublicKey: jest.fn(async () => ({ publicKey: payeeKey.toString() }))
  }
}

describe('verifyFramePayment', () => {
  it('returns the satoshis of the output that locks to this device’s derived key', async () => {
    const frame = frameFor(beefOf([{ satoshis: 4200, scriptHex: minesScript() }]))
    await expect(verifyFramePayment(payeeWallet(), frame, 'admin.com')).resolves.toEqual({ kind: 'bsv', satoshis: 4200 })
  })

  it('derives with the payee’s own key, keyed by the frame’s nonces and the sender', async () => {
    const w = payeeWallet()
    await verifyFramePayment(w, frameFor(beefOf([{ satoshis: 1, scriptHex: minesScript() }])), 'admin.com')
    expect(w.getPublicKey).toHaveBeenCalledWith(
      {
        protocolID: PEERPAY_PROTOCOL_ID,
        keyID: 'cHJlZml4 c3VmZml4',
        counterparty: senderIdentityKey,
        forSelf: true
      },
      'admin.com'
    )
  })

  it('reads the output named by outputIndex, not the first one', async () => {
    const transaction = beefOf([
      { satoshis: 9, scriptHex: '76a914' + '00'.repeat(20) + '88ac' },
      { satoshis: 777, scriptHex: minesScript() }
    ])
    await expect(verifyFramePayment(payeeWallet(), frameFor(transaction, 1), 'admin.com')).resolves.toEqual({
      kind: 'bsv',
      satoshis: 777
    })
  })

  // The hole this module closes: correct nonces, an output paying someone else.
  // Accepting it acks ok, the payer broadcasts, and the payee is credited nothing.
  it('refuses an output that pays a stranger', async () => {
    const transaction = beefOf([{ satoshis: 4200, scriptHex: '76a914' + '11'.repeat(20) + '88ac' }])
    await expect(verifyFramePayment(payeeWallet(), frameFor(transaction), 'admin.com')).rejects.toMatchObject({
      name: 'FrameVerifyError',
      kind: 'not_mine'
    })
  })

  it('refuses a zero-satoshi output', async () => {
    const transaction = beefOf([{ satoshis: 0, scriptHex: minesScript() }])
    await expect(verifyFramePayment(payeeWallet(), frameFor(transaction), 'admin.com')).rejects.toMatchObject({
      kind: 'not_mine'
    })
  })

  // `satoshis` is optional on the SDK's output type but mandatory in anything
  // that serializes, so a real AtomicBEEF cannot carry an absent value — the
  // guard is against the type, and this is the only way to reach it.
  it('refuses an output whose satoshis are absent', async () => {
    const tx = new Transaction()
    tx.addOutput({ satoshis: 4200, lockingScript: LockingScript.fromHex(minesScript()) })
    tx.outputs[0].satoshis = undefined
    const spy = jest.spyOn(Transaction, 'fromAtomicBEEF').mockReturnValue(tx)
    try {
      await expect(
        verifyFramePayment(payeeWallet(), frameFor(new Uint8Array([1])), 'admin.com')
      ).rejects.toMatchObject({ kind: 'not_mine' })
    } finally {
      spy.mockRestore()
    }
  })

  it('treats unreadable transaction bytes as a decode failure, not a mismatch', async () => {
    const frame = frameFor(new Uint8Array([1, 2, 3, 4, 5]))
    await expect(verifyFramePayment(payeeWallet(), frame, 'admin.com')).rejects.toMatchObject({
      kind: 'unparseable'
    })
  })

  it('treats an outputIndex past the end as a decode failure', async () => {
    const frame = frameFor(beefOf([{ satoshis: 4200, scriptHex: minesScript() }]), 3)
    await expect(verifyFramePayment(payeeWallet(), frame, 'admin.com')).rejects.toMatchObject({
      kind: 'unparseable'
    })
  })

  it('surfaces a wallet that cannot derive as an error, never as a pass', async () => {
    const w = { getPublicKey: jest.fn(async () => Promise.reject(new Error('locked'))) }
    await expect(
      verifyFramePayment(w as never, frameFor(beefOf([{ satoshis: 1, scriptHex: minesScript() }])), 'admin.com')
    ).rejects.toThrow('locked')
  })

  it('is a FrameVerifyError, so callers can switch on kind', async () => {
    const err = await verifyFramePayment(payeeWallet(), frameFor(new Uint8Array([0])), 'admin.com').catch(e => e)
    expect(err).toBeInstanceOf(FrameVerifyError)
  })
})

const ASSET_ID = 'ab'.repeat(32) + '.0'
const payeePkh = () => Hash.hash160(Utils.toArray(payeeKey.toString(), 'hex'))

function tokenScript(amount: number, pkh: number[] = payeePkh()): string {
  return new MandalaToken().lock(ASSET_ID, amount, pkh).toHex()
}

const tokenFrame = (overrides: Partial<PaymentFrame> = {}): PaymentFrame => ({
  version: 3,
  kind: 'token',
  senderIdentityKey,
  outputIndex: 0,
  derivationPrefix: 'p',
  derivationSuffix: 'x',
  token: {
    assetId: ASSET_ID,
    overlayUrl: 'https://overlay.issuer.example',
    overlayIdentityKey: '03'.padEnd(66, 'b'),
    certificates: [],
    linkage: [],
    recipientLinkage: new Uint8Array([1]),
  },
  transaction: beefOf([{ satoshis: 1, scriptHex: tokenScript(500) }]),
  ...overrides,
})

describe('verifyFramePayment: token kind', () => {
  it('returns the decoded token amount and assetId for an output locked to this device', async () => {
    const result = await verifyFramePayment(payeeWallet(), tokenFrame(), 'test')
    expect(result).toEqual({ kind: 'token', assetId: ASSET_ID, amount: 500 })
  })

  it('derives with the mandala FT protocol, not PEERPAY', async () => {
    const wallet = payeeWallet()
    await verifyFramePayment(wallet, tokenFrame(), 'test')
    expect(wallet.getPublicKey).toHaveBeenCalledWith(
      expect.objectContaining({ protocolID: FT_PROTOCOL_ID, forSelf: true }),
      'test'
    )
  })

  it('refuses a token output locked to someone else as not_mine', async () => {
    const otherPkh = Hash.hash160(Utils.toArray('02'.padEnd(66, 'c'), 'hex'))
    const frame = tokenFrame({ transaction: beefOf([{ satoshis: 1, scriptHex: tokenScript(500, otherPkh) }]) })
    await expect(verifyFramePayment(payeeWallet(), frame, 'test'))
      .rejects.toMatchObject({ kind: 'not_mine' })
  })

  it('refuses an output whose script assetId disagrees with the frame', async () => {
    const frame = tokenFrame()
    frame.token!.assetId = 'cd'.repeat(32) + '.1'
    await expect(verifyFramePayment(payeeWallet(), frame, 'test'))
      .rejects.toMatchObject({ kind: 'not_mine' })
  })

  it('refuses a non-token script under kind token as not_mine', async () => {
    const frame = tokenFrame({ transaction: beefOf([{ satoshis: 1, scriptHex: minesScript() }]) })
    await expect(verifyFramePayment(payeeWallet(), frame, 'test'))
      .rejects.toMatchObject({ kind: 'not_mine' })
  })
})

describe('verifyRecipientLinkage', () => {
  const scalar = new Uint8Array(32).fill(3)
  const counterpartyKey = PrivateKey.fromRandom().toPublicKey()

  function derivedPkh(): number[] {
    const curve = new Curve()
    const sum = counterpartyKey.add(curve.g.mul(new BigNumber(Array.from(scalar))))
    const derived = new PublicKey(sum.x, sum.y)
    return Hash.hash160(Utils.toArray(derived.toString(), 'hex'))
  }

  const linkageBytes = () => new TextEncoder().encode(JSON.stringify({
    prover: senderIdentityKey,
    verifier: payeeKey.toString(),
    counterparty: counterpartyKey.toString(),
    protocolID: FT_PROTOCOL_ID,
    keyID: 'p x',
    encryptedLinkage: [1, 2, 3],
    encryptedLinkageProof: [0],
    proofType: 0,
  }))

  const decryptingWallet = () => ({
    decrypt: jest.fn().mockResolvedValue({ plaintext: Array.from(scalar) }),
  })

  it('accepts when the recovered key hashes to the expected pkh', async () => {
    await expect(verifyRecipientLinkage(decryptingWallet(), linkageBytes(), derivedPkh(), 'test'))
      .resolves.toBeUndefined()
  })

  it('decrypts under the mirrored specific-linkage-revelation protocol', async () => {
    const wallet = decryptingWallet()
    await verifyRecipientLinkage(wallet, linkageBytes(), derivedPkh(), 'test')
    expect(wallet.decrypt).toHaveBeenCalledWith(
      expect.objectContaining({
        protocolID: [2, 'specific linkage revelation 2 mandala token'],
        keyID: 'p x',
        counterparty: senderIdentityKey,
      }),
      'test'
    )
  })

  it('refuses a pkh mismatch as not_mine', async () => {
    await expect(verifyRecipientLinkage(decryptingWallet(), linkageBytes(), payeePkh(), 'test'))
      .rejects.toMatchObject({ kind: 'not_mine' })
  })

  it('refuses unparseable linkage bytes', async () => {
    await expect(verifyRecipientLinkage(decryptingWallet(), new Uint8Array([0xff]), derivedPkh(), 'test'))
      .rejects.toMatchObject({ kind: 'unparseable' })
  })
})
