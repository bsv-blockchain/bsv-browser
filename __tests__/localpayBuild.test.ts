import { broadcastPayment, buildPaymentFrame, finalizeDelivery } from '@/utils/localpay/build'
import { mintSession } from '@/utils/localpay/session'
import { PEERPAY_PROTOCOL_ID } from '@/utils/localpay/pending'

const session = () => mintSession({
  identityKey: '02'.padEnd(66, 'e'),
  amount: 777,
  derivationPrefix: 'cHJlZml4',
  derivationSuffix: 'c3VmZml4',
  supportsAwdl: true,
})

// Mirrors WalletPermissionsManager with `signAndProcess: false`: createAction
// returns a signableTransaction (carrying the reference) rather than a final tx,
// and buildPaymentFrame finalizes it through signAction.
function walletStub() {
  return {
    getPublicKey: jest.fn().mockResolvedValue({ publicKey: '03'.padEnd(66, 'f') }),
    createAction: jest.fn().mockResolvedValue({ signableTransaction: { reference: 'ref-123' } }),
    signAction: jest.fn().mockResolvedValue({ tx: [1, 2, 3], txid: 'finalized' }),
    abortAction: jest.fn().mockResolvedValue({ aborted: true }),
  }
}

describe('buildPaymentFrame', () => {
  it('echoes the session derivation nonces and amount', async () => {
    const s = session()
    const { frame } = await buildPaymentFrame(walletStub() as never, s, 'admin.com')
    expect(frame.amount).toBe(777)
    expect(frame.derivationPrefix).toBe(s.derivationPrefix)
    expect(frame.derivationSuffix).toBe(s.derivationSuffix)
  })

  it('uses the local identity key as sender', async () => {
    const { frame } = await buildPaymentFrame(walletStub() as never, session(), 'admin.com')
    expect(frame.senderIdentityKey).toBe('03'.padEnd(66, 'f'))
  })

  it('carries the transaction bytes', async () => {
    const { frame } = await buildPaymentFrame(walletStub() as never, session(), 'admin.com')
    expect(Array.from(frame.transaction)).toEqual([1, 2, 3])
  })

  it('propagates a createAction failure', async () => {
    const w = walletStub()
    w.createAction.mockRejectedValue(new Error('insufficient funds'))
    await expect(buildPaymentFrame(w as never, session(), 'admin.com'))
      .rejects.toThrow('insufficient funds')
  })

  // Money-safety: a wrong protocolID, malformed keyID, wrong counterparty, or
  // flipped forSelf all still produce *a* frame that passes the tests above —
  // but the payee derives a different key and the output is unspendable by
  // them. These assertions pin the exact derivation call the payee's
  // internalizeAction depends on.
  it('derives the payee key with the session nonces, protocol, and counterparty', async () => {
    const s = session()
    const w = walletStub()
    await buildPaymentFrame(w as never, s, 'admin.com')
    const derivationArgs = w.getPublicKey.mock.calls[1][0]
    expect(derivationArgs).toEqual({
      protocolID: PEERPAY_PROTOCOL_ID,
      keyID: `${s.derivationPrefix} ${s.derivationSuffix}`,
      counterparty: s.identityKey,
      forSelf: false,
    })
  })

  it('builds the derivation keyID from the session nonces verbatim, not regenerated locally', async () => {
    const s = mintSession({
      identityKey: '02'.padEnd(66, 'b'),
      amount: 555,
      derivationPrefix: 'uniquePrefix123',
      derivationSuffix: 'uniqueSuffix456',
      supportsAwdl: true,
    })
    const w = walletStub()
    await buildPaymentFrame(w as never, s, 'admin.com')
    const derivationArgs = w.getPublicKey.mock.calls[1][0]
    expect(derivationArgs.keyID).toBe('uniquePrefix123 uniqueSuffix456')
    expect(derivationArgs.counterparty).toBe('02'.padEnd(66, 'b'))
  })

  it('creates the action with randomizeOutputs disabled and noSend so the payee broadcasts', async () => {
    const w = walletStub()
    await buildPaymentFrame(w as never, session(), 'admin.com')
    const createArgs = w.createAction.mock.calls[0][0]
    expect(createArgs.options).toEqual({ randomizeOutputs: false, noSend: true, signAndProcess: false })
  })

  // The reference is the ONLY handle that can release the inputs a `noSend`
  // action holds. WalletPermissionsManager swallows it unless signAndProcess is
  // explicitly false, and TaskFailAbandoned never sweeps 'nosend' — so losing it
  // locks amount + fee in the payer's wallet permanently.
  it('asks for the deferred result so the abort reference survives', async () => {
    const w = walletStub()
    await buildPaymentFrame(w as never, session(), 'admin.com')
    expect(w.createAction.mock.calls[0][0].options.signAndProcess).toBe(false)
  })

  it('returns the createAction reference alongside the frame', async () => {
    const built = await buildPaymentFrame(walletStub() as never, session(), 'admin.com')
    expect(built.reference).toBe('ref-123')
  })

  it('returns no reference when a wallet finalizes createAction itself', async () => {
    const w = walletStub()
    w.createAction.mockResolvedValue({ tx: [4, 5, 6], txid: 'deadbeef' })
    const built = await buildPaymentFrame(w as never, session(), 'admin.com')
    expect(built.reference).toBeUndefined()
    expect(Array.from(built.frame.transaction)).toEqual([4, 5, 6])
    expect(w.signAction).not.toHaveBeenCalled()
  })

  it('forwards the originator to every wallet call', async () => {
    const w = walletStub()
    await buildPaymentFrame(w as never, session(), 'admin.com')
    expect(w.getPublicKey.mock.calls[0][1]).toBe('admin.com')
    expect(w.getPublicKey.mock.calls[1][1]).toBe('admin.com')
    expect(w.createAction.mock.calls[0][1]).toBe('admin.com')
    expect(w.signAction.mock.calls[0][1]).toBe('admin.com')
  })

  it('finalizes a signableTransaction via signAction with empty spends and noSend', async () => {
    const w = walletStub()
    const built = await buildPaymentFrame(w as never, session(), 'admin.com')
    expect(w.signAction).toHaveBeenCalledWith(
      { reference: 'ref-123', spends: {}, options: { noSend: true } },
      'admin.com'
    )
    expect(Array.from(built.frame.transaction)).toEqual([1, 2, 3])
  })

  // `options.sendWith` addresses a withheld action by TXID, not by reference,
  // so without this the payer has no handle to broadcast with and the action
  // stays 'nosend' forever — nothing in storage ever sweeps that status.
  it('returns the signed txid so the payment can be broadcast later', async () => {
    const built = await buildPaymentFrame(walletStub() as never, session(), 'admin.com')
    expect(built.txid).toBe('finalized')
  })

  it('takes the txid from createAction when the wallet finalizes it itself', async () => {
    const w = walletStub()
    w.createAction.mockResolvedValue({ tx: [4, 5, 6], txid: 'deadbeef' })
    const built = await buildPaymentFrame(w as never, session(), 'admin.com')
    expect(built.txid).toBe('deadbeef')
  })
})

