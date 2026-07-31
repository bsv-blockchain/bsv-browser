import {
  mintSession, encodeSession, decodeSession, instanceName, CAP_AWDL, CAP_NEARBY, SESSION_VERSION, CAP_BLE, type SessionAsset,
} from '@/utils/localpay/session'
import { CodecError } from '@/utils/localpay/codec'

const args = {
  identityKey: '02'.padEnd(66, 'b'),
  amount: 5000,
  derivationPrefix: 'cHJlZml4',
  derivationSuffix: 'c3VmZml4',
  supportsAwdl: true,
}

// Helper to encode a custom JSON envelope as a QR string
function encodeCustomQR(payload: Record<string, unknown>): string {
  const body = JSON.stringify(payload)
  let s = ''
  const encoded = new TextEncoder().encode(body)
  for (const byte of encoded) s += String.fromCharCode(byte)
  const b64url = globalThis.btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return 'bsvpay1:' + b64url
}

// Reverse of encodeCustomQR: unwrap a QR string back to its JSON envelope so a
// test can tamper with one field and re-encode.
function decodeQR(qr: string): Record<string, unknown> {
  const b64 = qr.slice('bsvpay1:'.length).replace(/-/g, '+').replace(/_/g, '/')
  const bin = globalThis.atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return JSON.parse(bin)
}

