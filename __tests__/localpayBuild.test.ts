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

function walletStub() {
  return {
    getPublicKey: jest.fn().mockResolvedValue({ publicKey: '03'.padEnd(66, 'f') }),
    createAction: jest.fn().mockResolvedValue({ tx: [1, 2, 3], txid: 'deadbeef' }),
    signAction: jest.fn().mockResolvedValue({ tx: [9, 9, 9], txid: 'finalized' }),
  }
}

describe('buildPaymentFrame', () => {
  it('echoes the session derivation nonces and amount', async () => {
    const s = session()
    const f = await buildPaymentFrame(walletStub() as never, s, 'awdl', 'admin.com')
    expect(f.amount).toBe(777)
    expect(f.derivationPrefix).toBe(s.derivationPrefix)
    expect(f.derivationSuffix).toBe(s.derivationSuffix)
  })

  it('uses the local identity key as sender', async () => {
    const f = await buildPaymentFrame(walletStub() as never, session(), 'awdl', 'admin.com')
    expect(f.senderIdentityKey).toBe('03'.padEnd(66, 'f'))
  })

  it('carries the transaction bytes', async () => {
    const f = await buildPaymentFrame(walletStub() as never, session(), 'awdl', 'admin.com')
    expect(Array.from(f.transaction)).toEqual([1, 2, 3])
  })

  it('propagates a createAction failure', async () => {
    const w = walletStub()
    w.createAction.mockRejectedValue(new Error('insufficient funds'))
    await expect(buildPaymentFrame(w as never, session(), 'awdl', 'admin.com'))
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
    await buildPaymentFrame(w as never, s, 'awdl', 'admin.com')
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
    await buildPaymentFrame(w as never, s, 'awdl', 'admin.com')
    const derivationArgs = w.getPublicKey.mock.calls[1][0]
    expect(derivationArgs.keyID).toBe('uniquePrefix123 uniqueSuffix456')
    expect(derivationArgs.counterparty).toBe('02'.padEnd(66, 'b'))
  })

  it('creates the action with randomizeOutputs disabled and noSend so the payee broadcasts', async () => {
    const w = walletStub()
    await buildPaymentFrame(w as never, session(), 'awdl', 'admin.com')
    const createArgs = w.createAction.mock.calls[0][0]
    expect(createArgs.options).toEqual({ randomizeOutputs: false, noSend: true })
  })

  it('forwards the originator to every wallet call', async () => {
    const w = walletStub()
    await buildPaymentFrame(w as never, session(), 'awdl', 'admin.com')
    expect(w.getPublicKey.mock.calls[0][1]).toBe('admin.com')
    expect(w.getPublicKey.mock.calls[1][1]).toBe('admin.com')
    expect(w.createAction.mock.calls[0][1]).toBe('admin.com')
  })

  it('finalizes a signableTransaction via signAction when createAction defers signing', async () => {
    const w = walletStub()
    w.createAction.mockResolvedValue({ signableTransaction: { reference: 'ref-123' } })
    const f = await buildPaymentFrame(w as never, session(), 'awdl', 'admin.com')
    expect(w.signAction).toHaveBeenCalledWith(
      expect.objectContaining({ reference: 'ref-123' }),
      'admin.com'
    )
    expect(Array.from(f.transaction)).toEqual([9, 9, 9])
  })
})
