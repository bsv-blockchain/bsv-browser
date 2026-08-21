import {
  DEFAULT_MESSAGE_BOX_URL,
  MESSAGE_BOX_URL_KEY,
  NO_MESSAGE_BOX,
  acceptWithRetry,
  internalizeIncoming,
  cancelOutboxPayment,
  isMessageBoxNetworkError,
  peerPayLinkFor,
  retryDelivery,
  sendViaHandle
} from '@/utils/pay/rails/handle'
import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import { getOutboxEntries } from '@/utils/peerpay/outbox'
import { validatePeerPayURI } from '@/utils/parsePeerPayURI'

// secp256k1 generator point, in the lowercase hex PublicKey.toString() emits —
// which is also the only form utils/parsePeerPayURI.ts's identity-key regex accepts.
const KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getKeyValue: async (k: string) => map.get(k),
    setKeyValue: async (k: string, v: string) => void map.set(k, v)
  }
}

describe('peerPayLinkFor', () => {
  it('round-trips through the app’s own URI validator', () => {
    const result = validatePeerPayURI(peerPayLinkFor(KEY))
    expect(result.isPeerPay).toBe(true)
    expect(result.identityKey).toBe(KEY)
    expect(result.errors).toEqual({})
  })

  it('carries an amount when one is named', () => {
    const result = validatePeerPayURI(peerPayLinkFor(KEY, 5000))
    expect(result.sats).toBe(5000)
    expect(result.errors).toEqual({})
  })

  it('omits the query entirely for an open request', () => {
    expect(peerPayLinkFor(KEY)).toBe(`peerpay:${KEY}`)
  })

  it('omits a non-positive amount rather than emitting sats=0', () => {
    expect(peerPayLinkFor(KEY, 0)).toBe(`peerpay:${KEY}`)
  })
})

describe('message box constants', () => {
  it('keeps the storage key and default host the old screen used', () => {
    expect(MESSAGE_BOX_URL_KEY).toBe('message_box_url')
    expect(DEFAULT_MESSAGE_BOX_URL).toBe('https://gmb.bsvblockchain.tech')
    expect(NO_MESSAGE_BOX).toBe('noMessageBox')
  })
})

describe('internalizeIncoming', () => {
  const payment = {
    messageId: 'm1',
    sender: KEY,
    token: {
      transaction: [1, 2, 3],
      outputIndex: 2,
      customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' },
      amount: 500
    }
  } as never

  it('internalizes as a wallet payment with the peerpay label, then acknowledges', async () => {
    const wallet = { internalizeAction: jest.fn().mockResolvedValue({ accepted: true }) }
    const client = { acknowledgeMessage: jest.fn().mockResolvedValue(undefined) }

    await internalizeIncoming(wallet as never, client as never, 'admin.com', payment, 'Dinner')

    const [args, originator] = wallet.internalizeAction.mock.calls[0]
    expect(originator).toBe('admin.com')
    expect(args.description).toBe('Dinner')
    expect(args.labels).toEqual(['peerpay'])
    expect(args.tx).toEqual([1, 2, 3])
    expect(args.outputs[0]).toEqual({
      outputIndex: 2,
      protocol: 'wallet payment',
      paymentRemittance: { derivationPrefix: 'p', derivationSuffix: 's', senderIdentityKey: KEY }
    })
    expect(client.acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['m1'] })
  })

  it('prefers a note carried in the token over the default description', async () => {
    const wallet = { internalizeAction: jest.fn().mockResolvedValue({ accepted: true }) }
    const client = { acknowledgeMessage: jest.fn().mockResolvedValue(undefined) }
    const noted = { ...(payment as any), token: { ...(payment as any).token, note: 'Dinner at the pier' } }
    await internalizeIncoming(wallet as never, client as never, 'admin.com', noted, 'Identity Payment')
    expect(wallet.internalizeAction.mock.calls[0][0].description).toBe('Dinner at the pier')
  })

  it('defaults outputIndex to 0 when the token omits it', async () => {
    const wallet = { internalizeAction: jest.fn().mockResolvedValue({}) }
    const client = { acknowledgeMessage: jest.fn().mockResolvedValue(undefined) }
    const noIndex = { ...(payment as any), token: { ...(payment as any).token, outputIndex: undefined } }
    await internalizeIncoming(wallet as never, client as never, 'admin.com', noIndex, 'x')
    expect(wallet.internalizeAction.mock.calls[0][0].outputs[0].outputIndex).toBe(0)
  })

  it('does not acknowledge when the internalize fails', async () => {
    const wallet = { internalizeAction: jest.fn().mockRejectedValue(new Error('nope')) }
    const client = { acknowledgeMessage: jest.fn() }
    await expect(internalizeIncoming(wallet as never, client as never, 'admin.com', payment, 'x')).rejects.toThrow()
    expect(client.acknowledgeMessage).not.toHaveBeenCalled()
  })
})

