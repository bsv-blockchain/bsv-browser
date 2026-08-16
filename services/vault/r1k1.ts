/**
 * The R1-K1 vault script: byte-length constants, the customInstructions codec,
 * and locking-script construction.
 *
 * Every R1-K1 detail lives here so no other module needs to know the template's
 * shape. The two unlocking lengths are CONSTANTS, not estimates: every field of
 * the sighash preimage that varies with transaction shape (hashPrevouts,
 * hashSequence, hashOutputs) is hashed to a fixed 32 bytes, so the preimage
 * length never moves.
 *
 *   preimage  = 4 + 32 + 32 + 36 + (5 + 959572) + 8 + 4 + 32 + 4 + 4 = 959733
 *   R1 unlock = push(64) + push(33) + push(32) + push(959733) + 1     = 959871
 *
 * SECURITY: nothing secret passes through this module — only public keys,
 * hashes, salts and script bytes.
 */
import { Hash, LockingScript, Utils } from '@bsv/sdk'
import { R1K1Wallet } from '@bsv/templates'
import { VaultError } from './types'

/** Baked locking script: the 959,592-byte template with two 1-byte constructor
 * slots expanded into two 21-byte pushes. */
export const R1K1_LOCK_LEN = 959_632

/** R1 unlocking script, exact. The preimage is pushed whole, which is why the
 * R1 branch pays the script size a second time on the spend. */
export const R1K1_R1_UNLOCK_LEN = 959_871

/** K1 unlocking script. The template's own conservative estimate; a real one
 * measures 107, because DER signatures vary between 70 and 72 bytes. */
export const R1K1_K1_UNLOCK_LEN = 109

/** Byte offsets of the two 20-byte commitments inside the baked script. */
const R1_COMMITMENT_OFFSET = 17
const K1_COMMITMENT_OFFSET = 959_609

/**
 * What a vault output records about itself.
 *
 * `r1PublicKey` is stored per output rather than read from vault meta so an
 * output stays spendable after a re-enrollment to a different YubiKey, and so
 * the template's commitment check has everything it needs locally.
 *
 * `v` is the customInstructions format version and is INDEPENDENT of the vault
 * meta version — meta v1 and v2 both wrote customInstructions v1.
 */
export interface VaultInstructions {
  v: 2
  type: 'R1K1'
  /** BIP32 child index for the K1 leg, e.g. 'bip32/7'. */
  keyID: string
  /** 32 bytes, hex. Unique per output — one YubiKey key serves the whole vault,
   * so without this every output would carry an identical R1 commitment. */
  salt: string
  /** 33-byte compressed P-256 point, hex. */
  r1PublicKey: string
  /** PIV slot holding the R1 key. */
  slot: number
}

export function encodeVaultInstructions(i: VaultInstructions): string {
  return JSON.stringify(i)
}

/**
 * Parse an output's customInstructions, or null if it is not a well-formed
 * R1-K1 v2 record.
 *
 * Fails closed on anything unrecognised: a malformed record means an output we
 * cannot construct a valid spend for, and silently dropping it from the
 * spendable set beats building a transaction that cannot be signed.
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
  if (p.v !== 2 || p.type !== 'R1K1') return null
  if (typeof p.keyID !== 'string' || !p.keyID.startsWith('bip32/')) return null
  if (typeof p.salt !== 'string' || !/^[0-9a-f]{64}$/i.test(p.salt)) return null
  if (typeof p.r1PublicKey !== 'string' || !/^0[23][0-9a-f]{64}$/i.test(p.r1PublicKey)) return null
  if (typeof p.slot !== 'number' || !Number.isInteger(p.slot)) return null
  return { v: 2, type: 'R1K1', keyID: p.keyID, salt: p.salt, r1PublicKey: p.r1PublicKey, slot: p.slot }
}

/**
 * Compress a P-256 public key to 33 bytes.
 *
 * `generateVaultKey` returns a 65-byte uncompressed SEC1 point; the template
 * requires compressed. Already-compressed input passes through so callers need
 * not track which form they hold.
 */
export function compressP256(sec1Hex: string): string {
  const bytes = Utils.toArray(sec1Hex, 'hex')
  if (bytes.length === 33 && (bytes[0] === 0x02 || bytes[0] === 0x03)) {
    return Utils.toHex(bytes)
  }
  if (bytes.length !== 65 || bytes[0] !== 0x04) {
    throw new VaultError(
      'template-invalid',
      `Expected a 65-byte uncompressed SEC1 P-256 point, got ${bytes.length} bytes`
    )
  }
  const yIsOdd = (bytes[64] & 1) === 1
  return Utils.toHex([yIsOdd ? 0x03 : 0x02, ...bytes.slice(1, 33)])
}

/** The R1 commitment: hash160(compressedPubKey ‖ salt). */
export function r1Commitment(r1PublicKey: string, salt: string): number[] {
  return Hash.hash160([...Utils.toArray(r1PublicKey, 'hex'), ...Utils.toArray(salt, 'hex')])
}

/** Build a vault locking script. Deposits call this; spends call it again to
 * reconstruct the prevout script locally instead of fetching the source
 * transaction — which is what keeps megabytes of BEEF out of memory.
 *
 * `r1PublicKey` MUST already be compressed (33 bytes, 0x02/0x03 prefix). An
 * uncompressed 65-byte point would still hash160 to *something*, silently
 * baking a commitment nobody holds the matching salted preimage for — a
 * funds-lock bug with no error. Callers that may hold an uncompressed point
 * should run it through `compressP256` first. */
export async function buildVaultLockingScript(a: {
  r1PublicKey: string
  salt: string
  k1PublicKeyHash: number[]
}): Promise<LockingScript> {
  const r1Bytes = Utils.toArray(a.r1PublicKey, 'hex')
  if (r1Bytes.length !== 33 || (r1Bytes[0] !== 0x02 && r1Bytes[0] !== 0x03)) {
    throw new VaultError(
      'template-invalid',
      `r1PublicKey must be a 33-byte compressed P-256 point, got ${r1Bytes.length} bytes`
    )
  }
  return new R1K1Wallet().lock(r1Commitment(a.r1PublicKey, a.salt), a.k1PublicKeyHash)
}

/** Commitment offsets, exported for tests that assert script structure. */
export const R1K1_OFFSETS = {
  r1Commitment: R1_COMMITMENT_OFFSET,
  k1Commitment: K1_COMMITMENT_OFFSET
} as const
