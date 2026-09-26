/**
 * What a delivered frame actually pays this device.
 *
 * The figure a payee renders as a receipt has to come from the transaction
 * `internalizeAction` will credit, and is only worth reading once that output
 * is shown to lock to a key this device derives. These tests pin both halves,
 * and in particular the two holes the module closes: correct derivation
 * nonces with an output paying somebody else (ownership), and a properly-
 * addressed output backed by a transaction that never actually moved that
 * value (SPV/script/value conservation — P0-1).
 */
import {
  Beef,
  Hash,
  LockingScript,
  MerklePath,
  P2PKH,
  PrivateKey,
  Transaction,
  UnlockingScript,
  Utils,
  type ChainTracker
} from '@bsv/sdk'
import { FrameVerifyError, FT_PROTOCOL_ID, declineReasonFor, verifyFramePayment } from '@bsv/expo-wallet-toolbox/core/localpay/verify'
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

/** A real AtomicBEEF carrying `outputs`, in order, with NO inputs.
 *
 * Fine for every check that runs before the SPV/script verifier (ownership,
 * amount, token decode) — none of those read the input side. Not usable as a
 * frame that must reach `tx.verify()` and succeed: an input-less transaction
 * is refused as unmined-with-no-inputs by the SDK's own structural check.
 */
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

/** A payee wallet that derives exactly one key, and records how it was asked.
 *
 * `getServices` is unused by every check that runs before the new SPV/script
 * verifier, so it only needs to be real for the tests that reach it — a
 * caller that reaches it without one gets a TypeError, not a false pass.
 */
function payeeWallet(chainTracker?: ChainTracker) {
  return {
    getPublicKey: jest.fn(async () => ({ publicKey: payeeKey.toString() })),
    getServices: () => ({ getChainTracker: async () => chainTracker as ChainTracker })
  }
}

// ── fixtures for the SPV/script verifier (P0-1) ──
//
// A mined ancestor is one whose OWN scripts are never checked by `tx.verify`
// — only its merkle path is (`Transaction_completeVerificationFromMerklePath`)
// — so its input can be any placeholder. What has to be real is the CHILD's
// spend of it: `tx.verify` runs the actual P2PKH script check on that input
// against the ancestor's real locking script.
const ANCESTOR_HEIGHT = 0

/** A "mined" ancestor paying `payerKey`, with a single-leaf merkle path whose
 * root is the ancestor's own txid (`MerklePath.computeRoot` for a lone leaf).
 */
function minedAncestor(payerKey: PrivateKey, satoshis: number): Transaction {
  const tx = new Transaction()
  tx.addInput({ sourceTXID: '11'.repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex('') })
  tx.addOutput({ satoshis, lockingScript: new P2PKH().lock(payerKey.toAddress()) })
  tx.merklePath = MerklePath.fromCoinbaseTxidAndHeight(tx.id('hex'), ANCESTOR_HEIGHT)
  return tx
}

/** The chain tracker a payee with this exact ancestor synced would report:
 * accepts only that ancestor's real root at its real height, current enough
 * to clear `MerklePath.verify`'s 100-block rule for the index-0 leaf.
 */
function trackerAccepting(ancestor: Transaction): ChainTracker {
  const root = (ancestor.merklePath as MerklePath).computeRoot(ancestor.id('hex'))
  return {
    isValidRootForHeight: async (r: string, h: number) => r === root && h === ANCESTOR_HEIGHT,
    currentHeight: async () => ANCESTOR_HEIGHT + 100
  }
}

/** A tracker that recognises no root at all — stands in for a payee whose
 * offline header window never covers this ancestor's height.
 */
function trackerRejectingEverything(): ChainTracker {
  return {
    isValidRootForHeight: async () => false,
    currentHeight: async () => ANCESTOR_HEIGHT + 100
  }
}

/** A properly-signed spend of `ancestor`'s output 0, paying `outputs` in order. */
async function spendAncestor(
  ancestor: Transaction,
  payerKey: PrivateKey,
  outputs: { satoshis: number; scriptHex: string }[]
): Promise<Transaction> {
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: ancestor,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(payerKey)
  })
  for (const o of outputs) tx.addOutput({ satoshis: o.satoshis, lockingScript: LockingScript.fromHex(o.scriptHex) })
  await tx.sign()
  return tx
}