describe('acceptWithRetry', () => {
  const payment = { messageId: 'm1' } as never

  it('accepts on the first attempt', async () => {
    const internalize = jest.fn().mockResolvedValue(undefined)
    const client = { listIncomingPayments: jest.fn() }
    await acceptWithRetry(client as never, 'https://mb', payment, 'note', internalize)
    expect(internalize).toHaveBeenCalledTimes(1)
    expect(client.listIncomingPayments).not.toHaveBeenCalled()
  })

  it('re-lists and retries with the fresh payment when the first attempt fails', async () => {
    const fresh = { messageId: 'm1', fresh: true }
    const internalize = jest.fn().mockRejectedValueOnce(new Error('stale')).mockResolvedValueOnce(undefined)
    const client = { listIncomingPayments: jest.fn().mockResolvedValue([fresh]) }
    await acceptWithRetry(client as never, 'https://mb', payment, 'note', internalize)
    expect(internalize).toHaveBeenNthCalledWith(2, fresh, 'note')
  })

  it('throws when the payment is gone on refresh', async () => {
    const internalize = jest.fn().mockRejectedValue(new Error('stale'))
    const client = { listIncomingPayments: jest.fn().mockResolvedValue([]) }
    await expect(acceptWithRetry(client as never, 'https://mb', payment, 'n', internalize)).rejects.toThrow(
      /not found/i
    )
  })
})

function fakeWallet(overrides: Record<string, unknown> = {}) {
  const makeTx = (sats: number) => {
    const tx = new Transaction()
    tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: sats })
    return tx
  }
  return {
    getPublicKey: jest.fn().mockResolvedValue({ publicKey: KEY }),
    createAction: jest.fn(async (args: any) => {
      if (args?.options?.sendWith) return {}
      // The wallet rewrites a send-max sentinel to what the inputs can fund.
      const requested = args.outputs[0].satoshis
      const sats = requested === 2099999999999999 ? 4990 : requested
      const tx = makeTx(sats)
      return { txid: tx.id('hex'), tx: tx.toAtomicBEEF() }
    }),
    listActions: jest.fn().mockResolvedValue({ actions: [] }),
    abortAction: jest.fn().mockResolvedValue({}),
    ...overrides
  }
}

const sendArgs = (w: ReturnType<typeof fakeWallet>, client: unknown, s: ReturnType<typeof fakeStorage>, sats = 700) =>
  ({
    wallet: w as never,
    adminOriginator: 'admin.com',
    client: client as never,
    storage: s,
    recipient: KEY,
    satoshis: sats,
    messageBoxUrl: 'https://mb'
  }) as const

