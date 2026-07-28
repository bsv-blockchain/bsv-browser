import {
  availableUtxos,
  derivationPrefixFor,
  fetchBalance,
  getInternalizedUtxos,
  getProcessedTransactions,
  getUtxosForAddress,
  sendToAddress,
  sweepAddress,
  wocConfigFor
} from '@/utils/pay/rails/address'

const woc = wocConfigFor('main')
const ADDRESS = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'

function mockFetchOnce(handler: (url: string) => { json?: unknown; text?: string }) {
  global.fetch = jest.fn(async (url: string) => {
    const r = handler(String(url))
    return {
      json: async () => r.json,
      text: async () => r.text ?? ''
    } as unknown as Response
  }) as unknown as typeof fetch
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe('getUtxosForAddress', () => {
  it('maps the WoC unspent shape and drops mempool-spent outputs', async () => {
    mockFetchOnce(() => ({
      json: {
        result: [
          { tx_hash: 'aa', tx_pos: 0, value: 1000, isSpentInMempoolTx: false },
          { tx_hash: 'bb', tx_pos: 1, value: 2000, isSpentInMempoolTx: true }
        ]
      }
    }))
    await expect(getUtxosForAddress(woc, ADDRESS)).resolves.toEqual([{ txid: 'aa', vout: 0, satoshis: 1000 }])
  })

  it('calls the network-specific unspent/all endpoint', async () => {
    mockFetchOnce(() => ({ json: { result: [] } }))
    await getUtxosForAddress(woc, ADDRESS)
    expect(global.fetch).toHaveBeenCalledWith(`https://api.whatsonchain.com/v1/bsv/main/address/${ADDRESS}/unspent/all`)
  })
})

describe('getInternalizedUtxos', () => {
  it('keys already-imported outputs as txid.outputIndex', async () => {
    const wallet = {
      listActions: jest.fn().mockResolvedValue({
        actions: [{ txid: 'aa', outputs: [{ outputIndex: 0 }, { outputIndex: 3 }] }]
      })
    }
    const set = await getInternalizedUtxos(wallet as never, 'admin.com', ADDRESS)
    expect([...set].sort()).toEqual(['aa.0', 'aa.3'])
  })

  it('queries by the address label with labelQueryMode all', async () => {
    const wallet = { listActions: jest.fn().mockResolvedValue({ actions: [] }) }
    await getInternalizedUtxos(wallet as never, 'admin.com', ADDRESS)
    expect(wallet.listActions).toHaveBeenCalledWith(
      { labels: [ADDRESS], labelQueryMode: 'all', includeOutputs: true, limit: 1000 },
      'admin.com'
    )
  })

  it('returns an empty set when listActions throws, so a read failure never blocks a sweep', async () => {
    const wallet = { listActions: jest.fn().mockRejectedValue(new Error('db')) }
    await expect(getInternalizedUtxos(wallet as never, 'admin.com', ADDRESS)).resolves.toEqual(new Set())
  })
})

describe('availableUtxos', () => {
  it('excludes outputs already internalized', () => {
    const all = [
      { txid: 'aa', vout: 0, satoshis: 10 },
      { txid: 'bb', vout: 1, satoshis: 20 }
    ]
    expect(availableUtxos(all, new Set(['aa.0']))).toEqual([{ txid: 'bb', vout: 1, satoshis: 20 }])
  })

  it('is identity when nothing has been internalized', () => {
    const all = [{ txid: 'aa', vout: 0, satoshis: 10 }]
    expect(availableUtxos(all, new Set())).toEqual(all)
  })
})

describe('fetchBalance', () => {
  it('sums only the not-yet-internalized outputs', async () => {
    mockFetchOnce(() => ({
      json: {
        result: [
          { tx_hash: 'aa', tx_pos: 0, value: 1000, isSpentInMempoolTx: false },
          { tx_hash: 'bb', tx_pos: 0, value: 500, isSpentInMempoolTx: false }
        ]
      }
    }))
    const wallet = {
      listActions: jest.fn().mockResolvedValue({ actions: [{ txid: 'aa', outputs: [{ outputIndex: 0 }] }] })
    }
    await expect(fetchBalance(wallet as never, 'admin.com', woc, ADDRESS)).resolves.toBe(500)
  })
})

describe('getProcessedTransactions', () => {
  it('sums output satoshis, reads the ts: label as an import time, and sorts newest first', async () => {
    const wallet = {
      listActions: jest.fn().mockResolvedValue({
        actions: [
          { txid: 'old', status: 'completed', outputs: [{ satoshis: 100 }], labels: ['ts:1000'] },
          { txid: 'new', status: 'completed', outputs: [{ satoshis: 50 }, { satoshis: 25 }], labels: ['ts:2000'] }
        ]
      })
    }
    const rows = await getProcessedTransactions(wallet as never, 'admin.com', ADDRESS)
    expect(rows.map(r => r.txid)).toEqual(['new', 'old'])
    expect(rows[0].satoshis).toBe(75)
    expect(rows[0].importedAt).toEqual(new Date(2000 * 1000))
  })

  it('returns [] rather than throwing when listActions fails', async () => {
    const wallet = { listActions: jest.fn().mockRejectedValue(new Error('db')) }
    await expect(getProcessedTransactions(wallet as never, 'admin.com', ADDRESS)).resolves.toEqual([])
  })
})

describe('sweepAddress', () => {
  const prefix = derivationPrefixFor('2026-07-28')

  function walletWithNothingImported() {
    return {
      listActions: jest.fn().mockResolvedValue({ actions: [] }),
      internalizeAction: jest.fn().mockResolvedValue({ accepted: true })
    }
  }

  it('imports nothing and reports zero when the address is empty', async () => {
    mockFetchOnce(() => ({ json: { result: [] } }))
    const wallet = walletWithNothingImported()
    await expect(
      sweepAddress({
        wallet: wallet as never,
        adminOriginator: 'admin.com',
        woc,
        address: ADDRESS,
        derivationPrefix: prefix
      })
    ).resolves.toEqual({ importedSatoshis: 0, failureCount: 0 })
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
  })

  it('internalizes with the legacy remittance, description and labels', async () => {
    // One UTXO, and a BEEF response the SDK can parse: use a real Beef built in
    // the test so this exercises the production merge path.
    const { Beef, Transaction } = require('@bsv/sdk')
    const tx = Transaction.fromHex(
      '0100000001000000000000000000000000000000000000000000000000000000000000000000000000000000000001e8030000000000001976a914' +
        '0000000000000000000000000000000000000000' +
        '88ac00000000'
    )
    const beef = new Beef()
    beef.mergeRawTx(tx.toBinary())
    const txid = tx.id('hex')

    mockFetchOnce(url =>
      url.includes('/unspent/all')
        ? { json: { result: [{ tx_hash: txid, tx_pos: 0, value: 1000, isSpentInMempoolTx: false }] } }
        : { text: Buffer.from(beef.toBinary()).toString('hex') }
    )

    const wallet = walletWithNothingImported()
    const result = await sweepAddress({
      wallet: wallet as never,
      adminOriginator: 'admin.com',
      woc,
      address: ADDRESS,
      derivationPrefix: prefix,
      nowSeconds: 1_700_000_000
    })

    expect(result.importedSatoshis).toBe(1000)
    const [args, originator] = wallet.internalizeAction.mock.calls[0]
    expect(originator).toBe('admin.com')
    expect(args.description).toBe('Legacy Bridge Payment')
    expect(args.labels).toEqual(['legacy', 'inbound', 'bsvbrowser', ADDRESS, 'ts:1700000000'])
    expect(args.outputs[0]).toMatchObject({
      outputIndex: 0,
      protocol: 'wallet payment',
      paymentRemittance: { derivationPrefix: prefix, derivationSuffix: 'bGVnYWN5' }
    })
    // The sender key is a fixed sentinel — PrivateKey(1)'s public key — not a real peer.
    expect(args.outputs[0].paymentRemittance.senderIdentityKey).toBe(
      new (require('@bsv/sdk').PrivateKey)(1).toPublicKey().toString()
    )
  })

  it('counts a rejected internalize as a failure and imports nothing', async () => {
    const { Beef, Transaction, PrivateKey } = require('@bsv/sdk')
    void PrivateKey
    const tx = Transaction.fromHex(
      '0100000001000000000000000000000000000000000000000000000000000000000000000000000000000000000001e8030000000000001976a914' +
        '0000000000000000000000000000000000000000' +
        '88ac00000000'
    )
    const beef = new Beef()
    beef.mergeRawTx(tx.toBinary())
    mockFetchOnce(url =>
      url.includes('/unspent/all')
        ? { json: { result: [{ tx_hash: tx.id('hex'), tx_pos: 0, value: 1000, isSpentInMempoolTx: false }] } }
        : { text: Buffer.from(beef.toBinary()).toString('hex') }
    )
    const wallet = {
      listActions: jest.fn().mockResolvedValue({ actions: [] }),
      internalizeAction: jest.fn().mockResolvedValue({ accepted: false })
    }
    await expect(
      sweepAddress({
        wallet: wallet as never,
        adminOriginator: 'admin.com',
        woc,
        address: ADDRESS,
        derivationPrefix: prefix
      })
    ).resolves.toEqual({ importedSatoshis: 0, failureCount: 1 })
  })

  it('skips outputs already internalized, so a second sweep is a no-op', async () => {
    mockFetchOnce(() => ({
      json: { result: [{ tx_hash: 'aa', tx_pos: 0, value: 1000, isSpentInMempoolTx: false }] }
    }))
    const wallet = {
      listActions: jest.fn().mockResolvedValue({ actions: [{ txid: 'aa', outputs: [{ outputIndex: 0 }] }] }),
      internalizeAction: jest.fn()
    }
    await expect(
      sweepAddress({
        wallet: wallet as never,
        adminOriginator: 'admin.com',
        woc,
        address: ADDRESS,
        derivationPrefix: prefix
      })
    ).resolves.toEqual({ importedSatoshis: 0, failureCount: 0 })
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
  })
})

describe('sendToAddress', () => {
  it('locks a P2PKH output for the recipient and labels the action legacy/outbound', async () => {
    const wallet = { createAction: jest.fn().mockResolvedValue({}) }
    await sendToAddress({ wallet: wallet as never, adminOriginator: 'admin.com', address: ADDRESS, satoshis: 1234 })
    const [args, originator] = wallet.createAction.mock.calls[0]
    expect(originator).toBe('admin.com')
    expect(args.description).toBe('Send BSV to address')
    expect(args.labels).toEqual(['legacy', 'outbound'])
    expect(args.outputs).toEqual([
      {
        lockingScript: new (require('@bsv/sdk').P2PKH)().lock(ADDRESS).toHex(),
        satoshis: 1234,
        outputDescription: 'BSV for recipient address'
      }
    ])
  })

  it('refuses a non-positive amount before touching the wallet', async () => {
    const wallet = { createAction: jest.fn() }
    await expect(
      sendToAddress({ wallet: wallet as never, adminOriginator: 'admin.com', address: ADDRESS, satoshis: 0 })
    ).rejects.toThrow(/amount/i)
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('refuses an invalid address before touching the wallet', async () => {
    const wallet = { createAction: jest.fn() }
    await expect(
      sendToAddress({ wallet: wallet as never, adminOriginator: 'admin.com', address: 'nope', satoshis: 10 })
    ).rejects.toThrow(/address/i)
    expect(wallet.createAction).not.toHaveBeenCalled()
  })
})
