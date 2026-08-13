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
  | 'serial-mismatch'
  | 'user-cancelled'
  | 'not-enrolled'
  | 'driver-unavailable'

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

/** Parse a native-module rejection (`VAULT_ERR:<code>:<detail>`) into a
 * VaultError; anything unrecognized becomes a generic driver failure. */
export function vaultErrorFromNative(e: unknown): VaultError {
  const msg = e instanceof Error ? e.message : String(e)
  const m = /^VAULT_ERR:([a-z-]+):?(.*)$/.exec(msg)
  if (m) {
    const code = m[1] as VaultErrorCode
    const detailMatch = /retries=(\d+)/.exec(m[2])
    return new VaultError(code, m[2] || undefined, detailMatch ? Number(detailMatch[1]) : undefined)
  }
  return new VaultError('driver-unavailable', msg)
}
