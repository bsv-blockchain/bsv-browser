export const FRAME_VERSION = 2

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
  /**
   * Which output of `transaction` pays the payee.
   *
   * There is deliberately no `amount` beside it. `internalizeAction` credits
   * the output, so a satoshi count on the frame could only ever agree with the
   * transaction or lie about it — and `verifyFramePayment` has to parse the
   * transaction anyway, to prove the output is one the payee can spend. That
   * proof is what makes the figure it reads back worth showing as a receipt.
   */
  outputIndex: number
  derivationPrefix: string
  derivationSuffix: string
  /**
   * AtomicBEEF, on both transports. The design originally specified a bare
   * rawtx on the QR path to shrink the symbol, but ancestry is what lets the
   * payee internalize offline, and the fountain removed the symbol ceiling —
   * so one encoding serves both.
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
  const outputIndex = getVarint(b, pos)
  const derivationPrefix = getStr(b, pos)
  const derivationSuffix = getStr(b, pos)
  const transaction = getBytes(b, pos)
  if (pos.i !== b.length) throw new CodecError('trailing bytes after frame')
  return { version, senderIdentityKey, outputIndex, derivationPrefix, derivationSuffix, transaction }
}

// ── Frame envelope ──
//
// `bsvpayf1:` is NOT a QR wire format. Every payment code this app renders is a
// stream of `@bsv/air-gap` parts sized to FRAME_BLOCK_BYTES, and the scanner
// accepts nothing else — a second accepted shape is exactly what lets two
// implementations drift apart.
//
// What the envelope is for is storage: the payer persists one in
// `offline_actions.framePayload` so a delivered-but-unbroadcast payment can be
// re-shown later, and the renderer reads the bytes back out of it. base64url so
// the stored value is plain single-byte ASCII, behind a prefix that
// distinguishes it from a session QR (`bsvpay1:`).

export const FRAME_QR_PREFIX = 'bsvpayf1:'

/**
 * Source-block size for the animated payment code, in bytes.
 *
 * There is no single-symbol path to fall back to, so this one number decides
 * symbol density for every payment. `estimatePartCharLength(1024)` is 1,404
 * characters, and a part is single-byte ASCII throughout, so it occupies 1,404
 * bytes of a byte-mode QR: inside the 2,331-byte capacity of a version-40
 * symbol at error-correction level M, with ~40% headroom for a scanner that is
 * not looking at the screen straight on. `react-native-qrcode-svg` rethrows out
 * of render past capacity and takes the app down through the error boundary, so
 * that headroom is not cosmetic.
 *
 * A frame this size or smaller is a single source block — one part carries the
 * whole message — so the renderer holds `seq` at 0 and runs no timer, and an
 * ordinary payment is a still QR. (Part strings are NOT equal across `seq`:
 * `seq` sits in the part header. What makes it still is holding it, not the
 * block count on its own.)
 *
 * `PaymentFrame.transaction` is AtomicBEEF — every input's source transaction
 * plus its BUMP — so frame size tracks input count, not output count. The only
 * remaining ceiling is air-gap's own MAX_MESSAGE_BYTES, which the send path
 * checks before it builds an encoder.
 */
export const FRAME_BLOCK_BYTES = 1024

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

/** Wraps a frame for storage and later re-display. Rendered as air-gap parts, never as one symbol. */
export function frameToQr(f: PaymentFrame): string {
  return FRAME_QR_PREFIX + toB64url(encodeFrame(f))
}

/**
 * The raw frame bytes behind a bsvpayf1: envelope.
 *
 * The encoder re-encodes exactly these bytes, and the re-show path reads them
 * from a persisted framePayload — a column, so a row can be truncated, foreign
 * or null. Every failure is a CodecError, including a non-string, because the
 * screens that call this catch one type and must not be crashed by a bad row.
 *
 * Deliberately does not decode the frame: nothing reads a stored envelope back
 * as a `PaymentFrame`, and a decoder for it would be a second accepted format.
 */
export function frameBytesFromQr(text: string): Uint8Array {
  if (typeof text !== 'string') throw new CodecError('expected a frame envelope string')
  if (!text.startsWith(FRAME_QR_PREFIX)) throw new CodecError('not a nearby-payment frame envelope')
  return fromB64url(text.slice(FRAME_QR_PREFIX.length))
}