describe('broadcastPayment', () => {
  function releaseStub(sendWithResults?: { txid: string; status: string }[]) {
    return {
      getPublicKey: jest.fn(),
      createAction: jest.fn().mockResolvedValue({ sendWithResults }),
      signAction: jest.fn(),
      abortAction: jest.fn().mockResolvedValue({ aborted: true }),
    }
  }

  // Verified against @bsv/sdk validationHelpers.js:458-460 — sendWith with no
  // inputs and no outputs leaves isNewTx false, so this builds nothing; and
  // :438 — description is mandatory anyway (5-2000 bytes).
  it('releases the txid through a createAction that builds nothing', async () => {
    const w = releaseStub([{ txid: 'abc', status: 'sending' }])
    await broadcastPayment(w as never, 'abc', 'admin.com')

    const [args, originator] = w.createAction.mock.calls[0]
    expect(args.options).toEqual({ sendWith: ['abc'] })
    expect(args.inputs).toBeUndefined()
    expect(args.outputs).toBeUndefined()
    expect(String(args.description).length).toBeGreaterThanOrEqual(5)
    expect(originator).toBe('admin.com')
  })

  it('returns the toolbox status for this txid', async () => {
    const w = releaseStub([
      { txid: 'other', status: 'failed' },
      { txid: 'abc', status: 'unproven' },
    ])
    await expect(broadcastPayment(w as never, 'abc', 'admin.com')).resolves.toBe('unproven')
  })

  it('throws when the toolbox reports failed for this txid', async () => {
    const w = releaseStub([{ txid: 'abc', status: 'failed' }])
    await expect(broadcastPayment(w as never, 'abc', 'admin.com')).rejects.toThrow('abc')
  })
})

