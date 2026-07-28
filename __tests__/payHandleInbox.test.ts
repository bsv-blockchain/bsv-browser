import {
  MAX_AUTO_ATTEMPTS,
  autoAcceptInbox,
  discardIncoming,
  needsAttention,
  type InboxAttempt
} from '@/utils/pay/rails/handle'

const KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

const payment = (id: string) =>
  ({
    messageId: id,
    sender: KEY,
    token: {
      transaction: [1, 2, 3],
      outputIndex: 0,
      customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' },
      amount: 500
    }
  }) as never

function harness(options: { failIds?: string[] } = {}) {
  const fail = new Set(options.failIds ?? [])
  const wallet = {
    internalizeAction: jest.fn(async (args: any) => {
      // The transaction is the only thing distinguishing calls here; identify the
      // payment by the id the caller threaded through the token instead.
      if (fail.has(String(args.__id))) throw new Error('storage locked')
      return { accepted: true }
    })
  }
  const client = {
    acknowledgeMessage: jest.fn().mockResolvedValue(undefined),
    listIncomingPayments: jest.fn().mockResolvedValue([])
  }
  return { wallet, client }
}

/**
 * autoAcceptInbox delegates the actual credit to an injected `accept`, so these
 * tests drive the POLICY — what is attempted, what is skipped, what is recorded —
 * without reaching into the wallet.
 */
function accepter(failIds: string[] = []) {
  const fail = new Set(failIds)
  return jest.fn(async (p: { messageId: string }) => {
    if (fail.has(String(p.messageId))) throw new Error('storage locked')
  })
}

describe('needsAttention', () => {
  it('is false for a payment never attempted', () => {
    expect(needsAttention(undefined)).toBe(false)
  })

  it('is false below the automatic-attempt ceiling', () => {
    expect(needsAttention({ attempts: MAX_AUTO_ATTEMPTS - 1, error: 'x' })).toBe(false)
  })

  it('is true at the ceiling — the point where a human is asked', () => {
    expect(needsAttention({ attempts: MAX_AUTO_ATTEMPTS, error: 'x' })).toBe(true)
  })

  it('pins the ceiling so raising it has to be deliberate', () => {
    expect(MAX_AUTO_ATTEMPTS).toBe(2)
  })
})

describe('autoAcceptInbox', () => {
  it('accepts every listed payment with no user action', async () => {
    const accept = accepter()
    const result = await autoAcceptInbox({
      payments: [payment('a'), payment('b')],
      attempts: {},
      accept
    })
    expect(accept).toHaveBeenCalledTimes(2)
    expect(result.accepted).toBe(2)
    expect(result.attempts).toEqual({})
  })

  it('records an attempt and the error when a credit fails, and does not count it accepted', async () => {
    const result = await autoAcceptInbox({
      payments: [payment('a')],
      attempts: {},
      accept: accepter(['a'])
    })
    expect(result.accepted).toBe(0)
    expect(result.attempts.a).toEqual({ attempts: 1, error: 'storage locked' })
  })

  it('carries the count forward across polls, so failures escalate rather than loop', async () => {
    const first = await autoAcceptInbox({ payments: [payment('a')], attempts: {}, accept: accepter(['a']) })
    const second = await autoAcceptInbox({
      payments: [payment('a')],
      attempts: first.attempts,
      accept: accepter(['a'])
    })
    expect(second.attempts.a.attempts).toBe(2)
    expect(needsAttention(second.attempts.a)).toBe(true)
  })

  it('stops attempting once a payment needs attention — no unbounded retry loop', async () => {
    const accept = accepter(['a'])
    const attempts: Record<string, InboxAttempt> = { a: { attempts: MAX_AUTO_ATTEMPTS, error: 'storage locked' } }
    const result = await autoAcceptInbox({ payments: [payment('a')], attempts, accept })
    expect(accept).not.toHaveBeenCalled()
    // The state is preserved verbatim so the row keeps its error text.
    expect(result.attempts.a).toEqual({ attempts: MAX_AUTO_ATTEMPTS, error: 'storage locked' })
  })

  it('clears a payment’s failure state once it finally succeeds', async () => {
    const attempts: Record<string, InboxAttempt> = { a: { attempts: 1, error: 'storage locked' } }
    const result = await autoAcceptInbox({ payments: [payment('a')], attempts, accept: accepter() })
    expect(result.accepted).toBe(1)
    expect(result.attempts.a).toBeUndefined()
  })

  it('one bad payment does not stop the good ones being credited', async () => {
    const accept = accepter(['bad'])
    const result = await autoAcceptInbox({
      payments: [payment('bad'), payment('good')],
      attempts: {},
      accept
    })
    expect(result.accepted).toBe(1)
    expect(result.attempts.bad.attempts).toBe(1)
    expect(result.attempts.good).toBeUndefined()
  })

  it('forgets state for payments no longer in the box, so the map cannot grow forever', async () => {
    const attempts: Record<string, InboxAttempt> = {
      gone: { attempts: MAX_AUTO_ATTEMPTS, error: 'x' },
      here: { attempts: 1, error: 'y' }
    }
    const result = await autoAcceptInbox({ payments: [payment('here')], attempts, accept: accepter(['here']) })
    expect(result.attempts.gone).toBeUndefined()
    expect(result.attempts.here.attempts).toBe(2)
  })

  it('does nothing on an empty box', async () => {
    const accept = accepter()
    const result = await autoAcceptInbox({ payments: [], attempts: {}, accept })
    expect(accept).not.toHaveBeenCalled()
    expect(result).toEqual({ accepted: 0, attempts: {} })
  })

  it('allows a forced retry of a payment that had given up', async () => {
    const accept = accepter()
    const attempts: Record<string, InboxAttempt> = { a: { attempts: MAX_AUTO_ATTEMPTS, error: 'x' } }
    const result = await autoAcceptInbox({ payments: [payment('a')], attempts, accept, force: ['a'] })
    expect(accept).toHaveBeenCalledTimes(1)
    expect(result.accepted).toBe(1)
    expect(result.attempts.a).toBeUndefined()
  })

  it('a forced retry that fails again lands back in needs-attention', async () => {
    const attempts: Record<string, InboxAttempt> = { a: { attempts: MAX_AUTO_ATTEMPTS, error: 'x' } }
    const result = await autoAcceptInbox({
      payments: [payment('a')],
      attempts,
      accept: accepter(['a']),
      force: ['a']
    })
    expect(result.attempts.a.attempts).toBe(MAX_AUTO_ATTEMPTS + 1)
    expect(needsAttention(result.attempts.a)).toBe(true)
  })
})

describe('discardIncoming', () => {
  it('acknowledges the message without ever crediting it', async () => {
    const { wallet, client } = harness()
    await discardIncoming(client as never, payment('a'))
    expect(client.acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['a'] })
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
  })

  it('propagates a failed acknowledge so the row stays on screen', async () => {
    const client = { acknowledgeMessage: jest.fn().mockRejectedValue(new Error('offline')) }
    await expect(discardIncoming(client as never, payment('a'))).rejects.toThrow('offline')
  })
})