/** The AtomicBEEF for `tx`, including its ancestor graph and any merkle-path bumps. */
function atomicBeefOf(tx: Transaction): Uint8Array {
  const beef = new Beef()
  beef.mergeTransaction(tx)
  return new Uint8Array(beef.toBinaryAtomic(tx.id('hex')))
}

/** Same, but with `ancestorId` reduced to a bare txid (no raw bytes) — a
 * mined ancestor the payer's BEEF proved only by merkle path, never included
 * in full, so its script cannot actually be checked.
 */
function atomicBeefWithTxidOnlyAncestor(tx: Transaction, ancestorId: string): Uint8Array {
  const beef = new Beef()
  beef.mergeTransaction(tx)
  beef.makeTxidOnly(ancestorId)
  return new Uint8Array(beef.toBinaryAtomic(tx.id('hex')))
}

/** One end-to-end valid BSV frame: a real payer key, a mined ancestor of
 * `ancestorSatoshis`, and a proper P2PKH spend paying `outputs` to this
 * device (plus whatever else the caller adds). Returns the frame and the
 * wallet whose chain tracker will accept it.
 */
async function validFrame(
  outputs: { satoshis: number; scriptHex: string }[],
  opts?: { ancestorSatoshis?: number; outputIndex?: number }
): Promise<{ frame: PaymentFrame; wallet: ReturnType<typeof payeeWallet>; ancestor: Transaction }> {
  const payerKey = PrivateKey.fromRandom()
  const ancestorSatoshis = opts?.ancestorSatoshis ?? outputs.reduce((s, o) => s + o.satoshis, 0)
  const ancestor = minedAncestor(payerKey, ancestorSatoshis)
  const tx = await spendAncestor(ancestor, payerKey, outputs)
  const frame = frameFor(atomicBeefOf(tx), opts?.outputIndex ?? 0)
  const wallet = payeeWallet(trackerAccepting(ancestor))
  return { frame, wallet, ancestor }
}

