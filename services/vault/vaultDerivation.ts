/**
 * Vault key derivation — pure functions, no I/O, no logging.
 *
 * V comes from the SAME mnemonic as the main wallet, domain-separated by a
 * non-empty BIP39 passphrase, and deposit addresses are plain BIP32 children:
 *
 *   main wallet    : HD.fromSeed(Mnemonic.toSeed(''))
 *   vault HD node  : HD.fromSeed(Mnemonic.toSeed(passphrase))
 *   deposit addr n : vaultHD.deriveChild(n)
 *
 * This replaces two earlier designs at once:
 *   - the second random 24-word mnemonic (the user now backs up ONE phrase)
 *   - the precomputed queue of 64 deposit key hashes in vault meta
 *
 * There is no xpub anywhere in this design, and nothing about the vault is
 * ever public at rest: the vault stores a YubiKey-sealed seed and a bare
 * `nextKeyIndex` counter, nothing else. Deposit address n derives from the
 * private HD node, which exists only transiently, after one of the two
 * recovery routes below reaches it.
 *
 * Recovery paths, and there are exactly two:
 *   1. YubiKey-unseal of the sealed seed  — the YubiKey unwraps the seed,
 *      which reconstructs this same HD node; nothing to type.
 *   2. main mnemonic + passphrase          — via this file; the same
 *      mnemonic and passphrase reconstruct the same HD node offline.
 * Both routes reach the identical HD node. There is no third path. Nobody
 * can reset it. Deposit address n derives on demand from that node, once
 * per unseal, however many indices are needed — unlike the old 64-key
 * queue, which failed closed until a privileged ceremony refilled it.
 *
 * SECURITY: never log the seed, the HD node, the mnemonic, or the passphrase.
 */
import { PrivateKey, HD, Mnemonic, Hash } from '@bsv/sdk'
import { normalizeVaultPassphrase } from './vaultPassphrase'
import { randomBytes } from './random'
import { VaultError } from './types'

/** BIP32 hardened-index boundary. Deposit indices stay below this so the
 * derivation path is uniform and predictable across every call site. */
const HARDENED = 0x80000000

function assertNonHardened(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= HARDENED) {
    throw new VaultError(
      'bad-derivation-index',
      `Deposit index must be a non-hardened BIP32 index (0..${HARDENED - 1})`
    )
  }
}

/**
 * The vault's 64-byte BIP39 seed.
 *
 * @throws VaultError if the passphrase is empty — an empty passphrase would
 * make the vault seed identical to the main wallet's, letting the hot wallet
 * spend the vault.
 */
export function deriveVaultSeed(mnemonic: string, passphrase: string): number[] {
  const pass = normalizeVaultPassphrase(passphrase)
  if (pass.length === 0) {
    throw new VaultError('bad-passphrase', 'A vault passphrase is required and must not be empty')
  }
  const phrase = mnemonic.trim().replace(/\s+/g, ' ')
  if (!Mnemonic.isValid(phrase)) {
    throw new VaultError('bad-mnemonic', 'Invalid recovery phrase')
  }
  return Mnemonic.fromString(phrase).toSeed(pass)
}

/**
 * Prefix marking a keyID as a BIP32 child index.
 *
 * Legacy v1 outputs carry BRC-42 key ids of the form 'vault/<n>'. The two must
 * stay distinguishable: a signer that mistook one for the other would sign
 * with the wrong key and produce an invalid spend.
 */
export const BIP32_KEYID_PREFIX = 'bip32/'

export const bip32KeyID = (index: number): string => `${BIP32_KEYID_PREFIX}${index}`

/** Index for a BIP32 keyID, or null if this is not one (e.g. a v1 keyID). */
export function indexFromKeyID(keyID: string): number | null {
  if (!keyID.startsWith(BIP32_KEYID_PREFIX)) return null
  const raw = keyID.slice(BIP32_KEYID_PREFIX.length)
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n < HARDENED ? n : null
}

/** Floor for an adopted vault's first deposit index — above any counter a
 * device that started at zero could plausibly have reached. */
const ADOPT_INDEX_MIN = 1 << 20
/** Width of the random span above that floor. Keeps every index well below the
 * hardened boundary, so a lifetime of increments can never reach it. */
const ADOPT_INDEX_SPAN = 1 << 28

/**
 * A random, non-hardened starting deposit index.
 *
 * Used when a device adopts a YubiKey that is already enrolled elsewhere: both
 * devices reach the SAME HD node (via the same mnemonic+passphrase, or the
 * same unsealed seed), and a device-local counter is the only thing choosing
 * indices, so two devices starting at zero would hand out the same deposit
 * addresses. Reusing an address does not risk funds — it links
 * two deposits and confuses the history — and coordinating counters across
 * devices would need a channel the vault deliberately does not have. A random
 * start in a 2^28-wide span makes a collision negligible instead.
 */
export function randomDepositStartIndex(): number {
  const b = randomBytes(4)
  const r = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0
  return ADOPT_INDEX_MIN + (r % ADOPT_INDEX_SPAN)
}

/** The vault's private HD node. */
export function deriveVaultHD(mnemonic: string, passphrase: string): HD {
  return HD.fromSeed(deriveVaultSeed(mnemonic, passphrase))
}

/** Private key for deposit index n. Requires the private node. */
export function depositPrivKey(hd: HD, index: number): PrivateKey {
  assertNonHardened(index)
  return hd.deriveChild(index).privKey
}

/**
 * Deposit address hash160 for index n. Requires the private node — there is
 * no xpub to derive this from without it.
 */
export function depositPubKeyHash(hd: HD, index: number): number[] {
  assertNonHardened(index)
  return Hash.hash160(hd.deriveChild(index).pubKey.encode(true) as number[])
}