describe('localpay session', () => {
  it('mints 16-byte sessionId and 32-byte psk', () => {
    const s = mintSession(args)
    expect(s.sessionId.length).toBe(16)
    expect(s.psk.length).toBe(32)
    expect(s.version).toBe(SESSION_VERSION)
  })

  it('sets the AWDL capability bit', () => {
    expect(mintSession(args).caps & CAP_AWDL).toBe(CAP_AWDL)
    expect(mintSession({ ...args, supportsAwdl: false }).caps & CAP_AWDL).toBe(0)
  })

  it('mints distinct sessions', () => {
    const a = mintSession(args)
    const b = mintSession(args)
    expect(Buffer.from(a.sessionId)).not.toEqual(Buffer.from(b.sessionId))
    expect(Buffer.from(a.psk)).not.toEqual(Buffer.from(b.psk))
  })

  it('round-trips through the QR encoding', () => {
    const s = mintSession(args)
    expect(decodeSession(encodeSession(s))).toEqual(s)
  })

  it('stays small enough for one static QR', () => {
    expect(encodeSession(mintSession(args)).length).toBeLessThan(300)
  })

  it('rejects malformed QR text', () => {
    expect(() => decodeSession('not-a-session')).toThrow(CodecError)
  })

  it('derives a DNS-SD-safe instance name', () => {
    const n = instanceName(mintSession(args).sessionId)
    expect(n).toMatch(/^bsvpay-[a-z2-7]{26}$/)
    expect(n.length).toBeLessThanOrEqual(63)
  })

  it('derives the same instance name on both sides', () => {
    const s = mintSession(args)
    expect(instanceName(decodeSession(encodeSession(s)).sessionId)).toBe(instanceName(s.sessionId))
  })

  it('rejects missing sessionId encoding (s)', () => {
    const qr = encodeCustomQR({
      v: SESSION_VERSION,
      c: 0,
      k: 'AAAA',
      i: args.identityKey,
      a: 5000,
      p: 'cHJlZml4',
      x: 'c3VmZml4',
    })
    expect(() => decodeSession(qr)).toThrow(CodecError)
  })

  it('rejects missing psk encoding (k)', () => {
    const qr = encodeCustomQR({
      v: SESSION_VERSION,
      c: 0,
      s: 'AAAA',
      i: args.identityKey,
      a: 5000,
      p: 'cHJlZml4',
      x: 'c3VmZml4',
    })
    expect(() => decodeSession(qr)).toThrow(CodecError)
  })

  it('rejects missing derivationPrefix encoding (p)', () => {
    const qr = encodeCustomQR({
      v: SESSION_VERSION,
      c: 0,
      s: 'AAAA',
      k: 'AAAA',
      i: args.identityKey,
      a: 5000,
      x: 'c3VmZml4',
    })
    expect(() => decodeSession(qr)).toThrow(CodecError)
  })

  it('rejects missing derivationSuffix encoding (x)', () => {
    const qr = encodeCustomQR({
      v: SESSION_VERSION,
      c: 0,
      s: 'AAAA',
      k: 'AAAA',
      i: args.identityKey,
      a: 5000,
      p: 'cHJlZml4',
    })
    expect(() => decodeSession(qr)).toThrow(CodecError)
  })

  // The amount drives both the payer's confirm screen and the payee's
  // session-binding check, so anything that is not a whole positive satoshi
  // count must be refused at the door rather than rendered.
  const amountQr = (a: unknown) => encodeCustomQR({
    v: SESSION_VERSION,
    c: 0,
    s: 'A'.repeat(22), // 16 bytes
    k: 'A'.repeat(43), // 32 bytes
    i: args.identityKey,
    a,
    p: 'cHJlZml4',
    x: 'c3VmZml4',
  })

  it.each([-1, -5000, 0, 0.5, 1234.56, 2 ** 53, 'ten', null])(
    'rejects a non-positive-integer amount %p',
    a => {
      expect(() => decodeSession(amountQr(a))).toThrow(CodecError)
    }
  )

  it('accepts a valid positive integer amount', () => {
    expect(decodeSession(amountQr(5000)).amount).toBe(5000)
  })

  // ── Open requests: the payee names no figure and the payer chooses ──
  //
  // The distinction that matters is ABSENT vs PRESENT-BUT-BAD. Absent is a
  // legitimate request shape; anything else is a payee asserting a number, and
  // a bad one must be refused rather than degraded into "any amount", which
  // would put a live Send button under a corrupt value.

  it('mints an open session with no amount', () => {
    const s = mintSession({ ...args, amount: undefined })
    expect(s.amount).toBeUndefined()
    expect('amount' in s).toBe(false)
  })

  it('refuses to mint a session with a bad amount', () => {
    expect(() => mintSession({ ...args, amount: 0 })).toThrow(CodecError)
    expect(() => mintSession({ ...args, amount: -1 })).toThrow(CodecError)
    expect(() => mintSession({ ...args, amount: 1.5 })).toThrow(CodecError)
  })

  it('round-trips an open session', () => {
    const s = mintSession({ ...args, amount: undefined })
    const back = decodeSession(encodeSession(s))
    expect(back).toEqual(s)
    expect(back.amount).toBeUndefined()
  })

  it('omits the amount key entirely rather than encoding null', () => {
    const s = mintSession({ ...args, amount: undefined })
    const b64 = encodeSession(s).slice('bsvpay1:'.length).replace(/-/g, '+').replace(/_/g, '/')
    const body = globalThis.atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    expect(body).not.toContain('"a"')
  })

  it('treats an absent amount as an open request', () => {
    const qr = encodeCustomQR({
      v: SESSION_VERSION,
      c: 0,
      s: 'A'.repeat(22),
      k: 'A'.repeat(43),
      i: args.identityKey,
      p: 'cHJlZml4',
      x: 'c3VmZml4',
    })
    expect(decodeSession(qr).amount).toBeUndefined()
  })

  // An explicit null is a shape encodeSession never produces. Accepting it
  // would widen the payer-chooses path to something no honest peer sends.
  it('rejects an explicit null amount rather than reading it as open', () => {
    expect(() => decodeSession(amountQr(null))).toThrow(CodecError)
  })

  it('keeps an open session small enough for one static QR', () => {
    expect(encodeSession(mintSession({ ...args, amount: undefined })).length).toBeLessThan(300)
  })

  it('rejects non-numeric caps', () => {
    const qr = encodeCustomQR({
      v: SESSION_VERSION,
      c: 'not-a-number',
      s: 'AAAA',
      k: 'AAAA',
      i: args.identityKey,
      a: 5000,
      p: 'cHJlZml4',
      x: 'c3VmZml4',
    })
    expect(() => decodeSession(qr)).toThrow(CodecError)
  })

  // ── CAP_NEARBY and the advisory OS field ──

  it('mints CAP_NEARBY and the OS field, and round-trips them', () => {
    const s = mintSession({ ...args, supportsAwdl: false, supportsNearby: true, os: 'android' })
    expect(s.caps & CAP_NEARBY).toBe(CAP_NEARBY)
    expect(s.caps & CAP_AWDL).toBe(0)
    const decoded = decodeSession(encodeSession(s))
    expect(decoded.caps).toBe(s.caps)
    expect(decoded.os).toBe('android')
  })

  it('omits the OS field when unknown and tolerates junk in it', () => {
    const s = mintSession(args)
    expect(encodeSession(s)).not.toContain('"o"')
    // A future build may send values this one does not know: they read as absent.
    const body = decodeQR(encodeSession({ ...s, os: 'ios' }))
    body.o = 'z'
    const tampered = encodeCustomQR(body)
    expect(decodeSession(tampered).os).toBeUndefined()
  })

  it('a payload with unknown extra keys and unknown cap bits still decodes', () => {
    const s = mintSession(args)
    const body = decodeQR(encodeSession(s))
    body.c = 0xff // future caps
    body.future = 'ignored'
    const wire = encodeCustomQR(body)
    const decoded = decodeSession(wire)
    expect(decoded.caps & CAP_AWDL).toBe(CAP_AWDL)
  })
})

