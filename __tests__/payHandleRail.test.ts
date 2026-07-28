import {
  DEFAULT_MESSAGE_BOX_URL,
  MESSAGE_BOX_URL_KEY,
  NO_MESSAGE_BOX,
  acceptWithRetry,
  internalizeIncoming,
  peerPayLinkFor,
  retryDelivery,
  sendViaHandle
} from '@/utils/pay/rails/handle'
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
    expect(DEFAULT_MESSAGE_BOX_URL).toBe('https://messagebox.babbage.systems')
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

describe('sendViaHandle', () => {
  const token = {
    customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' },
    transaction: [1, 2, 3],
    amount: 700
  }

  it('persists to the outbox BEFORE delivery is attempted', async () => {
    const s = fakeStorage()
    const order: string[] = []
    const client = {
      createPaymentToken: jest.fn(async () => {
        order.push('create')
        return token
      }),
      sendMessage: jest.fn(async () => {
        order.push('send')
        // The outbox entry must already exist at this point, or a crash here
        // loses the derivation data and the money with it.
        expect(await getOutboxEntries(s)).toHaveLength(1)
      })
    }

    await sendViaHandle({
      client: client as never,
      storage: s,
      recipient: KEY,
      satoshis: 700,
      messageBoxUrl: 'https://mb'
    })

    expect(order).toEqual(['create', 'send'])
  })

  it('marks the entry sent once delivery succeeds', async () => {
    const s = fakeStorage()
    const client = {
      createPaymentToken: jest.fn().mockResolvedValue(token),
      sendMessage: jest.fn().mockResolvedValue(undefined)
    }
    await sendViaHandle({
      client: client as never,
      storage: s,
      recipient: KEY,
      satoshis: 700,
      messageBoxUrl: 'https://mb'
    })
    expect((await getOutboxEntries(s))[0].status).toBe('sent')
  })

  it('leaves the entry unsent — and rethrows — when delivery fails', async () => {
    const s = fakeStorage()
    const client = {
      createPaymentToken: jest.fn().mockResolvedValue(token),
      sendMessage: jest.fn().mockRejectedValue(new Error('offline'))
    }
    await expect(
      sendViaHandle({ client: client as never, storage: s, recipient: KEY, satoshis: 700, messageBoxUrl: 'https://mb' })
    ).rejects.toThrow('offline')
    const entries = await getOutboxEntries(s)
    expect(entries).toHaveLength(1)
    expect(entries[0].status).toBe('unsent')
  })

  it('sends to the payment_inbox message box as JSON', async () => {
    const s = fakeStorage()
    const client = {
      createPaymentToken: jest.fn().mockResolvedValue(token),
      sendMessage: jest.fn().mockResolvedValue(undefined)
    }
    await sendViaHandle({
      client: client as never,
      storage: s,
      recipient: KEY,
      satoshis: 700,
      messageBoxUrl: 'https://mb'
    })
    expect(client.sendMessage).toHaveBeenCalledWith({
      recipient: KEY,
      messageBox: 'payment_inbox',
      body: JSON.stringify(token)
    })
  })

  it('refuses a non-positive amount before minting a token', async () => {
    const s = fakeStorage()
    const client = { createPaymentToken: jest.fn(), sendMessage: jest.fn() }
    await expect(
      sendViaHandle({ client: client as never, storage: s, recipient: KEY, satoshis: 0, messageBoxUrl: 'https://mb' })
    ).rejects.toThrow(/amount/i)
    expect(client.createPaymentToken).not.toHaveBeenCalled()
  })
})

describe('retryDelivery', () => {
  it('marks sent on success', async () => {
    const s = fakeStorage()
    const client = {
      createPaymentToken: jest.fn().mockResolvedValue({
        customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' },
        transaction: [1],
        amount: 5
      }),
      sendMessage: jest.fn().mockRejectedValueOnce(new Error('offline'))
    }
    await expect(
      sendViaHandle({ client: client as never, storage: s, recipient: KEY, satoshis: 5, messageBoxUrl: 'https://mb' })
    ).rejects.toThrow()

    const entry = (await getOutboxEntries(s))[0]
    client.sendMessage = jest.fn().mockResolvedValue(undefined)
    await retryDelivery({ client: client as never, storage: s, entry })
    expect((await getOutboxEntries(s))[0].status).toBe('sent')
  })

  it('records the error and rethrows on a failed retry', async () => {
    const s = fakeStorage()
    const client = {
      createPaymentToken: jest.fn().mockResolvedValue({
        customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' },
        transaction: [1],
        amount: 5
      }),
      sendMessage: jest.fn().mockRejectedValue(new Error('still offline'))
    }
    await expect(
      sendViaHandle({ client: client as never, storage: s, recipient: KEY, satoshis: 5, messageBoxUrl: 'https://mb' })
    ).rejects.toThrow()
    const entry = (await getOutboxEntries(s))[0]

    await expect(retryDelivery({ client: client as never, storage: s, entry })).rejects.toThrow('still offline')
    const after = (await getOutboxEntries(s))[0]
    expect(after.status).toBe('unsent')
    expect(after.lastError).toBe('still offline')
    expect(after.lastAttemptAt).toBeTruthy()
  })
})