describe('sendViaHandle', () => {
  it('mints with noSend and persists to the outbox BEFORE delivery is attempted', async () => {
    const s = fakeStorage()
    const w = fakeWallet()
    const client = {
      sendMessage: jest.fn(async () => {
        // The outbox entry must already exist at this point, or a crash here
        // loses the derivation data and the money with it.
        expect(await getOutboxEntries(s)).toHaveLength(1)
      })
    }
    await sendViaHandle(sendArgs(w, client, s))
    const mint = w.createAction.mock.calls[0][0] as any
    expect(mint.options).toMatchObject({ noSend: true, randomizeOutputs: false })
    expect(mint.labels).toEqual(['peerpay'])
  })

  it('broadcasts (sendWith) only AFTER delivery succeeds, then marks the entry sent', async () => {
    const s = fakeStorage()
    const order: string[] = []
    const w = fakeWallet()
    const inner = w.createAction.getMockImplementation()!
    w.createAction.mockImplementation(async (args: any) => {
      order.push(args?.options?.sendWith ? 'broadcast' : 'mint')
      return await inner(args)
    })
    const client = { sendMessage: jest.fn(async () => void order.push('deliver')) }
    await sendViaHandle(sendArgs(w, client, s))
    expect(order).toEqual(['mint', 'deliver', 'broadcast'])
    const entry = (await getOutboxEntries(s))[0]
    expect(entry.status).toBe('sent')
    expect(entry.txid).toBeTruthy()
  })

  it('leaves the entry unsent and unbroadcast — and rethrows — when delivery fails', async () => {
    const s = fakeStorage()
    const w = fakeWallet()
    const client = { sendMessage: jest.fn().mockRejectedValue(new Error('offline')) }
    await expect(sendViaHandle(sendArgs(w, client, s))).rejects.toThrow('offline')
    const entries = await getOutboxEntries(s)
    expect(entries).toHaveLength(1)
    expect(entries[0].status).toBe('unsent')
    expect(entries[0].delivered).not.toBe(true)
    // Only the mint happened; nothing was broadcast.
    const sendWithCalls = w.createAction.mock.calls.filter((c: any[]) => c[0]?.options?.sendWith)
    expect(sendWithCalls).toHaveLength(0)
  })

  it('records delivered=true when the broadcast fails, so retry does not re-deliver', async () => {
    const s = fakeStorage()
    const w = fakeWallet()
    const inner = w.createAction.getMockImplementation()!
    w.createAction.mockImplementation(async (args: any) => {
      if (args?.options?.sendWith) throw new Error('broadcast failed')
      return await inner(args)
    })
    const client = { sendMessage: jest.fn().mockResolvedValue(undefined) }
    await expect(sendViaHandle(sendArgs(w, client, s))).rejects.toThrow('broadcast failed')
    const entry = (await getOutboxEntries(s))[0]
    expect(entry.status).toBe('unsent')
    expect(entry.delivered).toBe(true)
  })

  it('sends to the payment_inbox message box as JSON', async () => {
    const s = fakeStorage()
    const w = fakeWallet()
    const client = { sendMessage: jest.fn().mockResolvedValue(undefined) }
    await sendViaHandle(sendArgs(w, client, s))
    const call = client.sendMessage.mock.calls[0][0] as { recipient: string; messageBox: string; body: string }
    expect(call.recipient).toBe(KEY)
    expect(call.messageBox).toBe('payment_inbox')
    const body = JSON.parse(call.body)
    expect(body.amount).toBe(700)
    expect(body.customInstructions.derivationPrefix).toBeTruthy()
    expect(body.customInstructions.derivationSuffix).toBeTruthy()
  })

  it('refuses a non-positive amount before touching the wallet', async () => {
    const s = fakeStorage()
    const w = fakeWallet()
    const client = { sendMessage: jest.fn() }
    await expect(sendViaHandle(sendArgs(w, client, s, 0))).rejects.toThrow(/amount/i)
    expect(w.createAction).not.toHaveBeenCalled()
  })

  it('uses the note as the action description and carries it in the token', async () => {
    const s = fakeStorage()
    const w = fakeWallet()
    const client = { sendMessage: jest.fn().mockResolvedValue(undefined) }
    await sendViaHandle({ ...sendArgs(w, client, s), note: 'Dinner at the pier' })
    expect((w.createAction.mock.calls[0][0] as any).description).toBe('Dinner at the pier')
    const body = JSON.parse((client.sendMessage.mock.calls[0][0] as { body: string }).body)
    expect(body.note).toBe('Dinner at the pier')
  })

  it('defaults the description to the recipient name, then to the key prefix', async () => {
    const s = fakeStorage()
    const w = fakeWallet()
    const client = { sendMessage: jest.fn().mockResolvedValue(undefined) }
    await sendViaHandle({ ...sendArgs(w, client, s), recipientName: 'Alice' })
    expect((w.createAction.mock.calls[0][0] as any).description).toBe('Pay Alice')

    const w2 = fakeWallet()
    await sendViaHandle(sendArgs(w2, client, fakeStorage()))
    expect((w2.createAction.mock.calls[0][0] as any).description).toBe(`Pay ${KEY.slice(0, 8)}`)
  })

  it('keeps a very short note valid by space-padding — never by decorating it', async () => {
    const s = fakeStorage()
    const w = fakeWallet()
    const client = { sendMessage: jest.fn().mockResolvedValue(undefined) }
    await sendViaHandle({ ...sendArgs(w, client, s), note: 'tea' })
    const description = (w.createAction.mock.calls[0][0] as any).description as string
    expect(description.length).toBeGreaterThanOrEqual(5)
    // The note goes in verbatim: no prefix, nothing but trailing padding.
    expect(description.trimEnd()).toBe('tea')
  })

  it('reads the real send-max figure off output 0 of the minted transaction', async () => {
    const s = fakeStorage()
    const w = fakeWallet()
    const client = { sendMessage: jest.fn().mockResolvedValue(undefined) }
    const result = await sendViaHandle(sendArgs(w, client, s, 2099999999999999))
    expect(result.satoshis).toBe(4990)
    const delivered = JSON.parse((client.sendMessage.mock.calls[0][0] as { body: string }).body)
    expect(delivered.amount).toBe(4990)
    expect((await getOutboxEntries(s))[0].token.amount).toBe(4990)
  })
})