// The payer's money decision, in full. Every branch here either releases real
// money onto the network or reclaims inputs that are otherwise locked forever.
describe('finalizeDelivery', () => {
  function payerStub() {
    return {
      getPublicKey: jest.fn(),
      createAction: jest.fn().mockResolvedValue({ sendWithResults: [{ txid: 'tx-1', status: 'sending' }] }),
      signAction: jest.fn(),
      abortAction: jest.fn().mockResolvedValue({ aborted: true }),
    }
  }

  const built = { frame: {} as never, reference: 'ref-1', txid: 'tx-1' }

  it('broadcasts on a positive ack', async () => {
    const w = payerStub()
    const outcome = await finalizeDelivery(w as never, built, { ok: true }, 'admin.com')

    expect(outcome).toEqual({ kind: 'sent', broadcast: 'ok' })
    expect(w.createAction).toHaveBeenCalledTimes(1)
    expect(w.createAction.mock.calls[0][0].options).toEqual({ sendWith: ['tx-1'] })
    // Aborting after a positive ack frees inputs the payee is about to spend.
    expect(w.abortAction).not.toHaveBeenCalled()
  })

  it('does NOT broadcast on a negative ack, and releases the inputs instead', async () => {
    const w = payerStub()
    const outcome = await finalizeDelivery(w as never, built, { ok: false, error: 'save_failed' }, 'admin.com')

    expect(outcome).toEqual({ kind: 'declined', reason: 'save_failed' })
    expect(w.createAction).not.toHaveBeenCalled()
    expect(w.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, 'admin.com')
  })

  it('still declines cleanly when there is no reference to abort', async () => {
    const w = payerStub()
    const outcome = await finalizeDelivery(w as never, { ...built, reference: undefined }, { ok: false }, 'admin.com')

    expect(outcome).toEqual({ kind: 'declined', reason: undefined })
    expect(w.createAction).not.toHaveBeenCalled()
    expect(w.abortAction).not.toHaveBeenCalled()
  })

  // A broadcast failure after a positive ack is NOT a failed payment: the
  // payee holds the frame and will internalize it. Reporting failure would put
  // the payer on a retry that mints a second transaction for the same request.
  it('reports a thrown broadcast as sent-but-pending, never as failed', async () => {
    const w = payerStub()
    w.createAction.mockRejectedValue(new Error('no network'))
    const outcome = await finalizeDelivery(w as never, built, { ok: true }, 'admin.com')

    expect(outcome.kind).toBe('sent')
    expect(outcome).toMatchObject({ broadcast: 'pending', detail: 'no network' })
    expect(w.abortAction).not.toHaveBeenCalled()
  })

  it('reports a toolbox-rejected broadcast as sent-but-pending', async () => {
    const w = payerStub()
    w.createAction.mockResolvedValue({ sendWithResults: [{ txid: 'tx-1', status: 'failed' }] })
    const outcome = await finalizeDelivery(w as never, built, { ok: true }, 'admin.com')

    expect(outcome).toMatchObject({ kind: 'sent', broadcast: 'pending' })
    expect(w.abortAction).not.toHaveBeenCalled()
  })

  it('reports sent-but-pending when there is no txid to broadcast', async () => {
    const w = payerStub()
    const outcome = await finalizeDelivery(w as never, { ...built, txid: undefined }, { ok: true }, 'admin.com')

    expect(outcome).toMatchObject({ kind: 'sent', broadcast: 'pending' })
    expect(w.createAction).not.toHaveBeenCalled()
    expect(w.abortAction).not.toHaveBeenCalled()
  })

  it('does not let a failed abort mask the decline', async () => {
    const w = payerStub()
    w.abortAction.mockRejectedValue(new Error('storage down'))
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(finalizeDelivery(w as never, built, { ok: false, error: 'already_paid' }, 'admin.com'))
      .resolves.toEqual({ kind: 'declined', reason: 'already_paid' })
    warn.mockRestore()
  })
})
