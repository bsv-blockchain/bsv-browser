/**
 * What a delivered frame actually pays this device.
 *
 * The figure a payee renders as a receipt has to come from the transaction
 * `internalizeAction` will credit, and is only worth reading once that output
 * is shown to lock to a key this device derives. These tests pin both halves,
 * and in particular the hole the module closes: correct derivation nonces with
 * an output paying somebody else.
 */
import { Beef, Hash, LockingScript, P2PKH, PrivateKey, Transaction, Utils } from '@bsv/sdk'
import {
  FrameVerifyError,
  FT_PROTOCOL_ID,
  declineReasonFor,
  verifyFramePayment
} from '@bsv/expo-wallet-toolbox/core/localpay/verify'
import type { CoverResult } from '@bsv/expo-wallet-toolbox/core/mandala/types'
import { PEERPAY_PROTOCOL_ID } from '@bsv/expo-wallet-toolbox/core/localpay/pending'
import type { PaymentFrame } from '@bsv/expo-wallet-toolbox/core/localpay/codec'
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
  version: 4,
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
    admissions: [],
  },
  transaction: beefOf([{ satoshis: 1, scriptHex: tokenScript(500) }]),
  ...overrides,
})

describe('verifyFramePayment: token kind', () => {
  /**
   * The session's OWN asset block — this device minted it, so it is the trust
   * anchor wire contract §9.10 requires. It matches `tokenFrame()`'s token block
   * exactly; the tests below are the ones that make it differ.
   */
  const ASSET = { overlayUrl: 'https://overlay.issuer.example', overlayIdentityKey: '03'.padEnd(66, 'b') }

  // COVER is injected: the pure walk lives in @bsv/mandala, beside the overlay's
  // own σ_I digest, so wallet and overlay cannot disagree about what a signature
  // covers. These tests supply a stand-in and pin the wiring, not the walk.
  const covers = {
    cover: async (): Promise<CoverResult> => ({ ok: true, mustSubmit: ['tip'] }),
    asset: ASSET
  }

  it('returns the decoded token amount, assetId, and what COVER says must still be submitted', async () => {
    const result = await verifyFramePayment(payeeWallet(), tokenFrame(), 'test', covers)
    expect(result).toEqual({ kind: 'token', assetId: ASSET_ID, amount: 500, mustSubmit: ['tip'] })
  })

  it('derives with the mandala FT protocol, not PEERPAY', async () => {
    const wallet = payeeWallet()
    await verifyFramePayment(wallet, tokenFrame(), 'test', covers)
    expect(wallet.getPublicKey).toHaveBeenCalledWith(
      expect.objectContaining({ protocolID: FT_PROTOCOL_ID, forSelf: true }),
      'test'
    )
  })

  it('refuses a token output locked to someone else as not_mine', async () => {
    const otherPkh = Hash.hash160(Utils.toArray('02'.padEnd(66, 'c'), 'hex'))
    const frame = tokenFrame({ transaction: beefOf([{ satoshis: 1, scriptHex: tokenScript(500, otherPkh) }]) })
    await expect(verifyFramePayment(payeeWallet(), frame, 'test', covers))
      .rejects.toMatchObject({ kind: 'not_mine' })
  })

  it('refuses an output whose script assetId disagrees with the frame', async () => {
    const frame = tokenFrame()
    frame.token!.assetId = 'cd'.repeat(32) + '.1'
    await expect(verifyFramePayment(payeeWallet(), frame, 'test', covers))
      .rejects.toMatchObject({ kind: 'not_mine' })
  })

  it('refuses a non-token script under kind token as not_mine', async () => {
    const frame = tokenFrame({ transaction: beefOf([{ satoshis: 1, scriptHex: minesScript() }]) })
    await expect(verifyFramePayment(payeeWallet(), frame, 'test', covers))
      .rejects.toMatchObject({ kind: 'not_mine' })
  })

  // §9: "a frame that fails COVER is refused at hand-over exactly like a
  // not_mine/unparseable decode failure today". Nothing has latched and nothing
  // has been written at this point, so the refusal is a provable "queued nothing".
  it('refuses a frame COVER rejects, with its own kind', async () => {
    const cover = async (): Promise<CoverResult> => ({ ok: false, reason: 'uncovered_ancestor' })
    await expect(verifyFramePayment(payeeWallet(), tokenFrame(), 'test', { cover, asset: ASSET }))
      .rejects.toMatchObject({ name: 'FrameVerifyError', kind: 'not_covered' })
  })

  it('names the COVER reason in the refusal, so a stuck chain is diagnosable', async () => {
    const cover = async (): Promise<CoverResult> => ({ ok: false, reason: 'unsafe_asset' })
    const err = await verifyFramePayment(payeeWallet(), tokenFrame(), 'test', { cover, asset: ASSET }).catch(e => e)
    expect(String(err.message)).toMatch(/unsafe_asset/)
  })

  // ── the §9.10 trust anchor ──
  //
  // `coverFromFrame` builds the COVER bundle's `overlayIdentityKey` straight
  // from `frame.token.overlayIdentityKey`. Unless that value is pinned to the
  // key THIS device configured, a payer with any keypair can name itself the
  // overlay, sign its own σ_I over its own coin, and be credited for money no
  // issuer ever saw. So the comparison happens before the walk ever runs.
  it('refuses a frame naming a different overlay identity key, before COVER runs', async () => {
    const cover = jest.fn(async (): Promise<CoverResult> => ({ ok: true, mustSubmit: [] }))
    const frame = tokenFrame()
    frame.token!.overlayIdentityKey = '02'.padEnd(66, 'a')

    const err = await verifyFramePayment(payeeWallet(), frame, 'test', { cover, asset: ASSET }).catch(e => e)

    expect(err).toMatchObject({ name: 'FrameVerifyError', kind: 'not_covered' })
    expect(String(err.message)).toMatch(/unsafe_asset/)
    expect(cover).not.toHaveBeenCalled()
  })

  // The URL goes with the key: linkage payloads are the bytes a later /submit
  // is aimed at, and aiming them at an attacker's overlay is how a wallet is
  // talked into treating a stranger's "admitted" as the issuer's.
  it('refuses a frame naming a different overlay URL', async () => {
    const cover = jest.fn(async (): Promise<CoverResult> => ({ ok: true, mustSubmit: [] }))
    const frame = tokenFrame()
    frame.token!.overlayUrl = 'https://overlay.attacker.example'

    await expect(verifyFramePayment(payeeWallet(), frame, 'test', { cover, asset: ASSET })).rejects.toMatchObject({
      kind: 'not_covered'
    })
    expect(cover).not.toHaveBeenCalled()
  })

  it('accepts the same overlay written with a trailing slash or a different key case', async () => {
    const frame = tokenFrame()
    frame.token!.overlayUrl = ASSET.overlayUrl + '/'
    frame.token!.overlayIdentityKey = ASSET.overlayIdentityKey.toUpperCase()
    await expect(verifyFramePayment(payeeWallet(), frame, 'test', covers)).resolves.toMatchObject({ kind: 'token' })
  })

  // Fail closed, exactly as a missing verifier does: no configured asset is no
  // anchor, and an unanchored COVER walk proves nothing.
  it('refuses a token frame when no configured asset was supplied at all', async () => {
    const cover = jest.fn(async (): Promise<CoverResult> => ({ ok: true, mustSubmit: [] }))
    await expect(verifyFramePayment(payeeWallet(), tokenFrame(), 'test', { cover })).rejects.toMatchObject({
      kind: 'not_covered'
    })
    expect(cover).not.toHaveBeenCalled()
  })

  // Fail closed. A caller that forgot to wire the verifier must not get a
  // credit that looks identical to a covered one: no verifier is no evidence.
  it('refuses a token frame when no COVER verifier was supplied at all', async () => {
    await expect(verifyFramePayment(payeeWallet(), tokenFrame(), 'test'))
      .rejects.toMatchObject({ kind: 'not_covered' })
  })

  // Ownership is checked BEFORE coverage: a frame that pays someone else is
  // not this device's business, whatever its evidence says, and running an
  // injected verifier over it would hand a stranger's frame to third-party code.
  it('refuses a stranger’s output before it ever consults COVER', async () => {
    const cover = jest.fn(async (): Promise<CoverResult> => ({ ok: true, mustSubmit: [] }))
    const otherPkh = Hash.hash160(Utils.toArray('02'.padEnd(66, 'c'), 'hex'))
    const frame = tokenFrame({ transaction: beefOf([{ satoshis: 1, scriptHex: tokenScript(500, otherPkh) }]) })
    await expect(verifyFramePayment(payeeWallet(), frame, 'test', { cover, asset: ASSET })).rejects.toMatchObject({
      kind: 'not_mine'
    })
    expect(cover).not.toHaveBeenCalled()
  })

  it('leaves the BSV path untouched: no verifier needed, no cover call', async () => {
    const cover = jest.fn(async (): Promise<CoverResult> => ({ ok: true, mustSubmit: [] }))
    const frame = frameFor(beefOf([{ satoshis: 4200, scriptHex: minesScript() }]))
    await expect(verifyFramePayment(payeeWallet(), frame, 'test', { cover })).resolves.toEqual({
      kind: 'bsv',
      satoshis: 4200
    })
    expect(cover).not.toHaveBeenCalled()
  })
})

describe('declineReasonFor', () => {
  // The payer renders these in ITS locale, so the wire carries a stable machine
  // code. Every one of them must mean the payee queued nothing.
  it('maps each verify failure to the decline the payer can act on', () => {
    expect(declineReasonFor('unparseable')).toBe('decode_failed')
    expect(declineReasonFor('not_mine')).toBe('session_mismatch')
    expect(declineReasonFor('not_covered')).toBe('not_covered')
  })

  it('falls back to decode_failed for anything it does not recognise', () => {
    expect(declineReasonFor('something else' as never)).toBe('decode_failed')
  })
})