describe('isMessageBoxNetworkError', () => {
  it('recognises the auth round-trip failing against an unreachable host', () => {
    // The exact shape observed on-device with a mistyped message box URL.
    const e = new Error(
      'Network error while sending authenticated request to https://gmb.bsvblockchain.techd/.well-known/auth: Network request failed'
    )
    expect(isMessageBoxNetworkError(e)).toBe(true)
  })

  it('recognises whatwg-fetch TypeError and plain timeouts', () => {
    expect(isMessageBoxNetworkError(new TypeError('Network request failed'))).toBe(true)
    expect(isMessageBoxNetworkError(new Error('Request timed out'))).toBe(true)
  })

  it('classifies persisted lastError strings the same way', () => {
    // Outbox rows store the failure as a string; the row copy maps it too.
    expect(isMessageBoxNetworkError('Network request failed')).toBe(true)
    expect(isMessageBoxNetworkError('Invalid signature')).toBe(false)
  })

  it('leaves real payment errors alone', () => {
    expect(isMessageBoxNetworkError(new Error('Invalid amount'))).toBe(false)
    expect(isMessageBoxNetworkError(new Error('Insufficient funds'))).toBe(false)
    expect(isMessageBoxNetworkError(null)).toBe(false)
  })
})

describe('retryDelivery', () => {
  const stuckEntry = async (s: ReturnType<typeof fakeStorage>, w: ReturnType<typeof fakeWallet>) => {
    const client = { sendMessage: jest.fn().mockRejectedValueOnce(new Error('offline')) }
    await expect(sendViaHandle(sendArgs(w, client, s, 5))).rejects.toThrow()
    return (await getOutboxEntries(s))[0]
  }

  it('resumes from delivery, broadcasts, and marks sent', async () => {
    const s = fakeStorage()
    const w = fakeWallet()
    const entry = await stuckEntry(s, w)
    const client = { sendMessage: jest.fn().mockResolvedValue(undefined) }
    await retryDelivery({ wallet: w as never, adminOriginator: 'admin.com', client: client as never, storage: s, entry })
    expect((await getOutboxEntries(s))[0].status).toBe('sent')
    expect(client.sendMessage).toHaveBeenCalledTimes(1)
    const sendWithCalls = w.createAction.mock.calls.filter((c: any[]) => c[0]?.options?.sendWith)
    expect(sendWithCalls).toHaveLength(1)
    expect(sendWithCalls[0][0].options.sendWith).toEqual([entry.txid])
  })

  it('skips re-delivery for an entry the recipient already has', async () => {
    const s = fakeStorage()
    const w = fakeWallet()
    const entry = { ...(await stuckEntry(s, w)), delivered: true }
    const client = { sendMessage: jest.fn() }
    await retryDelivery({ wallet: w as never, adminOriginator: 'admin.com', client: client as never, storage: s, entry })
    expect(client.sendMessage).not.toHaveBeenCalled()
    expect((await getOutboxEntries(s))[0].status).toBe('sent')
  })

  it('only re-delivers a legacy entry (no txid) — its transaction was broadcast at creation', async () => {
    const s = fakeStorage()
    const w = fakeWallet()
    const entry = await stuckEntry(s, w)
    delete (entry as any).txid
    const client = { sendMessage: jest.fn().mockResolvedValue(undefined) }
    await retryDelivery({ wallet: w as never, adminOriginator: 'admin.com', client: client as never, storage: s, entry })
    const sendWithCalls = w.createAction.mock.calls.filter((c: any[]) => c[0]?.options?.sendWith)
    expect(sendWithCalls).toHaveLength(0)
    expect((await getOutboxEntries(s))[0].status).toBe('sent')
  })

  it('records the error and rethrows on a failed retry', async () => {
    const s = fakeStorage()
    const w = fakeWallet()
    const entry = await stuckEntry(s, w)
    const client = { sendMessage: jest.fn().mockRejectedValue(new Error('still offline')) }
    await expect(
      retryDelivery({ wallet: w as never, adminOriginator: 'admin.com', client: client as never, storage: s, entry })
    ).rejects.toThrow('still offline')
    const after = (await getOutboxEntries(s))[0]
    expect(after.status).toBe('unsent')
    expect(after.lastError).toBe('still offline')
    expect(after.lastAttemptAt).toBeTruthy()
  })
})

