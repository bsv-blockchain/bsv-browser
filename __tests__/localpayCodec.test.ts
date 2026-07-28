import {
  encodeFrame,
  decodeFrame,
  frameToQr,
  frameFromQr,
  CodecError,
  FRAME_VERSION,
  FRAME_QR_PREFIX,
  MAX_FRAME_QR_CHARS,
  type PaymentFrame
} from '@/utils/localpay/codec'

const sample = (): PaymentFrame => ({
  version: FRAME_VERSION,
  senderIdentityKey: '02'.padEnd(66, 'a'),
  amount: 1234,
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

  it('round-trips amounts above 32 bits', () => {
    const f = { ...sample(), amount: 2 ** 40 }
    expect(decodeFrame(encodeFrame(f)).amount).toBe(2 ** 40)
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

describe('localpay frame QR handoff', () => {
  it('round-trips a frame through a QR string', () => {
    const f = sample()
    expect(frameFromQr(frameToQr(f))).toEqual(f)
  })

  it('round-trips a realistic single-input AtomicBEEF frame', () => {
    // 1,200 bytes of pseudo-random payload: base64 of incompressible bytes is
    // the worst case for length, and this is the size band the QR path targets.
    const transaction = new Uint8Array(1200)
    for (let i = 0; i < transaction.length; i++) transaction[i] = (i * 37 + 11) & 0xff
    const f = { ...sample(), transaction }
    const qr = frameToQr(f)
    expect(qr.length).toBeLessThanOrEqual(MAX_FRAME_QR_CHARS)
    expect(frameFromQr(qr)).toEqual(f)
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

  it('stays clear of the version-40 / EC-M capacity', () => {
    // 2,331 bytes is the hard ceiling; the measured throw was at 2,343.
    expect(MAX_FRAME_QR_CHARS).toBeLessThan(2331)
  })

  it('reports a length a caller can gate on before rendering', () => {
    const oversize = frameToQr({ ...sample(), transaction: new Uint8Array(4000).fill(3) })
    expect(oversize.length).toBeGreaterThan(MAX_FRAME_QR_CHARS)
  })

  it('rejects a session QR', () => {
    expect(() => frameFromQr('bsvpay1:AAAA')).toThrow(CodecError)
  })

  it('rejects an unprefixed payload', () => {
    expect(() => frameFromQr('https://example.com')).toThrow(CodecError)
  })

  it('rejects malformed base64url behind a valid prefix', () => {
    expect(() => frameFromQr(`${FRAME_QR_PREFIX}!!!!not base64!!!!`)).toThrow(CodecError)
  })

  it('rejects a truncated payload behind a valid prefix', () => {
    const qr = frameToQr(sample())
    expect(() => frameFromQr(qr.slice(0, qr.length - 8))).toThrow(CodecError)
  })

  it('rejects an empty payload behind a valid prefix', () => {
    expect(() => frameFromQr(FRAME_QR_PREFIX)).toThrow(CodecError)
  })

  it('rejects non-string input', () => {
    expect(() => frameFromQr(null)).toThrow(CodecError)
    expect(() => frameFromQr(undefined)).toThrow(CodecError)
    expect(() => frameFromQr({ toString: () => `${FRAME_QR_PREFIX}AAAA` })).toThrow(CodecError)
  })

  it('never throws a non-CodecError for any single-character corruption', () => {
    const qr = frameToQr(sample())
    for (let i = FRAME_QR_PREFIX.length; i < qr.length; i += 7) {
      const corrupted = qr.slice(0, i) + (qr[i] === 'A' ? 'B' : 'A') + qr.slice(i + 1)
      try {
        frameFromQr(corrupted)
      } catch (e) {
        expect(e).toBeInstanceOf(CodecError)
      }
    }
  })
})