describe('verifyFramePayment', () => {
  it('returns the satoshis of the output that locks to this device’s derived key', async () => {
    const { frame, wallet } = await validFrame([{ satoshis: 4200, scriptHex: minesScript() }])
    await expect(verifyFramePayment(wallet, frame, 'admin.com')).resolves.toEqual({ kind: 'bsv', satoshis: 4200 })
  })

  it('derives with the payee’s own key, keyed by the frame’s nonces and the sender', async () => {
    const { frame, wallet } = await validFrame([{ satoshis: 1, scriptHex: minesScript() }])
    await verifyFramePayment(wallet, frame, 'admin.com')
    expect(wallet.getPublicKey).toHaveBeenCalledWith(
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
    const { frame, wallet } = await validFrame(
      [
        { satoshis: 9, scriptHex: '76a914' + '00'.repeat(20) + '88ac' },
        { satoshis: 777, scriptHex: minesScript() }
      ],
      { outputIndex: 1 }
    )
    await expect(verifyFramePayment(wallet, frame, 'admin.com')).resolves.toEqual({
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
      await expect(verifyFramePayment(payeeWallet(), frameFor(new Uint8Array([1])), 'admin.com')).rejects.toMatchObject(
        { kind: 'not_mine' }
      )
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

// ── P0-1: the SPV/script/value-conservation gate ──
//
// Ownership and amount are cheap and certain, but say nothing about the rest
// of the transaction. `internalizeAction`'s own gate (toolbox
// `validateAtomicBeef` -> SDK `Beef.verify`) never runs a script interpreter
// and never checks sum(inputs) >= sum(outputs), so without this module's own
// `tx.verify(chainTracker)` call a payer could spend a real mined UTXO it
// does not own — with a garbage unlockingScript, or a script that pays out
// more than it took in — into an output that locks to this device, and be
// credited for it while offline.
describe('verifyFramePayment: SPV/script verification (P0-1)', () => {
  it('still verifies a valid frame end to end (regression)', async () => {
    const { frame, wallet } = await validFrame([{ satoshis: 4200, scriptHex: minesScript() }])
    await expect(verifyFramePayment(wallet, frame, 'admin.com')).resolves.toEqual({ kind: 'bsv', satoshis: 4200 })
  })

  // The hole this call closes: a real mined ancestor, a properly-addressed
  // and properly-valued output, but nothing actually unlocking the ancestor's
  // coin. Accepting it would credit the payee from a transaction that could
  // never be broadcast to move real money.
  it('rejects a garbage/empty unlockingScript before any settle-path write', async () => {
    const payerKey = PrivateKey.fromRandom()
    const ancestor = minedAncestor(payerKey, 4200)
    const tx = new Transaction()
    tx.addInput({ sourceTransaction: ancestor, sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex('') })
    tx.addOutput({ satoshis: 4200, lockingScript: LockingScript.fromHex(minesScript()) })

    const frame = frameFor(atomicBeefOf(tx))
    const wallet = payeeWallet(trackerAccepting(ancestor))

    // Mimics the caller's shape (NearbyFlow's settleReceived): the settle-path
    // write only ever runs AFTER verifyFramePayment resolves. If verification
    // itself is broken, this mock proves the settle path was never reached.
    const settleWrite = jest.fn()
    const settleLikeCaller = async () => {
      const verified = await verifyFramePayment(wallet, frame, 'admin.com')
      settleWrite()
      return verified
    }

    await expect(settleLikeCaller()).rejects.toMatchObject({ name: 'FrameVerifyError', kind: 'unparseable' })
    expect(settleWrite).not.toHaveBeenCalled()
  })

  // The other half of the same hole: a validly-signed spend, but one that
  // claims to pay out more than its ancestor actually held.
  it('rejects a transaction whose outputs exceed its inputs', async () => {
    const payerKey = PrivateKey.fromRandom()
    const ancestor = minedAncestor(payerKey, 4200)
    const tx = await spendAncestor(ancestor, payerKey, [{ satoshis: 5000, scriptHex: minesScript() }])

    const frame = frameFor(atomicBeefOf(tx))
    const wallet = payeeWallet(trackerAccepting(ancestor))

    await expect(verifyFramePayment(wallet, frame, 'admin.com')).rejects.toMatchObject({
      name: 'FrameVerifyError',
      kind: 'unparseable'
    })
  })

  // A mined ancestor the payer's BEEF proved only by merkle path, never
  // included as raw bytes: `tx.verify` cannot check a script it cannot read,
  // and MUST fail closed (refuse) rather than silently skip that input.
  it('rejects an ancestor present only as a txid, with no raw bytes to verify', async () => {
    const payerKey = PrivateKey.fromRandom()
    const ancestor = minedAncestor(payerKey, 4200)
    const tx = await spendAncestor(ancestor, payerKey, [{ satoshis: 4200, scriptHex: minesScript() }])

    const frame = frameFor(atomicBeefWithTxidOnlyAncestor(tx, ancestor.id('hex')))
    const wallet = payeeWallet(trackerAccepting(ancestor))

    await expect(verifyFramePayment(wallet, frame, 'admin.com')).rejects.toMatchObject({
      name: 'FrameVerifyError',
      kind: 'unparseable'
    })
  })

  // The ancestor's merkle root does not match what this payee's own chain
  // tracker (e.g. a stale offline header cache) reports for that height.
  it('rejects an ancestor whose merkle root the chain tracker does not accept', async () => {
    const payerKey = PrivateKey.fromRandom()
    const ancestor = minedAncestor(payerKey, 4200)
    const tx = await spendAncestor(ancestor, payerKey, [{ satoshis: 4200, scriptHex: minesScript() }])

    const frame = frameFor(atomicBeefOf(tx))
    const wallet = payeeWallet(trackerRejectingEverything())

    await expect(verifyFramePayment(wallet, frame, 'admin.com')).rejects.toMatchObject({
      name: 'FrameVerifyError',
      kind: 'unparseable'
    })
  })
})

const ASSET_ID = 'ab'.repeat(32) + '.0'
const payeePkh = () => Hash.hash160(Utils.toArray(payeeKey.toString(), 'hex'))

function tokenScript(amount: number, pkh: number[] = payeePkh()): string {
  return new MandalaToken().lock(ASSET_ID, amount, pkh).toHex()
}

/**
 * A real, conserving AtomicBEEF: a funding input worth `amount`, spent whole
 * into a single output of `amount` at `pkh` — XR-099's conservation check
 * reads inputs as well as outputs now, so the token branch's default fixture
 * needs a real ancestor, not just a bare output.
 */
function tokenBeefWithInput(amount: number, pkh: number[] = payeePkh()): Uint8Array {
  const parent = new Transaction()
  parent.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(tokenScript(amount, pkh)) })
  const tip = new Transaction()
  tip.addInput({
    sourceTransaction: parent,
    sourceOutputIndex: 0,
    unlockingScript: new UnlockingScript([]),
    sequence: 0xffffffff
  })
  tip.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(tokenScript(amount, pkh)) })
  const beef = new Beef()
  beef.mergeTransaction(tip)
  return new Uint8Array(beef.toBinaryAtomic(tip.id('hex')))
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
    admissions: []
  },
  transaction: tokenBeefWithInput(500),
  ...overrides
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

  // XR-099: COVER only checks ancestry admission, never value. Ownership,
  // assetId and amount-is-a-positive-integer all pass for a tip whose single
  // decodable token input is worth far less than the output it pays out —
  // nothing before this point sums input value against output value, so a
  // payer could mint counterfeit token value into an otherwise-legitimate
  // frame just by naming a bigger output amount than it actually admits in.
  it('XR-099: refuses a tip whose decodable token input is worth less than its output', async () => {
    const parent = new Transaction()
    parent.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(tokenScript(1)) })
    const tip = new Transaction()
    tip.addInput({
      sourceTransaction: parent,
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript([]),
      sequence: 0xffffffff
    })
    tip.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(tokenScript(100)) })
    const beef = new Beef()
    beef.mergeTransaction(tip)
    const transaction = new Uint8Array(beef.toBinaryAtomic(tip.id('hex')))

    await expect(
      verifyFramePayment(payeeWallet(), tokenFrame({ transaction }), 'test', covers)
    ).rejects.toMatchObject({ kind: 'not_covered' })
  })

  // The rightful case: input value covers (or exceeds, e.g. token change
  // returned elsewhere in the same tx) the output value. Must still pass.
  it('XR-099: accepts a tip whose decodable token input value covers its output', async () => {
    const parent = new Transaction()
    parent.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(tokenScript(500)) })
    const tip = new Transaction()
    tip.addInput({
      sourceTransaction: parent,
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript([]),
      sequence: 0xffffffff
    })
    tip.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(tokenScript(500)) })
    const beef = new Beef()
    beef.mergeTransaction(tip)
    const transaction = new Uint8Array(beef.toBinaryAtomic(tip.id('hex')))

    await expect(
      verifyFramePayment(payeeWallet(), tokenFrame({ transaction }), 'test', covers)
    ).resolves.toMatchObject({ kind: 'token', amount: 500 })
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
    await expect(verifyFramePayment(payeeWallet(), frame, 'test', covers)).rejects.toMatchObject({ kind: 'not_mine' })
  })

  it('refuses an output whose script assetId disagrees with the frame', async () => {
    const frame = tokenFrame()
    frame.token!.assetId = 'cd'.repeat(32) + '.1'
    await expect(verifyFramePayment(payeeWallet(), frame, 'test', covers)).rejects.toMatchObject({ kind: 'not_mine' })
  })

  it('refuses a non-token script under kind token as not_mine', async () => {
    const frame = tokenFrame({ transaction: beefOf([{ satoshis: 1, scriptHex: minesScript() }]) })
    await expect(verifyFramePayment(payeeWallet(), frame, 'test', covers)).rejects.toMatchObject({ kind: 'not_mine' })
  })

  // §9: "a frame that fails COVER is refused at hand-over exactly like a
  // not_mine/unparseable decode failure today". Nothing has latched and nothing
  // has been written at this point, so the refusal is a provable "queued nothing".
  it('refuses a frame COVER rejects, with its own kind', async () => {
    const cover = async (): Promise<CoverResult> => ({ ok: false, reason: 'uncovered_ancestor' })
    await expect(
      verifyFramePayment(payeeWallet(), tokenFrame(), 'test', { cover, asset: ASSET })
    ).rejects.toMatchObject({ name: 'FrameVerifyError', kind: 'not_covered' })
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
    await expect(verifyFramePayment(payeeWallet(), tokenFrame(), 'test')).rejects.toMatchObject({ kind: 'not_covered' })
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
    const { frame, wallet } = await validFrame([{ satoshis: 4200, scriptHex: minesScript() }])
    await expect(verifyFramePayment(wallet, frame, 'test', { cover })).resolves.toEqual({
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
