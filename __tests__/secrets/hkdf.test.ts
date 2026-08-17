/**
 * HKDF pinned to RFC 5869's own test vectors.
 *
 * These vectors previously lived in `__tests__/vault/sealing.test.ts`. The vault
 * stopped sealing when it moved to the R1-K1 script template, but the HKDF
 * itself is generic and is still the derivation behind `services/secrets`, so
 * the vectors move with the function rather than being deleted with the file.
 */
import { Utils } from '@bsv/sdk'
import { hkdfSha256 } from '../../services/secrets/hkdf'

describe('hkdfSha256 (RFC 5869)', () => {
  test('test case 1: basic SHA-256', () => {
    const ikm = Array(22).fill(0x0b)
    const salt = Array.from({ length: 13 }, (_, i) => i)
    const info = Array.from({ length: 10 }, (_, i) => 0xf0 + i)
    const okm = hkdfSha256(ikm, salt, info, 42)
    expect(Utils.toHex(okm)).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865'
    )
  })

  test('test case 3: zero-length salt and info', () => {
    const ikm = Array(22).fill(0x0b)
    const okm = hkdfSha256(ikm, [], [], 42)
    expect(Utils.toHex(okm)).toBe(
      '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8'
    )
  })

  test('string info is UTF-8 encoded', () => {
    const a = hkdfSha256([1, 2, 3], [4, 5, 6], 'vault')
    const b = hkdfSha256([1, 2, 3], [4, 5, 6], Array.from(Buffer.from('vault', 'utf8')))
    expect(a).toEqual(b)
    expect(a).toHaveLength(32)
  })
})
