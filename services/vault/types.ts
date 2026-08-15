/**
 * Vault domain types — shared by the sealing crypto, the store, the ceremony
 * controller, and the UI. No React, no I/O.
 */

/** Persisted seal: everything needed to recover the vault key EXCEPT the
 * on-token ECDH. The blob alone is useless without the physical YubiKey. */
export interface SealedBlob {
  v: 1
  /** PIV slot holding the P-256 key (0x82, first "retired" slot). */
  slot: number
  /** Ephemeral P-256 public key, hex, 65-byte uncompressed SEC1 point. */
  ePub: string
  /** HKDF salt, hex, 32 bytes. */
  salt: string
  /** AES-256-GCM ciphertext of the vault key (SymmetricKey wire format), hex. */
  c: string
  /** Serial of the enrolled YubiKey — ceremony rejects other keys early. */
  yubiSerial: string
  /** sha256 of the token public key, hex — sanity check against slot rewrites. */
  yubiPubSha256: string
}

export type VaultErrorCode =
  | 'unsupported-platform'
  | 'no-key'
  | 'wrong-key'
  | 'pin-required'
  | 'pin-invalid'
  | 'pin-locked'
  | 'touch-timeout'
  | 'key-removed-mid-op'
  | 'mgmt-key-custom'
  | 'slot-occupied'
  | 'seal-corrupt'
  /** The R1-K1 template artifact, a locking script, or a digest failed a
   * structural check. Programmer error or a corrupted dependency — never
   * something a user can cause or fix. Distinct from 'wrong-key', which
   * vaultErrorFromNative may reclassify to 'nfc-lost'. */
  | 'template-invalid'
  | 'serial-mismatch'
  | 'user-cancelled'
  | 'not-enrolled'
  | 'driver-unavailable'
  | 'vault-empty'
  | 'amount-exceeds-balance'
  | 'below-dust'
  | 'no-transaction'
  | 'nfc-lost'
  /** Vault passphrase missing or empty — an empty one would collide with the
   * main wallet's master key. */
  | 'bad-passphrase'
  /** Main wallet recovery phrase failed BIP39 validation. */
  | 'bad-mnemonic'
  /** Deposit index outside the non-hardened BIP32 range. */
  | 'bad-derivation-index'

export class VaultError extends Error {
  code: VaultErrorCode
  /** PIN attempts remaining, present on pin-invalid. */
  retriesLeft?: number

  constructor(code: VaultErrorCode, message?: string, retriesLeft?: number) {
    super(message ?? code)
    this.name = 'VaultError'
    this.code = code
    this.retriesLeft = retriesLeft
  }
}

/** Native YubiKit description substrings for a dropped NFC field mid-command
 * (the phone moved a hair off the key, or the key was lifted). This is
 * transient and retryable — never a wrong key, but older/currently-installed
 * builds' Swift `mapError` falls through to its `wrong-key` default for any
 * description it doesn't specifically recognize, which includes this one. */
const NFC_LOST_PATTERN = /tag response error|no response|tag connection lost|session invalidated/i

/** Parse a native-module rejection (`VAULT_ERR:<code>:<detail>`) into a
 * VaultError; anything unrecognized becomes a generic driver failure. */
export function vaultErrorFromNative(e: unknown): VaultError {
  const msg = e instanceof Error ? e.message : String(e)
  const m = /^VAULT_ERR:([a-z-]+):?(.*)$/.exec(msg)
  if (m) {
    let code = m[1] as VaultErrorCode
    const detailMatch = /retries=(\d+)/.exec(m[2])
    // Reclassify a native `wrong-key` whose detail is really an NFC dropout —
    // see NFC_LOST_PATTERN. Safe to keep even after the native side is fixed
    // to classify this correctly at the source: this simply never matches then.
    if (code === 'wrong-key' && NFC_LOST_PATTERN.test(m[2])) {
      code = 'nfc-lost'
    }
    return new VaultError(code, m[2] || undefined, detailMatch ? Number(detailMatch[1]) : undefined)
  }
  return new VaultError('driver-unavailable', msg)
}
