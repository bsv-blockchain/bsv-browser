import { awdlTransport } from '@/utils/localpay/transport/awdl'
import { AckError } from '@/utils/localpay/transport/types'
import { mintSession, instanceName } from '@/utils/localpay/session'
import { CodecError, encodeFrame, type PaymentFrame } from '@/utils/localpay/codec'
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

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const byte of bytes) s += String.fromCharCode(byte)
  return globalThis.btoa(s)
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

  it('resolves the decoded frame and stops the listener exactly once', async () => {
    const startListening = jest.fn((_name: string, _psk: string, onFrame: (f: string) => void) => {
      onFrame(toBase64(encodeFrame(frame)))
      return Promise.resolve()
    })
    const native = fakeNative({ startListening: startListening as never })
    getLocalPayTransport.mockReturnValue(native)

    await expect(awdlTransport.receive(session, new AbortController().signal)).resolves.toEqual(frame)
    expect(startListening).toHaveBeenCalledTimes(1)
    expect(startListening.mock.calls[0][0]).toBe(instanceName(session.sessionId))
    expect(native.stopListening).toHaveBeenCalledTimes(1)
  })

  // Regression: `finish` latches and tears the listener down BEFORE invoking its
  // callback, so decoding inside that callback made a decode failure unrecoverable —
  // the second finish() returned early at the latch and the promise never settled.
  // The payee spun on "waiting" forever against a cancelled listener while the
  // payer saw a green "Sent". Any frame-version skew or truncation reaches this.
  it('rejects rather than hanging when the delivered frame cannot be decoded', async () => {
    const startListening = jest.fn((_name: string, _psk: string, onFrame: (f: string) => void) => {
      onFrame(toBase64(new Uint8Array([0xff, 0xff, 0xff])))
      return Promise.resolve()
    })
    const native = fakeNative({ startListening: startListening as never })
    getLocalPayTransport.mockReturnValue(native)

    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      awdlTransport
        .receive(session, new AbortController().signal)
        .then(() => 'resolved' as const, () => 'rejected' as const),
      new Promise<'hung'>(resolve => {
        timer = setTimeout(() => resolve('hung'), 500)
      })
    ])
    clearTimeout(timer)

    expect(outcome).toBe('rejected')
    expect(native.stopListening).toHaveBeenCalledTimes(1)
  })

  it('rejects with the CodecError raised by the decoder', async () => {
    const startListening = jest.fn((_name: string, _psk: string, onFrame: (f: string) => void) => {
      onFrame(toBase64(new Uint8Array([0xff, 0xff, 0xff])))
      return Promise.resolve()
    })
    getLocalPayTransport.mockReturnValue(fakeNative({ startListening: startListening as never }))

    await expect(awdlTransport.receive(session, new AbortController().signal)).rejects.toThrow(CodecError)
  })
})
