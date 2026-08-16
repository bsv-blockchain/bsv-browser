/**
 * Wallet-secret domain types — shared by the envelope crypto, the KEK holder,
 * the store and the migration. No React, no I/O.
 *
 * Threat model in one line: the mnemonic must be undecryptable without a live
 * OS biometric ceremony, so that patching JavaScript buys an attacker nothing.
 */

/** The secrets that are wrapped under the KEK. `password` is deliberately
 * absent — it had no consumers and is swept, not migrated. */
export type SecretName = 'mnemonic' | 'recoveredKey'

export const SECRET_NAMES: SecretName[] = ['mnemonic', 'recoveredKey']

/**
 * A wrapped secret. Mirrors the vault's SealedBlob conventions
 * (services/vault/types.ts): version-as-literal, all binary as hex.
 *
 * The blob is stored unauthenticated and is inert on its own — opening it
 * requires the KEK, which only the Secure Enclave / Keystore can release.
 */
export interface EnvelopeBlob {
  v: 1
  /** hex(8B) — which KEK sealed this, so a stale blob fails loudly. */
  kekId: string
  /** hex(32B) — per-blob HKDF salt. */
  salt: string
  /** AES-256-GCM ciphertext (SymmetricKey wire format: iv||ct||tag), hex. */
  c: string
}

/**
 * How the KEK is protected on this install.
 * - `biometric`  — SecureStore item with requireAuthentication: OS-enforced.
 * - `degraded`   — production device with no strong biometrics; keystore-only.
 * - `dev-plain`  — development builds without biometrics. Never valid in prod.
 */
export type KekPolicy = 'biometric' | 'degraded' | 'dev-plain'

/**
 * Non-secret marker recording that an envelope exists.
 *
 * Its only jobs are to distinguish "key destroyed by the OS" from "no wallet
 * here" and to select the KEK key name. It is NOT a security control: no
 * sentinel value can cause an authenticated item to be read without auth.
 *
 * Stored in SecureStore (unauthenticated), NOT AsyncStorage, so its lifetime
 * matches the blobs' on both platforms — an iOS reinstall keeps keychain items
 * but wipes AsyncStorage, which would otherwise desynchronise the two.
 */
export interface KekSentinel {
  v: 1
  kekId: string
  policy: KekPolicy
  provisionedAt: number
  names: SecretName[]
}

export type UnavailableReason = 'no-hardware' | 'not-enrolled' | 'lockout' | 'not-foregrounded'

export type UnlockState =
  /** No sentinel: nothing has ever been stored on this device. */
  | { status: 'absent' }
  /** Sentinel present, KEK not yet released this process. */
  | { status: 'locked' }
  | { status: 'unlocking' }
  | { status: 'unlocked'; kekId: string; policy: KekPolicy }
  /** User dismissed the sheet. Retryable, nothing was touched. */
  | { status: 'cancelled' }
  | { status: 'unavailable'; reason: UnavailableReason }
  /** Sentinel present but the KEK is gone — the OS destroyed it. Unrecoverable
   * on-device; the user must restore from their recovery phrase. */
  | { status: 'lost' }

export type EnvelopeErrorCode = 'bad-version' | 'kek-mismatch' | 'corrupt'

export class EnvelopeError extends Error {
  constructor(
    public readonly code: EnvelopeErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'EnvelopeError'
  }
}
