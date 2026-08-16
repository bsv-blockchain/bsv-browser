/**
 * RFC 5869 HKDF with SHA-256.
 *
 * This lived in `services/vault/sealing.ts` until the vault moved to the R1-K1
 * script template and stopped sealing anything. The function itself was never
 * vault-specific — it is generic key derivation, and `services/secrets` is now
 * its only consumer, so it lives here rather than under a module that no longer
 * exists.
 *
 * Pinned to the RFC's own test vectors in `__tests__/secrets/hkdf.test.ts`.
 */
import { Hash, Utils } from '@bsv/sdk'

const HASH_LEN = 32

/** RFC 5869 HKDF with SHA-256. `info` accepts bytes or a UTF-8 string. */
export function hkdfSha256(
  ikm: number[],
  salt: number[],
  info: number[] | string,
  length: number = 32
): number[] {
  if (length > 255 * HASH_LEN) throw new Error('hkdf: length too large')
  const infoBytes: number[] = typeof info === 'string' ? Utils.toArray(info, 'utf8') : info
  // Extract: PRK = HMAC(salt, IKM); zero-length salt means a hash-length zero block
  const prk = Hash.sha256hmac(salt.length > 0 ? salt : Array(HASH_LEN).fill(0), ikm)
  // Expand
  const okm: number[] = []
  let t: number[] = []
  let counter = 1
  while (okm.length < length) {
    t = Hash.sha256hmac(prk, [...t, ...infoBytes, counter])
    okm.push(...t)
    counter++
  }
  return okm.slice(0, length)
}
