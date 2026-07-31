import { estimatePartCharLength } from '@bsv/air-gap'
import {
  encodeFrame,
  decodeFrame,
  frameToQr,
  sealedToQr,
  frameBytesFromQr,
  sealFrame,
  unsealFrame,
  CodecError,
  FRAME_BLOCK_BYTES,
  FRAME_VERSION,
  FRAME_QR_PREFIX,
  SEAL_VERSION,
  type PaymentFrame
} from '@/utils/localpay/codec'
import type { TokenPayment } from '@/utils/localpay/codec'

const sample = (): PaymentFrame => ({
  version: FRAME_VERSION,
  kind: 'bsv' as const,
  senderIdentityKey: '02'.padEnd(66, 'a'),
  outputIndex: 0,
  derivationPrefix: 'cHJlZml4',
  derivationSuffix: 'c3VmZml4',
  transaction: new Uint8Array([1, 2, 3, 4, 5])
})

const psk = new Uint8Array(32).fill(7)

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

  it('is version 3', () => {
    expect(FRAME_VERSION).toBe(3)
    expect(encodeFrame(sample())[0]).toBe(3)
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
    expect(unsealFrame(frameBytesFromQr(frameToQr(f, psk)), psk)).toEqual(f)
  })

  it('round-trips a realistic single-input AtomicBEEF frame', () => {
    // 1,200 bytes of pseudo-random payload: base64 of incompressible bytes is
    // the worst case for length, and this is the size band payments sit in.
    const transaction = new Uint8Array(1200)
    for (let i = 0; i < transaction.length; i++) transaction[i] = (i * 37 + 11) & 0xff
    const f = { ...sample(), transaction }
    expect(unsealFrame(frameBytesFromQr(frameToQr(f, psk)), psk)).toEqual(f)
  })

  // `sealedToQr` exists so a caller that must seal once to size-check the
  // bytes (the QR-size sanity check) can wrap those same bytes instead of
  // calling `sealFrame` a second time. It must produce the same envelope
  // shape as `frameToQr` — prefix plus base64url of the sealed bytes — and
  // round-trip through `frameBytesFromQr`/`unsealFrame` back to the frame.
  it('sealedToQr wraps already-sealed bytes into the same envelope shape as frameToQr', () => {
    const f = sample()
    const sealed = sealFrame(f, psk)
    const qr = sealedToQr(sealed)
    expect(qr.startsWith(FRAME_QR_PREFIX)).toBe(true)
    expect(frameBytesFromQr(qr)).toEqual(sealed)
    expect(unsealFrame(frameBytesFromQr(qr), psk)).toEqual(f)
  })

  it('prefixes the payload so it cannot be confused with a session QR', () => {
    expect(frameToQr(sample(), psk).startsWith(FRAME_QR_PREFIX)).toBe(true)
    expect(FRAME_QR_PREFIX.startsWith('bsvpay1:')).toBe(false)
  })

  it('emits only single-byte ASCII, so characters and QR bytes agree', () => {
    const qr = frameToQr({ ...sample(), transaction: new Uint8Array(900).fill(0xff) }, psk)
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
    const qr = frameToQr(sample(), psk)
    expect(() => unsealFrame(frameBytesFromQr(qr.slice(0, qr.length - 8)), psk)).toThrow(CodecError)
  })

  it('rejects an empty payload behind a valid prefix', () => {
    expect(() => unsealFrame(frameBytesFromQr(FRAME_QR_PREFIX), psk)).toThrow(CodecError)
  })

  it('rejects non-string input, which a corrupt storage row can be', () => {
    expect(() => frameBytesFromQr(null as never)).toThrow(CodecError)
    expect(() => frameBytesFromQr(undefined as never)).toThrow(CodecError)
    expect(() => frameBytesFromQr({ toString: () => `${FRAME_QR_PREFIX}AAAA` } as never)).toThrow(CodecError)
  })

  it('never throws a non-CodecError for any single-character corruption', () => {
    const qr = frameToQr(sample(), psk)
    for (let i = FRAME_QR_PREFIX.length; i < qr.length; i += 7) {
      const corrupted = qr.slice(0, i) + (qr[i] === 'A' ? 'B' : 'A') + qr.slice(i + 1)
      try {
        unsealFrame(frameBytesFromQr(corrupted), psk)
      } catch (e) {
        expect(e).toBeInstanceOf(CodecError)
      }
    }
  })

  it('frameBytesFromQr returns the exact sealed bytes: SEAL_VERSION prefix, unseals to the frame', () => {
    const f = sample()
    const qr = frameToQr(f, psk)
    const bytes = frameBytesFromQr(qr)
    expect(bytes[0]).toBe(SEAL_VERSION)
    expect(bytes.length).toBe(1 + 32 + encodeFrame(f).length + 16)
    expect(unsealFrame(bytes, psk)).toEqual(f)
    expect(() => frameBytesFromQr('bsvpay1:xx')).toThrow()
  })
})

