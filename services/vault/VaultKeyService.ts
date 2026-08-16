/**
 * VaultKeyService — enrollment, recovery, and teardown of the vault key.
 *
 * The vault key V is derived from the SAME mnemonic as the main wallet,
 * domain-separated by a non-empty vault passphrase (BIP39 toSeed). The user
 * therefore backs up ONE phrase, not two. See vaultDerivation.ts.
 *
 * The YubiKey is a SIGNING device, not a key-wrapping one: its PIV slot 0x82
 * holds a P-256 key that never leaves the card. Enrollment's job is just to
 * generate that key, record its compressed public key, and store v3 meta —
 * there is nothing to seal.
 *
 * Deposit addresses are BIP32 children of the stored xpub, so deposits never
 * need the YubiKey and never run out. (An earlier design cached 64 key
 * hashes and needed a privileged ceremony to refill them.)
 *
 * Recovery paths, and there are exactly two:
 *   1. YubiKey + PIN               — signs directly, nothing to unseal
 *   2. main mnemonic + passphrase  — deriveVaultHD
 * There is no third path.
 *
 * SECURITY: never log V, the seed, the mnemonic, or the passphrase.
 */
import { HD } from '@bsv/sdk'
import { getVaultDriver } from './driver'
import { withKeySession } from './session'
import { vaultStore, VaultMetaV3 } from './vaultStore'
import { VaultError } from './types'
import { deriveVaultSeed, deriveVaultHD, vaultXpub } from './vaultDerivation'
import { checkVaultPassphrase } from './vaultPassphrase'
import { compressP256 } from './r1k1'

/** An enrollment that has touched the key but not yet disk. */
export interface PendingEnrollment {
  meta: VaultMetaV3
}

export const VAULT_SLOT = 0x82
const DEFAULT_PIV_PIN = '123456'

export async function enrollVault(args: {
  nickname: string
  /** The MAIN wallet mnemonic. Wallets restored from backup shares do not have
   * one and cannot enroll — callers must gate on this before calling. */
  mnemonic: string
  /** Non-empty vault passphrase. Must pass checkVaultPassphrase. */
  passphrase: string
  onPhase: (p: 'connecting' | 'pin-check' | 'generating' | 'done') => void
  getPin: () => Promise<string>
  /** Called when the key still has the factory-default PIV PIN; must return a
   * new PIN the user chose. If omitted, enrollment proceeds on the default PIN
   * (dev/test convenience). */
  requestPinChange?: (retries: number) => Promise<{ oldPin: string; newPin: string }>
}): Promise<{ pending: PendingEnrollment }> {
  const driver = getVaultDriver()
  if (!driver) throw new VaultError('driver-unavailable')

  // Validate the passphrase BEFORE any key contact, so a rejected passphrase
  // never costs the user an NFC tap. An empty one would make V identical to
  // the main wallet's master key.
  const policy = checkVaultPassphrase(args.passphrase)
  if (!policy.ok) throw new VaultError('bad-passphrase', policy.reason)

  // ── ALL user input up front, BEFORE any key contact ──
  // On NFC the scan sheet is a modal that covers the app, so every prompt (the
  // PIN, and a replacement PIN if the key is on the factory default) must be
  // gathered before the tap; the whole enrollment then runs in one tap.
  args.onPhase('pin-check')
  const pin0 = await args.getPin()
  let pin = pin0
  let pinChange: { oldPin: string; newPin: string } | null = null
  if (pin0 === DEFAULT_PIV_PIN && args.requestPinChange) {
    // Factory-default detection is exactly "the PIN the user entered is the
    // default" — no side probe against '123456' (fix #5).
    pinChange = await args.requestPinChange(3)
    pin = pinChange.newPin
  }

  // ── Token phase: one session / one NFC tap ──
  const { info, publicKey } = await withKeySession(
    driver,
    async () => {
      const info = await driver.getKeyInfo()
      // A blocked PIN can't be enrolled — surface it before burning anything.
      if (info.pinRetries === 0) throw new VaultError('pin-locked', 'PIN is blocked')
      // Never silently overwrite an occupied slot: generating into a used PIV
      // slot destroys the existing key, and retired slots 82-95 are what
      // age-plugin-yubikey uses. Refuse and let the user decide.
      if (await driver.readVaultPublicKey(VAULT_SLOT)) {
        throw new VaultError('slot-occupied', `PIV slot ${VAULT_SLOT.toString(16)} already holds a key`)
      }
      if (pinChange) await driver.changePin(pinChange.oldPin, pinChange.newPin)
      const verified = await driver.verifyPin(pin)
      if (!verified.ok) throw new VaultError('pin-invalid', 'PIN not accepted', verified.retriesLeft)
      args.onPhase('generating')
      const { publicKey } = await driver.generateVaultKey(VAULT_SLOT)
      return { info, publicKey }
    },
    () => args.onPhase('connecting')
  )

  // The vault seed comes from the user's EXISTING wallet mnemonic plus their
  // passphrase — no second phrase, nothing new to write down. It never leaves
  // this function: only the PUBLIC node is persisted. The `finally` below
  // zeroes it on every exit, including a compressP256 throw on malformed card
  // key material — the seed must never survive this function on ANY path.
  const seed = deriveVaultSeed(args.mnemonic, args.passphrase)
  let meta: VaultMetaV3
  try {
    const hd = HD.fromSeed(seed)
    meta = {
      v: 3,
      enrolledAt: Date.now(),
      yubiSerial: info.serial,
      nickname: args.nickname,
      slot: VAULT_SLOT,
      nextKeyIndex: 0,
      xpub: vaultXpub(hd),
      // The driver returns a 65-byte uncompressed SEC1 point; the template
      // needs 33-byte compressed.
      r1PublicKey: compressP256(publicKey)
    }
  } finally {
    seed.fill(0)
  }

  args.onPhase('done')
  return { pending: { meta } }
}

