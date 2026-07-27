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
})