describe('sealed envelope', () => {
  const psk = new Uint8Array(32).fill(7)

  it('round-trips a frame under the session PSK', () => {
    const f = sample()
    expect(unsealFrame(sealFrame(f, psk), psk)).toEqual(f)
  })

  it('starts with SEAL_VERSION and is ciphertext, not a readable frame', () => {
    const sealed = sealFrame(sample(), psk)
    expect(sealed[0]).toBe(SEAL_VERSION)
    // 1 version byte + 32B IV + ciphertext + 16B tag
    expect(sealed.length).toBe(1 + 32 + encodeFrame(sample()).length + 16)
    expect(() => decodeFrame(sealed)).toThrow(CodecError) // reads version 1 → unsupported
  })

  it('refuses the wrong PSK as a CodecError, not a platform error', () => {
    const other = new Uint8Array(32).fill(8)
    expect(() => unsealFrame(sealFrame(sample(), psk), other)).toThrow(CodecError)
  })

  it('refuses a tampered body', () => {
    const sealed = sealFrame(sample(), psk)
    sealed[40] ^= 0xff
    expect(() => unsealFrame(sealed, psk)).toThrow(CodecError)
  })

  it('refuses an unknown seal version', () => {
    const sealed = sealFrame(sample(), psk)
    sealed[0] = 2
    expect(() => unsealFrame(sealed, psk)).toThrow(/unsupported seal version 2/)
  })

  it('refuses a PSK that is not 32 bytes', () => {
    expect(() => sealFrame(sample(), new Uint8Array(16))).toThrow(CodecError)
    expect(() => unsealFrame(sealFrame(sample(), psk), new Uint8Array(16))).toThrow(CodecError)
  })
})

const tokenSample = (): PaymentFrame => ({
  ...sample(),
  kind: 'token',
  token: {
    assetId: 'ab'.repeat(32) + '.0',
    overlayUrl: 'https://overlay.issuer.example',
    overlayIdentityKey: '03'.padEnd(66, 'b'),
    certificates: [new Uint8Array([9, 9, 9]), new Uint8Array([])],
    linkage: [
      { txid: 'cd'.repeat(32), payload: new Uint8Array([1, 2, 3]) },
      { txid: 'ef'.repeat(32), payload: new Uint8Array([4]) },
    ],
    recipientLinkage: new Uint8Array([5, 6]),
  } satisfies TokenPayment,
})

describe('frame v3 kinds', () => {
  it('round-trips a bsv frame with kind preserved', () => {
    const decoded = decodeFrame(encodeFrame(sample()))
    expect(decoded.kind).toBe('bsv')
    expect(decoded.token).toBeUndefined()
    expect(decoded).toEqual(sample())
  })

  it('round-trips a token frame with every token field intact', () => {
    expect(decodeFrame(encodeFrame(tokenSample()))).toEqual(tokenSample())
  })

  it('seals and unseals a token frame', () => {
    const psk = new Uint8Array(32).fill(7)
    expect(unsealFrame(sealFrame(tokenSample(), psk), psk)).toEqual(tokenSample())
  })

  it('rejects a v2 frame: fail-closed versioning', () => {
    const bytes = encodeFrame(sample())
    bytes[0] = 2
    expect(() => decodeFrame(bytes)).toThrow(/unsupported frame version 2/)
  })

  it('rejects an unknown kind byte', () => {
    const bytes = encodeFrame(sample())
    bytes[1] = 0x03
    expect(() => decodeFrame(bytes)).toThrow(/unsupported frame kind 3/)
  })

  it('refuses to encode kind token without a token block, and kind bsv with one', () => {
    expect(() => encodeFrame({ ...sample(), kind: 'token' })).toThrow(CodecError)
    expect(() => encodeFrame({ ...sample(), token: tokenSample().token })).toThrow(CodecError)
  })

  it('refuses malformed token fields at encode', () => {
    const bad = (patch: Partial<TokenPayment>) =>
      encodeFrame({ ...tokenSample(), token: { ...tokenSample().token!, ...patch } })
    expect(() => bad({ overlayIdentityKey: '03short' })).toThrow(CodecError)
    expect(() => bad({ linkage: [{ txid: 'zz', payload: new Uint8Array([1]) }] })).toThrow(CodecError)
  })

  it('still rejects trailing bytes after a token frame', () => {
    const bytes = encodeFrame(tokenSample())
    const padded = new Uint8Array([...bytes, 0])
    expect(() => decodeFrame(padded)).toThrow(/trailing bytes/)
  })
})
