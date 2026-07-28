import { Random } from '@bsv/sdk'
import { CodecError } from './codec'

export const SESSION_VERSION = 1
export const CAP_AWDL = 0x01

export interface Session {
  version: number
  caps: number
  sessionId: Uint8Array
  psk: Uint8Array
  identityKey: string
  /**
   * The satoshis the payee is asking for, or undefined for an OPEN request
   * where the payer chooses.
   *
   * Optional is a money-safety-relevant distinction, not a cosmetic one. When
   * present it is a binding term of the request: the payee's settle path
   * refuses any frame carrying a different figure, which is what stops a payer
   * sending 1 satoshi against a 100,000 request while the payee's screen reads
   * "Received 100,000". When absent there is no figure to bind, so that check
   * cannot run and MUST NOT be faked — the derivation nonces are what prove the
   * frame belongs to this request, and they apply either way.
   */
  amount?: number
  derivationPrefix: string
  derivationSuffix: string
}

export function mintSession(args: {
  identityKey: string
  /** Omit for an open request — the payer enters the amount. */
  amount?: number
  derivationPrefix: string
  derivationSuffix: string
  supportsAwdl: boolean
}): Session {
  if (args.identityKey.length !== 66) throw new CodecError('identityKey must be 66 hex chars')
  // Validated at the mint too, not only at decode: an invalid figure minted
  // here would render on the payee's own screen and be echoed to the payer as
  // an authentic request before any decoder ever saw it.
  if (args.amount !== undefined && !isRequestableAmount(args.amount)) {
    throw new CodecError('bad amount')
  }
  return {
    version: SESSION_VERSION,
    caps: args.supportsAwdl ? CAP_AWDL : 0,
    sessionId: new Uint8Array(Random(16)),
    psk: new Uint8Array(Random(32)),
    identityKey: args.identityKey,
    ...(args.amount === undefined ? {} : { amount: args.amount }),
    derivationPrefix: args.derivationPrefix,
    derivationSuffix: args.derivationSuffix,
  }
}

/**
 * Satoshis: a whole, positive, exactly-representable count.
 *
 * A bare typeof check admits 0, negatives, NaN and fractions — and a fractional
 * amount renders as a blank figure directly above a live Send button.
 */
export function isRequestableAmount(a: unknown): a is number {
  return typeof a === 'number' && Number.isSafeInteger(a) && a > 0
}

// Base64url, no padding — QR alphanumeric-safe and dependency-free.
function toB64url(b: Uint8Array): string {
  let s = ''
  for (const byte of b) s += String.fromCharCode(byte)
  return globalThis.btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(s: unknown): Uint8Array {
  if (typeof s !== 'string') throw new CodecError('expected base64url string')
  const pad = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = globalThis.atob(pad + '='.repeat((4 - (pad.length % 4)) % 4))
  return Uint8Array.from(bin, c => c.charCodeAt(0))
}

export function encodeSession(s: Session): string {
  // `a` is omitted entirely for an open request rather than written as null.
  // JSON.stringify already drops an undefined value, so this is explicit only
  // to make the wire shape obvious: absent key === payer chooses.
  const body = JSON.stringify({
    v: s.version,
    c: s.caps,
    s: toB64url(s.sessionId),
    k: toB64url(s.psk),
    i: s.identityKey,
    ...(s.amount === undefined ? {} : { a: s.amount }),
    p: s.derivationPrefix,
    x: s.derivationSuffix,
  })
  return 'bsvpay1:' + toB64url(new TextEncoder().encode(body))
}

export function decodeSession(text: string): Session {
  if (!text.startsWith('bsvpay1:')) throw new CodecError('not a bsvpay session QR')
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromB64url(text.slice('bsvpay1:'.length))))
  } catch (e) {
    if (e instanceof CodecError) throw e
    throw new CodecError('malformed session payload')
  }
  const { v, c, s, k, i, a, p, x } = parsed as Record<string, unknown>
  if (v !== SESSION_VERSION) throw new CodecError(`unsupported session version ${String(v)}`)
  if (typeof i !== 'string' || i.length !== 66) throw new CodecError('bad identityKey')
  // An ABSENT `a` is an OPEN request: the payer chooses.
  //
  // Absent means absent. An explicit `null` is refused, not read as open:
  // encodeSession omits the key entirely for an open request, so no peer this
  // codec talks to ever emits null, and accepting it would widen the "payer
  // picks the number" path to a shape nothing legitimately produces. Every
  // other value is a figure the payee is asserting, and a bad one must be
  // refused rather than quietly reinterpreted as "any amount" — that would turn
  // a corrupt 0 into an open request with a live Send button under it.
  const open = a === undefined
  if (!open && !isRequestableAmount(a)) throw new CodecError('bad amount')
  if (typeof s !== 'string') throw new CodecError('bad sessionId encoding')
  if (typeof k !== 'string') throw new CodecError('bad psk encoding')
  if (typeof p !== 'string') throw new CodecError('bad derivationPrefix encoding')
  if (typeof x !== 'string') throw new CodecError('bad derivationSuffix encoding')
  if (c !== undefined && c !== null && typeof c !== 'number') throw new CodecError('bad caps')
  const sessionId = fromB64url(s)
  const psk = fromB64url(k)
  if (sessionId.length !== 16) throw new CodecError('bad sessionId length')
  if (psk.length !== 32) throw new CodecError('bad psk length')
  return {
    version: v as number,
    caps: (typeof c === 'number' ? c : 0),
    sessionId,
    psk,
    identityKey: i,
    ...(open ? {} : { amount: a }),
    derivationPrefix: p,
    derivationSuffix: x,
  }
}

// RFC 4648 base32, lowercase, no padding. 16 bytes → 26 chars.
const B32 = 'abcdefghijklmnopqrstuvwxyz234567'

export function instanceName(sessionId: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of sessionId) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return `bsvpay-${out}`
}