describe('cancelOutboxPayment', () => {
  const stuckEntry = async (s: ReturnType<typeof fakeStorage>, w: ReturnType<typeof fakeWallet>) => {
    const client = { sendMessage: jest.fn().mockRejectedValueOnce(new Error('offline')) }
    await expect(sendViaHandle(sendArgs(w, client, s, 5))).rejects.toThrow()
    return (await getOutboxEntries(s))[0]
  }

  it('aborts the noSend action for an undelivered entry and removes it', async () => {
    const s = fakeStorage()
    const w = fakeWallet()
    const entry = await stuckEntry(s, w)
    w.listActions.mockResolvedValue({ actions: [{ txid: entry.txid, reference: 'ref-1' }] })
    const result = await cancelOutboxPayment({ wallet: w as never, adminOriginator: 'admin.com', storage: s, entry })
    expect(result.aborted).toBe(true)
    expect(w.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, 'admin.com')
    expect(await getOutboxEntries(s)).toHaveLength(0)
  })

  it('never aborts once the token was delivered — the recipient holds it', async () => {
    const s = fakeStorage()
    const w = fakeWallet()
    const entry = { ...(await stuckEntry(s, w)), delivered: true }
    const result = await cancelOutboxPayment({ wallet: w as never, adminOriginator: 'admin.com', storage: s, entry })
    expect(result.aborted).toBe(false)
    expect(w.abortAction).not.toHaveBeenCalled()
    expect(await getOutboxEntries(s)).toHaveLength(0)
  })

  it('still removes the entry when the abort itself fails', async () => {
    const s = fakeStorage()
    const w = fakeWallet()
    const entry = await stuckEntry(s, w)
    w.listActions.mockRejectedValue(new Error('storage busy'))
    const result = await cancelOutboxPayment({ wallet: w as never, adminOriginator: 'admin.com', storage: s, entry })
    expect(result.aborted).toBe(false)
    expect(await getOutboxEntries(s)).toHaveLength(0)
  })
})
