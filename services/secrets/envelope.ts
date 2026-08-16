/**
 * Secret envelope crypto — pure functions, no I/O, no logging.
 *
 * Scheme (`bsvb-secret-envelope-v1`):
 *
 *   seal : DEK = HKDF-SHA256(KEK, salt, "bsvb-secret-envelope-v1|<name>")
 *          C   = AES-256-GCM(DEK, utf8(plaintext))
 *   open : same derivation, then AES-GCM-decrypt.
 *
 * The KEK never encrypts anything directly: each secret gets its own derived
 * DEK, so a blob sealed as `mnemonic` cannot be opened as `recoveredKey`. That
 * is the stand-in for AAD, which @bsv/sdk's SymmetricKey does not expose.
 *
 * SECURITY: never log inputs or outputs of these functions.
 */
import { SymmetricKey, Random, Utils } from '@bsv/sdk'
import { hkdfSha256 } from '../vault/sealing'
import { EnvelopeBlob, EnvelopeError, SecretName } from './types'

export const ENVELOPE_INFO = 'bsvb-secret-envelope-v1'

const SALT_LEN = 32
const KEK_LEN = 32
/** SymmetricKey wire format is iv(32) || ct || tag(16). */
const MIN_CIPHERTEXT_BYTES = 48

const deriveDek = (kek: number[], salt: number[], name: SecretName): number[] =>
  hkdfSha256(kek, salt, `${ENVELOPE_INFO}|${name}`, 32)

/** Fresh 32-byte key-encryption key. Uses @bsv/sdk's Random, which routes to
 * the platform CSPRNG — deliberately NOT services/vault/random.ts, whose
 * expo-crypto path has a Math.random branch under remote debugging. */
export function generateKek(): number[] {
  return Random(KEK_LEN)
}

/** Short public identifier for a KEK, so a blob can name the key that sealed
 * it without revealing anything about it. */
export function generateKekId(): string {
  return Utils.toHex(Random(8))
}

export function sealSecret(
  kek: number[],
  kekId: string,
  name: SecretName,
  plaintext: string
): EnvelopeBlob {
  const salt = Random(SALT_LEN)
  const dek = deriveDek(kek, salt, name)
  const c = new SymmetricKey(dek).encrypt(Utils.toArray(plaintext, 'utf8')) as number[]
  return { v: 1, kekId, salt: Utils.toHex(salt), c: Utils.toHex(c) }
}

/**
 * Open a blob. Throws EnvelopeError and never lets a bare crypto Error escape:
 * SymmetricKey throws `Error('Decryption failed!')` / `Error('Ciphertext too
 * short')`, which callers must not have to pattern-match on.
 */
export function openSecret(kek: number[], name: SecretName, blob: unknown): string {
  const b = blob as EnvelopeBlob | null
  if (!b || typeof b !== 'object') {
    throw new EnvelopeError('corrupt', 'envelope: not an object')
  }
  if (b.v !== 1) {
    throw new EnvelopeError('bad-version', `envelope: unsupported version ${String(b.v)}`)
  }
  if (typeof b.salt !== 'string' || typeof b.c !== 'string' || typeof b.kekId !== 'string') {
    throw new EnvelopeError('corrupt', 'envelope: malformed fields')
  }

  let salt: number[]
  let ct: number[]
  try {
    salt = Utils.toArray(b.salt, 'hex') as number[]
    ct = Utils.toArray(b.c, 'hex') as number[]
  } catch {
    throw new EnvelopeError('corrupt', 'envelope: bad hex')
  }
  if (salt.length !== SALT_LEN || ct.length < MIN_CIPHERTEXT_BYTES) {
    throw new EnvelopeError('corrupt', 'envelope: bad lengths')
  }

  const dek = deriveDek(kek, salt, name)
  let plain: number[]
  try {
    plain = new SymmetricKey(dek).decrypt(ct) as number[]
  } catch {
    // Indistinguishable by design: wrong KEK, wrong name, or tampered bytes.
    throw new EnvelopeError('corrupt', 'envelope: decryption failed')
  }
  return Utils.toUTF8(plain)
}

/** Assert the blob was sealed by the KEK we hold, before attempting to open it.
 * Separated from openSecret so a stale blob reports `kek-mismatch` rather than
 * the generic `corrupt`. */
export function assertKekId(blob: EnvelopeBlob, expectedKekId: string): void {
  if (blob.kekId !== expectedKekId) {
    throw new EnvelopeError('kek-mismatch', 'envelope: sealed by a different KEK')
  }
}
