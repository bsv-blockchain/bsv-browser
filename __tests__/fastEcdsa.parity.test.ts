import { PrivateKey, BigNumber, Signature } from '@bsv/sdk'
import { installFastEcdsa } from '@/utils/crypto/installFastEcdsa'
import { sign, verify } from '@/utils/crypto/fastECDSA'

// Also import ORIGINAL via special alias that metro/jest maps to real SDK ECDSA
// In Jest moduleNameMapper: '^@bsv/sdk-original-ecdsa$': '<rootDir>/node_modules/@bsv/sdk/dist/cjs/src/primitives/ECDSA.js'
import * as OriginalECDSA from '@bsv/sdk-original-ecdsa'

describe('fastECDSA parity', () => {
  beforeAll(() => {
    installFastEcdsa()
  })

  it('signs and verifies with low-S', () => {
    const key = new PrivateKey(1)
    const msg = new BigNumber(
      '4d7a2145a347e0aabf58a6a1260ae359436b27eaca5ac5cba6685a6f6e0fe39c',
      16
    )
    const sig = sign(msg, key, true)
    expect(sig).toBeInstanceOf(Signature)
    expect(verify(msg, sig, key.toPublicKey())).toBe(true)
    // Cross-check original verifier
    expect(OriginalECDSA.verify(msg, sig, key.toPublicKey())).toBe(true)
  })

  it('matches original for fixed customK path by delegating', () => {
    const key = new PrivateKey(2)
    const msg = new BigNumber(
      'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00',
      16
    )
    const k = new BigNumber(123456789)
    const a = sign(msg, key, true, k)
    const b = OriginalECDSA.sign(msg, key, true, k)
    expect(a.r.toString(16)).toBe(b.r.toString(16))
    expect(a.s.toString(16)).toBe(b.s.toString(16))
  })

  it('rejects oversized message hashes like the original', () => {
    const key = new PrivateKey(3)
    const huge = new BigNumber(1).ushln(300)
    expect(() => sign(huge, key, true)).toThrow(/too large/)
  })
})
