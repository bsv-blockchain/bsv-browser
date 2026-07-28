import { buildPaymentFrame } from '@/utils/localpay/build'
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
})