/** Commit an enrollment produced by enrollVault. Only here does anything reach
 * disk. */
export async function finalizeEnrollment(pending: PendingEnrollment): Promise<void> {
  await vaultStore.setMeta(pending.meta)
}

/**
 * Recover a v3 vault from the MAIN wallet mnemonic plus the vault passphrase.
 *
 * `expectedXpub` (from vault meta, when present) catches a mistyped
 * passphrase: BIP39 passphrases have no checksum, so without this check a typo
 * silently derives a different, valid, EMPTY vault and the user concludes
 * their funds are gone.
 */
export async function recoverVaultHD(
  mnemonic: string,
  passphrase: string,
  expectedXpub?: string
): Promise<HD> {
  const hd = deriveVaultHD(mnemonic, passphrase) // throws on empty/invalid
  if (expectedXpub && vaultXpub(hd) !== expectedXpub) {
    throw new VaultError('bad-passphrase', 'That passphrase does not match this vault')
  }
  return hd
}

/** Re-enroll an existing vault to a fresh YubiKey, e.g. after a lost key.
 *
 * Preserves nextKeyIndex so deposit indices are never reissued. Outputs created
 * under the OLD key stay spendable via the r1PublicKey recorded in their own
 * customInstructions — which is exactly why that field is stored per output
 * rather than read from meta.
 */
export async function resealHDToNewKey(
  hd: HD,
  nickname: string,
  getPin: () => Promise<string>
): Promise<void> {
  const driver = getVaultDriver()
  if (!driver) throw new VaultError('driver-unavailable')
  const info = await driver.getKeyInfo()
  if (info.pinRetries === 0) throw new VaultError('pin-locked', 'PIN is blocked')
  if (await driver.readVaultPublicKey(VAULT_SLOT)) {
    throw new VaultError('slot-occupied', `PIV slot ${VAULT_SLOT.toString(16)} already holds a key`)
  }
  const pin = await getPin()
  const verified = await driver.verifyPin(pin)
  if (!verified.ok) throw new VaultError('pin-invalid', 'PIN not accepted', verified.retriesLeft)
  const { publicKey } = await driver.generateVaultKey(VAULT_SLOT)

  // Preserve nextKeyIndex across the re-enrollment so deposit indices are
  // never reissued to a second address.
  const prev = await vaultStore.getMeta()
  await vaultStore.setMeta({
    v: 3,
    enrolledAt: Date.now(),
    yubiSerial: info.serial,
    nickname,
    slot: VAULT_SLOT,
    nextKeyIndex: prev?.nextKeyIndex ?? 0,
    xpub: vaultXpub(hd),
    r1PublicKey: compressP256(publicKey)
  })
}

/** Remove all vault state. Callers must sweep funds to the default basket
 * BEFORE calling this — see transfers.sweepVaultWithKey. */
export async function disableVault(): Promise<void> {
  await vaultStore.clear()
}
