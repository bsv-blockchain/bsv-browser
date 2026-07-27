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
  amount: number
  derivationPrefix: string
  derivationSuffix: string
}

export function mintSession(args: {
  identityKey: string
  amount: number
  derivationPrefix: string
  derivationSuffix: string
  supportsAwdl: boolean
}): Session {
  if (args.identityKey.length !== 66) throw new CodecError('identityKey must be 66 hex chars')
  return {
    version: SESSION_VERSION,
    caps: args.supportsAwdl ? CAP_AWDL : 0,
    sessionId: new Uint8Array(Random(16)),
    psk: new Uint8Array(Random(32)),
    identityKey: args.identityKey,
    amount: args.amount,
    derivationPrefix: args.derivationPrefix,
    derivationSuffix: args.derivationSuffix,
  }
}

// Base64url, no padding — QR alphanumeric-safe and dependency-free.
function toB64url(b: Uint8Array): string {
  let s = ''
  for (const byte of b) s += String.fromCharCode(byte)
  return globalThis.btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = globalThis.atob(pad + '='.repeat((4 - (pad.length % 4)) % 4))
  return Uint8Array.from(bin, c => c.charCodeAt(0))
}

export function encodeSession(s: Session): string {
  const body = JSON.stringify({
    v: s.version,
    c: s.caps,
    s: toB64url(s.sessionId),
    k: toB64url(s.psk),
    i: s.identityKey,
    a: s.amount,
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
  } catch {
    throw new CodecError('malformed session payload')
  }
  const { v, c, s, k, i, a, p, x } = parsed as Record<string, never>
  if (v !== SESSION_VERSION) throw new CodecError(`unsupported session version ${String(v)}`)
  if (typeof i !== 'string' || (i as string).length !== 66) throw new CodecError('bad identityKey')
  if (typeof a !== 'number') throw new CodecError('bad amount')
  const sessionId = fromB64url(s as string)
  const psk = fromB64url(k as string)
  if (sessionId.length !== 16) throw new CodecError('bad sessionId length')
  if (psk.length !== 32) throw new CodecError('bad psk length')
  return {
    version: v as number,
    caps: (c as number) ?? 0,
    sessionId,
    psk,
    identityKey: i as string,
    amount: a as number,
    derivationPrefix: p as string,
    derivationSuffix: x as string,
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
