export const FRAME_VERSION = 1

export class CodecError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodecError'
  }
}

export interface PaymentFrame {
  version: number
  /** 66-char hex, compressed pubkey */
  senderIdentityKey: string
  amount: number
  outputIndex: number
  derivationPrefix: string
  derivationSuffix: string
  /**
   * AtomicBEEF, on both transports. The design originally specified a bare
   * rawtx on the QR path to shrink the symbol, but ancestry is what lets the
   * payee internalize offline — and MAX_FRAME_QR_CHARS already rejects frames
   * too large to render, so one encoding serves both.
   */
  transaction: Uint8Array
}

// ── varint (LEB128, unsigned) ──

function putVarint(out: number[], n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new CodecError(`varint out of range: ${n}`)
  let v = n
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80)
    v = Math.floor(v / 128)
  }
  out.push(v)
}

function getVarint(b: Uint8Array, pos: { i: number }): number {
  let result = 0
  let shift = 1
  for (;;) {
    if (pos.i >= b.length) throw new CodecError('truncated varint')
    const byte = b[pos.i++]
    result += (byte & 0x7f) * shift
    if ((byte & 0x80) === 0) break
    shift *= 128
    if (shift > 2 ** 53) throw new CodecError('varint too large')
  }
  return result
}

function putBytes(out: number[], bytes: Uint8Array): void {
  putVarint(out, bytes.length)
  for (const byte of bytes) out.push(byte)
}

function getBytes(b: Uint8Array, pos: { i: number }): Uint8Array {
  const len = getVarint(b, pos)
  if (pos.i + len > b.length) throw new CodecError('truncated byte field')
  const slice = b.slice(pos.i, pos.i + len)
  pos.i += len
  return slice
}

const enc = new TextEncoder()
const dec = new TextDecoder()

function putStr(out: number[], s: string): void {
  putBytes(out, enc.encode(s))
}

function getStr(b: Uint8Array, pos: { i: number }): string {
  return dec.decode(getBytes(b, pos))
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new CodecError('odd-length hex')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) throw new CodecError('invalid hex')
    out[i] = byte
  }
  return out
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
}

// ── frame ──

export function encodeFrame(f: PaymentFrame): Uint8Array {
  if (f.senderIdentityKey.length !== 66) {
    throw new CodecError(`senderIdentityKey must be 66 hex chars, got ${f.senderIdentityKey.length}`)
  }
  const out: number[] = [f.version & 0xff]
  for (const byte of hexToBytes(f.senderIdentityKey.toLowerCase())) out.push(byte)
  putVarint(out, f.amount)
  putVarint(out, f.outputIndex)
  putStr(out, f.derivationPrefix)
  putStr(out, f.derivationSuffix)
  putBytes(out, f.transaction)
  return new Uint8Array(out)
}

export function decodeFrame(b: Uint8Array): PaymentFrame {
  if (b.length < 34) throw new CodecError('frame too short')
  const version = b[0]
  if (version !== FRAME_VERSION) throw new CodecError(`unsupported frame version ${version}`)
  const pos = { i: 1 }
  const senderIdentityKey = bytesToHex(b.slice(pos.i, pos.i + 33))
  pos.i += 33
  const amount = getVarint(b, pos)
  const outputIndex = getVarint(b, pos)
  const derivationPrefix = getStr(b, pos)
  const derivationSuffix = getStr(b, pos)
  const transaction = getBytes(b, pos)
  if (pos.i !== b.length) throw new CodecError('trailing bytes after frame')
  return { version, senderIdentityKey, amount, outputIndex, derivationPrefix, derivationSuffix, transaction }
}

// ── QR handoff ──
//
// A QR carries text, not bytes, so a frame is base64url-wrapped behind a prefix
// that distinguishes it from a session QR (`bsvpay1:`).
//
// base64url is NOT QR "alphanumeric mode": `-`, `_` and the `:` in the prefix
// all fall outside that alphabet, so the encoder uses byte mode. What base64url
// buys is that every character is single-byte ASCII, so the byte-mode payload
// length equals the string length and never doubles under UTF-8.

export const FRAME_QR_PREFIX = 'bsvpayf1:'

/**
 * Largest frame QR this app will render, in characters.
 *
 * A version-40 symbol at error-correction level M holds 2,331 bytes, and every
 * character produced here is single-byte ASCII, so characters and bytes are the
 * same count. `react-native-qrcode-svg` rethrows out of render when the payload
 * does not fit, so exceeding this is not a degraded QR — it takes the app down
 * through the error boundary. Measured against that encoder: 2,276 characters
 * encodes, 2,343 throws.
 *
 * 2,200 sits below the last known-good measurement with ~130 characters of
 * headroom against the hard limit, so no rounding or encoder overhead can reach
 * the throw. It admits ~1,643 frame bytes, which covers the single-input
 * AtomicBEEF range, and rejects the multi-input frames that would be
 * unscannable at a phone-sized symbol anyway.
 *
 * `PaymentFrame.transaction` is AtomicBEEF — every input's source transaction
 * plus its BUMP — so frame size tracks input count, not output count. Callers
 * MUST check `frameToQr(...).length` against this before rendering.
 */
export const MAX_FRAME_QR_CHARS = 2200

function toB64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  let binary: string
  try {
    binary = globalThis.atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  } catch {
    // atob throws a platform error, not a CodecError. Normalise it so callers
    // see one failure type — they must still catch broadly, since a hostile QR
    // can reach code paths this wrapper does not cover.
    throw new CodecError('malformed base64url payload')
  }
  return Uint8Array.from(binary, c => c.charCodeAt(0))
}

/** Encodes a frame for display as a QR. May exceed MAX_FRAME_QR_CHARS — check before rendering. */
export function frameToQr(f: PaymentFrame): string {
  return FRAME_QR_PREFIX + toB64url(encodeFrame(f))
}

export function frameFromQr(text: unknown): PaymentFrame {
  if (typeof text !== 'string') throw new CodecError('expected a QR string')
  if (!text.startsWith(FRAME_QR_PREFIX)) throw new CodecError('not a nearby-payment QR')
  return decodeFrame(fromB64url(text.slice(FRAME_QR_PREFIX.length)))
}

/**
 * The raw frame bytes behind a bsvpayf1: payload, without decoding the frame.
 * The fountain path re-encodes exactly these bytes, and the re-show path needs
 * them from a persisted framePayload string.
 */
export function frameBytesFromQr(text: string): Uint8Array {
  if (!text.startsWith(FRAME_QR_PREFIX)) throw new CodecError('not a nearby-payment QR')
  return fromB64url(text.slice(FRAME_QR_PREFIX.length))
}
