import {
  mintSession, encodeSession, decodeSession, instanceName, CAP_AWDL, SESSION_VERSION,
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
})
