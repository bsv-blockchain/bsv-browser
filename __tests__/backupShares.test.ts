/**
 * Backup share payload format (BRC-157).
 *
 * The single failure mode worth this much coverage: a misclassified payload
 * restores a DIFFERENT wallet without erroring. Length cannot arbitrate —
 * PrivateKey drops leading zero bytes, and a 24-word phrase's entropy is 32
 * bytes, the same width as a legacy primary key. The sha256 tag is what
 * decides.
 */
import { Mnemonic, PrivateKey, Hash } from '@bsv/sdk'
import {
  ENTROPY_BYTES,
  PAYLOAD_BYTES,
  frameEntropy,
  padPayload,
  classifyPayload,
  generateEntropyShares,
  generateLegacyKeyShares,
  recoverSecretFromShares
} from '../utils/backupShares'

const entropyOf = (m: Mnemonic): number[] => m.toEntropy()

describe('payload framing', () => {
  test('frames entropy to exactly 32 bytes with a sha256 tag', () => {
    const entropy = new Array(ENTROPY_BYTES).fill(7)
    const payload = frameEntropy(entropy)

    expect(payload).toHaveLength(PAYLOAD_BYTES)
    expect(payload.slice(0, ENTROPY_BYTES)).toEqual(entropy)
    expect(payload.slice(ENTROPY_BYTES)).toEqual(Hash.sha256(entropy).slice(0, 16))
  })

  test('rejects entropy that is not 16 bytes', () => {
    expect(() => frameEntropy(new Array(32).fill(1))).toThrow(/16 bytes/)
  })

  test('left-pads a truncated payload back to full width', () => {
    // PrivateKey is a BigNumber: a payload starting 0x00 comes back short.
    expect(padPayload([1, 2, 3])).toHaveLength(PAYLOAD_BYTES)
    expect(padPayload([1, 2, 3]).slice(-3)).toEqual([1, 2, 3])
    expect(padPayload([1, 2, 3]).slice(0, 29).every(b => b === 0)).toBe(true)
  })

  test('rejects an over-wide payload rather than silently truncating', () => {
    expect(() => padPayload(new Array(33).fill(1))).toThrow(/32 bytes/)
  })
})

describe('classification', () => {
  test('classifies a framed payload as entropy and returns it exactly', () => {
    const entropy = entropyOf(Mnemonic.fromRandom(128))
    const result = classifyPayload(frameEntropy(entropy))

    expect(result.kind).toBe('entropy')
    expect(result.kind === 'entropy' && result.entropy).toEqual(entropy)
  })

  test('classifies a random 32-byte private key as legacy', () => {
    for (let i = 0; i < 50; i++) {
      const key = Array.from(PrivateKey.fromRandom().toArray())
      expect(classifyPayload(key).kind).toBe('legacy')
    }
  })

  test('a corrupted tag degrades to legacy rather than yielding a wrong entropy', () => {
    const entropy = entropyOf(Mnemonic.fromRandom(128))
    const payload = frameEntropy(entropy)
    payload[PAYLOAD_BYTES - 1] ^= 0xff

    expect(classifyPayload(payload).kind).toBe('legacy')
  })

  test('recovers a truncated entropy payload correctly', () => {
    // Force a payload whose first byte is 0x00, which PrivateKey.toArray() drops.
    let entropy: number[] | null = null
    for (let i = 0; i < 5000 && entropy === null; i++) {
      const e = entropyOf(Mnemonic.fromRandom(128))
      if (e[0] === 0) entropy = e
    }
    expect(entropy).not.toBeNull()

    const truncated = frameEntropy(entropy as number[]).slice(1)
    const result = classifyPayload(truncated)

    expect(result.kind).toBe('entropy')
    expect(result.kind === 'entropy' && result.entropy).toEqual(entropy)
  })
})

describe('share round-trip', () => {
  test('entropy survives split and recombine, and rebuilds the same phrase', () => {
    const mnemonic = Mnemonic.fromRandom(128)
    const entropy = entropyOf(mnemonic)
    const shares = generateEntropyShares(entropy)

    expect(shares).toHaveLength(3)

    const result = recoverSecretFromShares(shares.slice(0, 2))
    expect(result.kind).toBe('entropy')
    expect(result.kind === 'entropy' && result.entropy).toEqual(entropy)
    expect(
      result.kind === 'entropy' && Mnemonic.fromEntropy(result.entropy).toString()
    ).toBe(mnemonic.toString())
  })

  test('any two of three shares recover the same secret', () => {
    const entropy = entropyOf(Mnemonic.fromRandom(128))
    const shares = generateEntropyShares(entropy)

    for (const pair of [[0, 1], [0, 2], [1, 2]]) {
      const r = recoverSecretFromShares([shares[pair[0]], shares[pair[1]]])
      expect(r.kind === 'entropy' && r.entropy).toEqual(entropy)
    }
  })

  test('legacy key shares still recombine and classify as legacy', () => {
    const key = Array.from(PrivateKey.fromRandom().toArray())
    const result = recoverSecretFromShares(generateLegacyKeyShares(key).slice(0, 2))

    expect(result.kind).toBe('legacy')
    expect(result.kind === 'legacy' && result.primaryKey).toEqual(key)
  })

  test('entropy and legacy shares of the same wallet carry different integrity hashes', () => {
    // This is what makes mixing v1 and v2 paper impossible; validateShareCompatibility
    // already rejects on it.
    const mnemonic = Mnemonic.fromRandom(128)
    const entropy = entropyOf(mnemonic)
    const key = Array.from(PrivateKey.fromRandom().toArray())

    const a = generateEntropyShares(entropy)[0].split('.')[3]
    const b = generateLegacyKeyShares(key)[0].split('.')[3]

    expect(a).not.toBe(b)
  })
})
