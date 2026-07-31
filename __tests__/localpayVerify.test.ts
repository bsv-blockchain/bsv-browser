/**
 * What a delivered frame actually pays this device.
 *
 * The figure a payee renders as a receipt has to come from the transaction
 * `internalizeAction` will credit, and is only worth reading once that output
 * is shown to lock to a key this device derives. These tests pin both halves,
 * and in particular the hole the module closes: correct derivation nonces with
 * an output paying somebody else.
 */
import { Beef, LockingScript, P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import { FrameVerifyError, verifyFramePayment } from '@/utils/localpay/verify'
import { PEERPAY_PROTOCOL_ID } from '@/utils/localpay/pending'
import type { PaymentFrame } from '@/utils/localpay/codec'

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
    await expect(verifyFramePayment(payeeWallet(), frame, 'admin.com')).resolves.toEqual({ satoshis: 4200 })
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
