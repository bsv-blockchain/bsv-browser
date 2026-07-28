import { awdlTransport } from '@/utils/localpay/transport/awdl'
import { AckError } from '@/utils/localpay/transport/types'
import { mintSession } from '@/utils/localpay/session'
import type { PaymentFrame } from '@/utils/localpay/codec'
import type { LocalPayTransport } from 'react-native-localpay-transport'

jest.mock('react-native-localpay-transport', () => ({
  getLocalPayTransport: jest.fn(),
}))

const { getLocalPayTransport } = jest.requireMock('react-native-localpay-transport') as {
  getLocalPayTransport: jest.Mock
}

function fakeNative(overrides: Partial<LocalPayTransport> = {}) {
  return {
    isSupported: () => true,
    startListening: jest.fn(),
    stopListening: jest.fn().mockResolvedValue(undefined),
    sendFrame: jest.fn(),
    ...overrides,
  }
}

const session = mintSession({
  identityKey: '02'.padEnd(66, 'd'),
  amount: 1,
  derivationPrefix: 'cA',
  derivationSuffix: 'cw',
  supportsAwdl: true,
})

const frame: PaymentFrame = {
  version: 1,
  senderIdentityKey: '02'.padEnd(66, 'e'),
  amount: 1,
  outputIndex: 0,
  derivationPrefix: 'cA',
  derivationSuffix: 'cw',
  transaction: new Uint8Array([1, 2, 3]),
}

function toAckBase64(payload: unknown): string {
  return globalThis.btoa(JSON.stringify(payload))
}

describe('awdlTransport.send', () => {
  afterEach(() => jest.clearAllMocks())

  it('rejects immediately on an already-aborted signal without calling sendFrame', async () => {
    const native = fakeNative()
    getLocalPayTransport.mockReturnValue(native)
    const controller = new AbortController()
    controller.abort()

    await expect(awdlTransport.send(session, frame, controller.signal)).rejects.toThrow('cancelled')
    expect(native.sendFrame).not.toHaveBeenCalled()
  })

  it.each([null, 42, [], {}])('throws AckError for a malformed ack payload %p', async bad => {
    const native = fakeNative({ sendFrame: jest.fn().mockResolvedValue(toAckBase64(bad)) })
    getLocalPayTransport.mockReturnValue(native)

    await expect(awdlTransport.send(session, frame, new AbortController().signal)).rejects.toThrow(AckError)
  })

  it('resolves a well-formed success ack', async () => {
    const native = fakeNative({ sendFrame: jest.fn().mockResolvedValue(toAckBase64({ ok: true })) })
    getLocalPayTransport.mockReturnValue(native)

    await expect(awdlTransport.send(session, frame, new AbortController().signal)).resolves.toEqual({ ok: true })
  })

  it('resolves a genuine peer decline rather than throwing', async () => {
    const native = fakeNative({
      sendFrame: jest.fn().mockResolvedValue(toAckBase64({ ok: false, error: 'declined' })),
    })
    getLocalPayTransport.mockReturnValue(native)

    await expect(awdlTransport.send(session, frame, new AbortController().signal))
      .resolves.toEqual({ ok: false, error: 'declined' })
  })
})

describe('awdlTransport.receive', () => {
  afterEach(() => jest.clearAllMocks())

  it('rejects immediately on an already-aborted signal without calling startListening', async () => {
    const native = fakeNative()
    getLocalPayTransport.mockReturnValue(native)
    const controller = new AbortController()
    controller.abort()

    await expect(awdlTransport.receive(session, controller.signal)).rejects.toThrow('cancelled')
    expect(native.startListening).not.toHaveBeenCalled()
  })
})
