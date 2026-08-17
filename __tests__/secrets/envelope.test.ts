/**
 * Envelope crypto — pure, no mocks needed.
 */
import { Random, Utils } from '@bsv/sdk'
import { openSecret, sealSecret, assertKekId, generateKek } from '../../services/secrets/envelope'
import { EnvelopeError } from '../../services/secrets/types'

const KEK_ID = 'a1b2c3d4e5f60718'
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('secret envelope', () => {
  it('round-trips ascii, a full mnemonic and multi-byte utf-8', () => {
    const kek = generateKek()
    for (const plaintext of [MNEMONIC, 'hello', 'garçon 🔐 çà et là', '한국어 테스트']) {
      const blob = sealSecret(kek, KEK_ID, 'mnemonic', plaintext)
      expect(openSecret(kek, 'mnemonic', blob)).toBe(plaintext)
    }
  })

  it('produces a fresh salt and ciphertext per seal', () => {
    const kek = generateKek()
    const a = sealSecret(kek, KEK_ID, 'mnemonic', MNEMONIC)
    const b = sealSecret(kek, KEK_ID, 'mnemonic', MNEMONIC)
    expect(a.salt).not.toBe(b.salt)
    expect(a.c).not.toBe(b.c)
  })

  it('domain-separates by secret name', () => {
    const kek = generateKek()
    const blob = sealSecret(kek, KEK_ID, 'mnemonic', MNEMONIC)
    // A blob sealed as one secret must not open as another, even with the
    // right KEK — this stands in for AAD, which SymmetricKey does not expose.
    expect(() => openSecret(kek, 'recoveredKey', blob)).toThrow(EnvelopeError)
    try {
      openSecret(kek, 'recoveredKey', blob)
    } catch (e) {
      expect((e as EnvelopeError).code).toBe('corrupt')
    }
  })

  it('fails to open under a different KEK', () => {
    const blob = sealSecret(generateKek(), KEK_ID, 'mnemonic', MNEMONIC)
    expect(() => openSecret(generateKek(), 'mnemonic', blob)).toThrow(EnvelopeError)
  })

  it('reports a stale kekId as kek-mismatch, not corrupt', () => {
    const kek = generateKek()
    const blob = sealSecret(kek, KEK_ID, 'mnemonic', MNEMONIC)
    try {
      assertKekId(blob, 'ffffffffffffffff')
      throw new Error('expected assertKekId to throw')
    } catch (e) {
      expect((e as EnvelopeError).code).toBe('kek-mismatch')
    }
  })

  it('rejects an unknown version', () => {
    const kek = generateKek()
    const blob = { ...sealSecret(kek, KEK_ID, 'mnemonic', MNEMONIC), v: 2 }
    try {
      openSecret(kek, 'mnemonic', blob)
      throw new Error('expected openSecret to throw')
    } catch (e) {
      expect((e as EnvelopeError).code).toBe('bad-version')
    }
  })

  it('maps tampered ciphertext to corrupt and never leaks a bare crypto Error', () => {
    const kek = generateKek()
    const blob = sealSecret(kek, KEK_ID, 'mnemonic', MNEMONIC)
    const flipped = blob.c.slice(0, -1) + (blob.c.endsWith('0') ? '1' : '0')
    try {
      openSecret(kek, 'mnemonic', { ...blob, c: flipped })
      throw new Error('expected openSecret to throw')
    } catch (e) {
      expect(e).toBeInstanceOf(EnvelopeError)
      expect((e as EnvelopeError).code).toBe('corrupt')
      expect((e as Error).message).not.toMatch(/Decryption failed/)
    }
  })

  it('rejects a truncated ciphertext rather than throwing from the primitive', () => {
    const kek = generateKek()
    const blob = sealSecret(kek, KEK_ID, 'mnemonic', MNEMONIC)
    try {
      openSecret(kek, 'mnemonic', { ...blob, c: blob.c.slice(0, 40) })
      throw new Error('expected openSecret to throw')
    } catch (e) {
      expect((e as EnvelopeError).code).toBe('corrupt')
    }
  })

  it('rejects malformed and non-object blobs', () => {
    const kek = generateKek()
    for (const bad of [null, 'nope', {}, { v: 1, kekId: 'x' }]) {
      expect(() => openSecret(kek, 'mnemonic', bad)).toThrow(EnvelopeError)
    }
  })

  it('round-trips a KEK with a leading zero byte', () => {
    // SymmetricKey extends BigNumber; a KEK whose first byte is zero happens
    // 1-in-256 of the time and must not lose a byte on re-serialisation.
    const kek = [0, ...Random(31)]
    const blob = sealSecret(kek, KEK_ID, 'mnemonic', MNEMONIC)
    expect(openSecret(kek, 'mnemonic', blob)).toBe(MNEMONIC)
  })

  it('generates 32-byte keys and 32-byte salts', () => {
    expect(generateKek()).toHaveLength(32)
    const blob = sealSecret(generateKek(), KEK_ID, 'mnemonic', 'x')
    expect(Utils.toArray(blob.salt, 'hex')).toHaveLength(32)
  })
})
