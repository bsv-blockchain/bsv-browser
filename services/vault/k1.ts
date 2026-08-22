/**
 * The K1 vault script: byte-length constants, the customInstructions codec,
 * and locking-script construction.
 *
 * Every K1 detail lives here so no other module needs to know the template's
 * shape. A K1 vault output is a plain P2PKH output — no R1/YubiKey leg, no
 * template contract — locked to a BIP32 child key derived per
 * services/vault/vaultDerivation.ts.
 *
 * SECURITY: nothing secret passes through this module — only public keys,
 * hashes, and script bytes.
 */
import { LockingScript, P2PKH } from '@bsv/sdk'

/** Exact: a P2PKH locking script is always
 * OP_DUP OP_HASH160 push(20) OP_EQUALVERIFY OP_CHECKSIG = 1+1+1+20+1+1 = 25 bytes. */
export const K1_LOCK_LEN = 25

/** Conservative estimate, not exact: a real P2PKH unlock measures ~107 bytes
 * (push(≤72-byte DER sig) + push(33-byte compressed pubkey)), matching the
 * proven staging-unlock shape used elsewhere in the vault. DER signatures
 * vary between 70 and 72 bytes, so this pins the ceiling rather than the
 * exact length. */
export const K1_UNLOCK_LEN = 108

/**
 * What a K1 vault output records about itself.
 *
 * `v` is the customInstructions format version and is a hard fork from the
 * old template-based line: v2 records carry a different type discriminator
 * entirely and must never decode as v3 — see decodeVaultInstructions.
 */
export interface VaultInstructions {
  v: 3
  type: 'K1'
  /** BIP32 child key ID, e.g. 'bip32/7'. See vaultDerivation.ts's
   * BIP32_KEYID_PREFIX / bip32KeyID. */
  keyID: string
}

export function encodeVaultInstructions(i: VaultInstructions): string {
  return JSON.stringify(i)
}

/**
 * Parse an output's customInstructions, or null if it is not a well-formed
 * K1 v3 record.
 *
 * Fails closed on anything unrecognised — including old v2 R1-K1 records —
 * because a malformed record means an output we cannot construct a valid
 * spend for, and silently dropping it from the spendable set beats building
 * a transaction that cannot be signed.
 */
export function decodeVaultInstructions(ci?: string): VaultInstructions | null {
  if (!ci) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(ci)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const p = parsed as Partial<VaultInstructions>
  if (p.v !== 3 || p.type !== 'K1') return null
  if (typeof p.keyID !== 'string' || !p.keyID.startsWith('bip32/')) return null
  return { v: 3, type: 'K1', keyID: p.keyID }
}

/** Build a K1 vault locking script: a plain P2PKH lock to the given public
 * key hash. Synchronous — there is no template to await; callers may still
 * `await` this without effect. */
export function buildVaultLockingScript(a: { k1PublicKeyHash: number[] }): LockingScript {
  return new P2PKH().lock(a.k1PublicKeyHash)
}
