import { buildPaymentFrame } from '@/utils/localpay/build'
import { mintSession } from '@/utils/localpay/session'

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
})
