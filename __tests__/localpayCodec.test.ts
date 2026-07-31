import { estimatePartCharLength } from '@bsv/air-gap'
import {
  encodeFrame,
  decodeFrame,
  frameToQr,
  frameBytesFromQr,
  CodecError,
  FRAME_BLOCK_BYTES,
  FRAME_VERSION,
  FRAME_QR_PREFIX,
  type PaymentFrame
} from '@/utils/localpay/codec'

const sample = (): PaymentFrame => ({
  version: FRAME_VERSION,
  senderIdentityKey: '02'.padEnd(66, 'a'),
  outputIndex: 0,
  derivationPrefix: 'cHJlZml4',
  derivationSuffix: 'c3VmZml4',
  transaction: new Uint8Array([1, 2, 3, 4, 5])
})

describe('localpay codec', () => {
  it('round-trips a frame', () => {
    const f = sample()
    expect(decodeFrame(encodeFrame(f))).toEqual(f)
  })

  it('round-trips a large transaction', () => {
    const f = { ...sample(), transaction: new Uint8Array(50_000).fill(7) }
    const decoded = decodeFrame(encodeFrame(f))
    expect(decoded.transaction.length).toBe(50_000)
    expect(decoded.transaction[0]).toBe(7)
    expect(decoded.transaction[49_999]).toBe(7)
    expect(Array.from(decoded.transaction).every(b => b === 7)).toBe(true)
  })

  it('carries no amount field: the transaction is the only source of the figure', () => {
    const decoded = decodeFrame(encodeFrame(sample())) as unknown as Record<string, unknown>
    expect('amount' in decoded).toBe(false)
  })

  it('rejects a v1 frame, whose layout put an amount after the identity key', () => {
    const v1 = encodeFrame(sample())
    v1[0] = 1
    expect(() => decodeFrame(v1)).toThrow('unsupported frame version 1')
  })

  it('is version 2', () => {
    expect(FRAME_VERSION).toBe(2)
    expect(encodeFrame(sample())[0]).toBe(2)
  })

  it('rejects truncated input', () => {
    const b = encodeFrame(sample())
    expect(() => decodeFrame(b.slice(0, b.length - 3))).toThrow(CodecError)
  })

  it('rejects an unknown version', () => {
    const b = encodeFrame(sample())
    b[0] = 99
    expect(() => decodeFrame(b)).toThrow(CodecError)
  })

  it('rejects trailing garbage', () => {
    const b = encodeFrame(sample())
    expect(() => decodeFrame(new Uint8Array([...b, 0, 0]))).toThrow(CodecError)
  })

  it('rejects a wrong-length identity key', () => {
    expect(() => encodeFrame({ ...sample(), senderIdentityKey: 'abcd' })).toThrow(CodecError)
  })

  it('normalizes uppercase identity key to lowercase', () => {
    const f = { ...sample(), senderIdentityKey: '02'.padEnd(66, 'A') }
    const decoded = decodeFrame(encodeFrame(f))
    expect(decoded.senderIdentityKey).toBe('02'.padEnd(66, 'a'))
  })
})

describe('localpay frame envelope', () => {
  // `bsvpayf1:` is no longer a QR wire format — every payment code is an
  // air-gap fountain (see localpayAirGap.test.ts). It survives as the envelope
  // stored in offline_actions.framePayload and re-read to re-show a code, so
  // what these pin is that a stored string decodes back to the exact bytes,
  // and that a corrupt or foreign one fails as a CodecError rather than
  // crashing the screen that renders it.

  it('round-trips a frame through the stored envelope', () => {
    const f = sample()
    expect(decodeFrame(frameBytesFromQr(frameToQr(f)))).toEqual(f)
  })

  it('round-trips a realistic single-input AtomicBEEF frame', () => {
    // 1,200 bytes of pseudo-random payload: base64 of incompressible bytes is
    // the worst case for length, and this is the size band payments sit in.
    const transaction = new Uint8Array(1200)
    for (let i = 0; i < transaction.length; i++) transaction[i] = (i * 37 + 11) & 0xff
    const f = { ...sample(), transaction }
    expect(decodeFrame(frameBytesFromQr(frameToQr(f)))).toEqual(f)
  })

  it('prefixes the payload so it cannot be confused with a session QR', () => {
    expect(frameToQr(sample()).startsWith(FRAME_QR_PREFIX)).toBe(true)
    expect(FRAME_QR_PREFIX.startsWith('bsvpay1:')).toBe(false)
  })

  it('emits only single-byte ASCII, so characters and QR bytes agree', () => {
    const qr = frameToQr({ ...sample(), transaction: new Uint8Array(900).fill(0xff) })
    expect(/^[\x21-\x7e]+$/.test(qr)).toBe(true)
    expect(new TextEncoder().encode(qr).length).toBe(qr.length)
  })

  it('sizes source blocks below the version-40 / EC-M capacity', () => {
    // 2,331 bytes is the hard ceiling for the symbol the renderer asks for.
    expect(estimatePartCharLength(FRAME_BLOCK_BYTES)).toBeLessThan(2331)
  })

  it('rejects a session QR', () => {
    expect(() => frameBytesFromQr('bsvpay1:AAAA')).toThrow(CodecError)
  })

  it('rejects an unprefixed payload', () => {
    expect(() => frameBytesFromQr('https://example.com')).toThrow(CodecError)
  })

  it('rejects malformed base64url behind a valid prefix', () => {
    expect(() => frameBytesFromQr(`${FRAME_QR_PREFIX}!!!!not base64!!!!`)).toThrow(CodecError)
  })

  it('rejects a truncated payload behind a valid prefix', () => {
    const qr = frameToQr(sample())
    expect(() => decodeFrame(frameBytesFromQr(qr.slice(0, qr.length - 8)))).toThrow(CodecError)
  })

  it('rejects an empty payload behind a valid prefix', () => {
    expect(() => decodeFrame(frameBytesFromQr(FRAME_QR_PREFIX))).toThrow(CodecError)
  })

  it('rejects non-string input, which a corrupt storage row can be', () => {
    expect(() => frameBytesFromQr(null as never)).toThrow(CodecError)
    expect(() => frameBytesFromQr(undefined as never)).toThrow(CodecError)
    expect(() => frameBytesFromQr({ toString: () => `${FRAME_QR_PREFIX}AAAA` } as never)).toThrow(CodecError)
  })

  it('never throws a non-CodecError for any single-character corruption', () => {
    const qr = frameToQr(sample())
    for (let i = FRAME_QR_PREFIX.length; i < qr.length; i += 7) {
      const corrupted = qr.slice(0, i) + (qr[i] === 'A' ? 'B' : 'A') + qr.slice(i + 1)
      try {
        decodeFrame(frameBytesFromQr(corrupted))
      } catch (e) {
        expect(e).toBeInstanceOf(CodecError)
      }
    }
  })

  it('frameBytesFromQr returns the exact encodeFrame bytes', () => {
    const f = sample()
    const qr = frameToQr(f)
    expect(Array.from(frameBytesFromQr(qr))).toEqual(Array.from(encodeFrame(f)))
    expect(() => frameBytesFromQr('bsvpay1:xx')).toThrow()
  })
})