// ── Session asset block (token requests) ──

const baseMintArgs = () => ({
  identityKey: '02'.padEnd(66, 'd'),
  derivationPrefix: 'cA',
  derivationSuffix: 'cw',
  supportsAwdl: true,
})

const bytesToB64url = (b: Uint8Array) => {
  let s = ''
  for (const byte of b) s += String.fromCharCode(byte)
  return globalThis.btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const b64urlToBytes = (s: string) => {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(globalThis.atob(pad + '='.repeat((4 - (pad.length % 4)) % 4)), c => c.charCodeAt(0))
}

const asset = (): SessionAsset => ({
  id: 'ab'.repeat(32) + '.0',
  label: 'Example Dollar',
  ticker: 'EXD',
  decimals: 2,
  overlayUrl: 'https://overlay.issuer.example',
  overlayIdentityKey: '03'.padEnd(66, 'b'),
})

describe('session asset block', () => {
  it('round-trips a token request with amount in base units', () => {
    const s = mintSession({ ...baseMintArgs(), amount: 12345, asset: asset() })
    const decoded = decodeSession(encodeSession(s))
    expect(decoded.asset).toEqual(asset())
    expect(decoded.amount).toBe(12345)
    expect(decoded.version).toBe(1)
  })

  it('round-trips an asset without optional display fields', () => {
    const bare = { id: asset().id, overlayUrl: asset().overlayUrl, overlayIdentityKey: asset().overlayIdentityKey }
    const s = mintSession({ ...baseMintArgs(), asset: bare })
    expect(decodeSession(encodeSession(s)).asset).toEqual(bare)
  })

  it('omits t entirely for a BSV session', () => {
    const s = mintSession(baseMintArgs())
    expect(decodeSession(encodeSession(s)).asset).toBeUndefined()
    expect('t' in decodeQR(encodeSession(s))).toBe(false)
  })

  it('refuses a malformed asset at decode', () => {
    const s = mintSession({ ...baseMintArgs(), asset: asset() })
    const raw = JSON.parse(new TextDecoder().decode(b64urlToBytes(encodeSession(s).slice('bsvpay1:'.length))))
    raw.t.k = 'short'
    const forged = 'bsvpay1:' + bytesToB64url(new TextEncoder().encode(JSON.stringify(raw)))
    expect(() => decodeSession(forged)).toThrow(CodecError)
  })

  // The old check (`length < 66 && includes('.')`) accepted this: 66 chars,
  // has a dot, but the 64-char half is not hex — not a real "<txid>.<vout>".
  it('refuses a 66-char assetId that is not a valid txid.vout shape', () => {
    const s = mintSession({ ...baseMintArgs(), asset: asset() })
    const raw = JSON.parse(new TextDecoder().decode(b64urlToBytes(encodeSession(s).slice('bsvpay1:'.length))))
    raw.t.i = 'z'.repeat(64) + '.0'
    const forged = 'bsvpay1:' + bytesToB64url(new TextEncoder().encode(JSON.stringify(raw)))
    expect(() => decodeSession(forged)).toThrow(CodecError)
  })

  it('CAP_BLE is allocated and unknown-to-us bits survive decode', () => {
    expect(CAP_BLE).toBe(0x04)
    const s = mintSession(baseMintArgs())
    const raw = JSON.parse(new TextDecoder().decode(b64urlToBytes(encodeSession(s).slice('bsvpay1:'.length))))
    raw.c = (raw.c ?? 0) | CAP_BLE
    const forged = 'bsvpay1:' + bytesToB64url(new TextEncoder().encode(JSON.stringify(raw)))
    expect(decodeSession(forged).caps & CAP_BLE).toBe(CAP_BLE)
  })
})
