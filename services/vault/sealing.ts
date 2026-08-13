/**
 * Vault sealing crypto — pure functions, no I/O, no logging.
 *
 * Scheme (`bsvb-vault-seal-v1`, the age-plugin-yubikey / systemd-cryptenroll
 * PKCS#11 pattern):
 *
 *   seal   : ephemeral P-256 keypair e/E; S = ECDH(e, yubiPub);
 *            KEK = HKDF-SHA256(S, salt, info); C = AES-256-GCM(KEK, V)
 *   unseal : S = on-token ECDH(slot, E)  ← the touch-gated step;
 *            KEK = HKDF(S, salt, info); V = AES-GCM-decrypt(KEK, C)
 *
 * The token returns the 32-byte x-coordinate of the shared point (PIV
 * KeyAgreement semantics); softwareEcdh mirrors that exactly so both sides
 * derive the same KEK.
 *
 * SECURITY: never log inputs or outputs of these functions.
 */
import { p256 } from '@noble/curves/nist.js'
import { Hash, SymmetricKey, Utils } from '@bsv/sdk'
import { SealedBlob, VaultError } from './types'
import { randomBytes } from './random'

export const SEAL_INFO = 'bsvb-vault-seal-v1'

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

/** ECDH over P-256 returning the hex x-coordinate (32 bytes) — the same value
 * a YubiKey's PIV KeyAgreement operation produces. */
export function softwareEcdh(privHex: string, pubHex: string): string {
  const priv = Uint8Array.from(Utils.toArray(privHex, 'hex'))
  const pub = Uint8Array.from(Utils.toArray(pubHex, 'hex'))
  const shared = p256.getSharedSecret(priv, pub, false) // 65B uncompressed point
  return Utils.toHex(Array.from(shared.slice(1, 33)))
}

/** Generate a fresh ephemeral P-256 scalar from our own entropy source
 * (avoids depending on a WebCrypto global under React Native). */
function ephemeralKeypair(): { privHex: string; pubHex: string } {
  // Rejection-sample until the scalar is valid for the curve (overwhelmingly
  // first-try; the loop is belt-and-braces).
  for (;;) {
    const candidate = Uint8Array.from(randomBytes(32))
    try {
      const pub = p256.getPublicKey(candidate, false)
      return { privHex: Utils.toHex(Array.from(candidate)), pubHex: Utils.toHex(Array.from(pub)) }
    } catch {
      // invalid scalar (zero or >= order) — draw again
    }
  }
}

/** Seal the vault key V to a YubiKey's PIV public key. Software-only —
 * requires no token present, so re-sealing and enrollment never need touch. */
export function sealVaultKey(
  v: number[],
  yubiPubHex: string,
  meta: { slot: number; serial: string }
): SealedBlob {
  const { privHex: ePriv, pubHex: ePub } = ephemeralKeypair()
  const salt = randomBytes(32)
  const shared = softwareEcdh(ePriv, yubiPubHex)
  const kek = hkdfSha256(Utils.toArray(shared, 'hex'), salt, SEAL_INFO)
  const c = new SymmetricKey(kek).encrypt(v) as number[]
  return {
    v: 1,
    slot: meta.slot,
    ePub,
    salt: Utils.toHex(salt),
    c: Utils.toHex(c),
    yubiSerial: meta.serial,
    yubiPubSha256: Utils.toHex(Hash.sha256(Utils.toArray(yubiPubHex, 'hex')))
  }
}

/** Recover V from a seal given the token-computed shared secret (hex
 * x-coordinate from the ceremony's ECDH). Throws `seal-corrupt` on any
 * mismatch — wrong secret, tampered ciphertext, malformed blob. */
export function unsealVaultKey(blob: SealedBlob, sharedSecretHex: string): number[] {
  try {
    const kek = hkdfSha256(Utils.toArray(sharedSecretHex, 'hex'), Utils.toArray(blob.salt, 'hex'), SEAL_INFO)
    return new SymmetricKey(kek).decrypt(Utils.toArray(blob.c, 'hex')) as number[]
  } catch {
    throw new VaultError('seal-corrupt', 'Vault seal could not be opened')
  }
}
