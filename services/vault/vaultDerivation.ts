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
 * Persisting the xpub plus a single `nextKeyIndex` counter is strictly better
 * than the queue: address n derives on demand, forever, with no YubiKey. The
 * queue failed closed at 64 addresses and required a privileged ceremony to
 * refill, so deposits could break until the user produced their key.
 *
 * Recovery paths, and there are exactly two:
 *   1. YubiKey + PIN               — signs directly, nothing to unseal
 *   2. main mnemonic + passphrase  — via this file
 * There is no third path. Nobody can reset it.
 *
 * PRIVACY: the stored xpub lets anyone with device access enumerate every
 * vault address. It cannot spend, but it does link them. The previous design
 * leaked 64 addresses the same way; this leaks all of them.
 *
 * SECURITY: never log the seed, the HD node, the mnemonic, or the passphrase.
 */
import { PrivateKey, HD, Mnemonic } from '@bsv/sdk'
import { normalizeVaultPassphrase } from './vaultPassphrase'
import { VaultError } from './types'

/** BIP32 hardened-index boundary. Hardened children cannot be derived from an
 * xpub, so every deposit index must sit below this. */
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

/** The vault's private HD node. */
export function deriveVaultHD(mnemonic: string, passphrase: string): HD {
  return HD.fromSeed(deriveVaultSeed(mnemonic, passphrase))
}

/** Public-only serialisation of the vault node — safe to persist. */
export function vaultXpub(hd: HD): string {
  return hd.toPublic().toString()
}

/** Private key for deposit index n. Requires the private node. */
export function depositPrivKey(hd: HD, index: number): PrivateKey {
  assertNonHardened(index)
  return hd.deriveChild(index).privKey
}

/**
 * Deposit address hash160 for index n, from the xpub alone.
 *
 * This is the call that keeps the YubiKey out of the deposit path.
 */
export function depositPkhFromXpub(xpub: string, index: number): string {
  assertNonHardened(index)
  return HD.fromString(xpub).deriveChild(index).pubKey.toHash('hex') as string
}

/**
 * Check a candidate passphrase offline against the stored xpub.
 *
 * The xpub doubles as the typo verifier: BIP39 passphrases carry no checksum,
 * so without this a typo silently opens a different, valid, EMPTY vault.
 *
 * Never throws — the enrollment and recovery UIs call this while the user is
 * still typing.
 */
export function verifyVaultPassphrase(mnemonic: string, passphrase: string, expectedXpub: string): boolean {
  try {
    return vaultXpub(deriveVaultHD(mnemonic, passphrase)) === expectedXpub
  } catch {
    return false
  }
}
