/**
 * Sealing crypto tests — the vault's cryptographic core.
 *
 * HKDF is pinned to RFC 5869 test vectors; seal/unseal is exercised the way
 * the real system splits it: seal computes ECDH in software against the
 * token's public key, unseal receives the shared secret the way the token
 * would return it (32-byte x-coordinate) and must reproduce the vault key.
 */
import { p256 } from '@noble/curves/nist.js'
import { Utils } from '@bsv/sdk'
import { hkdfSha256, sealVaultKey, unsealVaultKey, softwareEcdh } from '../../services/vault/sealing'
import { VaultError } from '../../services/vault/types'

const hex = (b: Uint8Array): string => Utils.toHex(Array.from(b))

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

describe('seal/unseal', () => {
  const yubiPriv = p256.utils.randomSecretKey()
  const yubiPub = p256.getPublicKey(yubiPriv, false) // uncompressed, like PIV returns

  const freshV = (): number[] => {
    const v = new Uint8Array(32)
    for (let i = 0; i < 32; i++) v[i] = Math.floor(Math.random() * 256)
    v[0] = Math.max(1, v[0] & 0x7f) // keep well inside the scalar field for test purposes
    return Array.from(v)
  }

  test('round trip: unseal(blob, tokenEcdh(ePub)) === V', () => {
    const v = freshV()
    const blob = sealVaultKey(v, hex(yubiPub), { slot: 0x82, serial: '31337042' })
    expect(blob.v).toBe(1)
    expect(blob.slot).toBe(0x82)
    expect(blob.yubiSerial).toBe('31337042')
    expect(blob.ePub).toHaveLength(65 * 2)
    expect(blob.salt).toHaveLength(32 * 2)
    // what the YubiKey computes on-token during the ceremony:
    const shared = softwareEcdh(hex(yubiPriv), blob.ePub)
    expect(shared).toHaveLength(32 * 2)
    expect(unsealVaultKey(blob, shared)).toEqual(v)
  })

  test('every seal is unique (fresh ephemeral + salt)', () => {
    const v = freshV()
    const a = sealVaultKey(v, hex(yubiPub), { slot: 0x82, serial: 's' })
    const b = sealVaultKey(v, hex(yubiPub), { slot: 0x82, serial: 's' })
    expect(a.ePub).not.toBe(b.ePub)
    expect(a.salt).not.toBe(b.salt)
    expect(a.c).not.toBe(b.c)
  })

  test('tampered ciphertext throws seal-corrupt', () => {
    const v = freshV()
    const blob = sealVaultKey(v, hex(yubiPub), { slot: 0x82, serial: 's' })
    const c = blob.c.split('')
    c[10] = c[10] === '0' ? '1' : '0'
    const tampered = { ...blob, c: c.join('') }
    const shared = softwareEcdh(hex(yubiPriv), blob.ePub)
    expect(() => unsealVaultKey(tampered, shared)).toThrow(VaultError)
    try {
      unsealVaultKey(tampered, shared)
    } catch (e) {
      expect((e as VaultError).code).toBe('seal-corrupt')
    }
  })

  test('wrong shared secret throws seal-corrupt', () => {
    const v = freshV()
    const blob = sealVaultKey(v, hex(yubiPub), { slot: 0x82, serial: 's' })
    const otherPriv = p256.utils.randomSecretKey()
    const wrongShared = softwareEcdh(hex(otherPriv), blob.ePub)
    expect(() => unsealVaultKey(blob, wrongShared)).toThrow(VaultError)
  })

  test('softwareEcdh is symmetric across sides', () => {
    // seal-side: ecdh(ephemeralPriv, yubiPub); token-side: ecdh(yubiPriv, ephemeralPub)
    const ePriv = p256.utils.randomSecretKey()
    const ePub = p256.getPublicKey(ePriv, false)
    expect(softwareEcdh(hex(ePriv), hex(yubiPub))).toBe(softwareEcdh(hex(yubiPriv), hex(ePub)))
  })
})
