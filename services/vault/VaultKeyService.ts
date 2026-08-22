/**
 * VaultKeyService — enrollment, recovery, and teardown of the vault key.
 *
 * The vault key V is derived from the SAME mnemonic as the main wallet,
 * domain-separated by a non-empty vault passphrase (BIP39 toSeed). The user
 * therefore backs up ONE phrase, not two. See vaultDerivation.ts.
 *
 * The YubiKey is now an UNWRAP ORACLE, not a signing device: its PIV slot
 * 0x82 holds a P-256 key used only for on-token ECDH (see sealing.ts).
 * Enrollment's job is to derive the 64-byte vault seed, seal it to that
 * card's public key, and store the result — a SealedBlob plus a bare
 * `nextKeyIndex` counter (vaultStore's v4 meta). Nothing about the vault is
 * ever public at rest: there is no xpub, no r1PublicKey, nothing that lets
 * anyone reach a vault address without either the physical card or the
 * mnemonic + passphrase.
 *
 * Because deposit addresses are BIP32 children of the PRIVATE vault HD node
 * — there is no public xpub to derive them from anymore — a tap is now
 * needed to hand out a fresh deposit address too. Deposits and withdrawals
 * both go through the same unseal; neither is free of the YubiKey. (An
 * earlier design cached 64 key hashes ahead of time so deposits never
 * touched the card; that cache and its refill ceremony are gone along with
 * the xpub that made it possible.)
 *
 * Recovery paths, and there are exactly two:
 *   1. YubiKey unseal (the ceremony's on-token ECDH) — recovers the seed
 *      directly, nothing to type
 *   2. main mnemonic + passphrase  — deriveVaultSeed/deriveVaultHD, offline
 * There is no third path.
 *
 * SECURITY: never log V, the seed, the mnemonic, or the passphrase.
 */
import { HD } from '@bsv/sdk'
import { getVaultDriver } from './driver'
import { withKeySession } from './session'
import { vaultStore, VaultMetaV4 } from './vaultStore'
import { VaultError, SealedBlob } from './types'
import { deriveVaultSeed, deriveVaultHD, randomDepositStartIndex } from './vaultDerivation'
import { checkVaultPassphrase } from './vaultPassphrase'
import { sealVaultKey } from './sealing'

/** An enrollment that has touched the key but not yet disk. */
export interface PendingEnrollment {
  meta: VaultMetaV4
  seal: SealedBlob
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
  /**
   * Enroll against the key ALREADY in the PIV slot instead of refusing it.
   *
   * This is how one YubiKey serves the same vault on several devices. The slot
   * key is the ECDH unwrap oracle (see this file's header), i.e. the wrap
   * TARGET a seal is built against — so adopting it seals THIS device's own
   * copy of the vault seed to the card the user already carries, and the one
   * physical tap then opens either device's blob.
   *
   * Generating instead is the destructive move: it would overwrite the slot's
   * private key and strand the FIRST device's seal, which was wrapped to the
   * key being replaced — that device would be left with a blob no tap can
   * open, recoverable only via mnemonic + passphrase. Adoption generates
   * nothing.
   *
   * The seed is re-derived here, never copied between devices, so both reach
   * the SAME vault key the same two ways: the physical card (its ECDH unwraps
   * whichever seal that device wrote) or the mnemonic + passphrase
   * (deriveVaultSeed, offline). Every output the first device created stays
   * spendable.
   *
   * Only ever set from an explicit user choice: 0x82 is a *retired* PIV slot,
   * so the key sitting there may belong to something else entirely (an
   * age-plugin-yubikey identity, say), and adopting it silently would quietly
   * couple that key to the vault. An empty slot with this set generates
   * normally — the flag permits adoption, it does not require it.
   */
  adoptExisting?: boolean
  onPhase: (p: 'connecting' | 'pin-check' | 'generating' | 'adopting' | 'done') => void
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
  const { info, publicKey, adopted } = await withKeySession(
    driver,
    async () => {
      const info = await driver.getKeyInfo()
      // A blocked PIN can't be enrolled — surface it before burning anything.
      if (info.pinRetries === 0) throw new VaultError('pin-locked', 'PIN is blocked')
      // Never silently overwrite an occupied slot: generating into a used PIV
      // slot destroys the existing key, and retired slots 82-95 are what
      // age-plugin-yubikey uses. Refuse and let the user decide — the wizard
      // turns this refusal into the adopt-or-cancel choice that comes back as
      // `adoptExisting`.
      const occupant = await driver.readVaultPublicKey(VAULT_SLOT)
      if (occupant && !args.adoptExisting) {
        throw new VaultError('slot-occupied', `PIV slot ${VAULT_SLOT.toString(16)} already holds a key`)
      }
      if (pinChange) await driver.changePin(pinChange.oldPin, pinChange.newPin)
      const verified = await driver.verifyPin(pin)
      if (!verified.ok) throw new VaultError('pin-invalid', 'PIN not accepted', verified.retriesLeft)
      // Adoption still verifies the PIN above: it proves the holder can
      // actually sign with the key they are about to lock funds to.
      if (occupant) {
        args.onPhase('adopting')
        return { info, publicKey: occupant.publicKey, adopted: true }
      }
      args.onPhase('generating')
      const { publicKey } = await driver.generateVaultKey(VAULT_SLOT)
      return { info, publicKey, adopted: false }
    },
    () => args.onPhase('connecting')
  )

  // The vault seed comes from the user's EXISTING wallet mnemonic plus their
  // passphrase — no second phrase, nothing new to write down. It never leaves
  // this function: only the SEALED blob is persisted. The `finally` below
  // zeroes it on every exit, including a sealVaultKey throw on malformed card
  // key material — the seed must never survive this function on ANY path.
  const seed = deriveVaultSeed(args.mnemonic, args.passphrase)
  let meta: VaultMetaV4
  let seal: SealedBlob
  try {
    try {
      seal = sealVaultKey(seed, publicKey, { slot: VAULT_SLOT, serial: info.serial })
    } catch {
      // sealVaultKey's ECDH throws a raw @noble/curves error (no .code) on a
      // malformed SEC1 point — a card bug or a foreign PIV slot's key.
      // Recode it so callers get a stable, coded failure; never forward the
      // underlying message, which could echo the bad key material back out.
      throw new VaultError('template-invalid', 'YubiKey returned invalid key material')
    }
    // Sealing is done with the seed — zero it now rather than waiting for
    // the outer `finally`, which stays as a backstop for every other exit.
    seed.fill(0)
    meta = {
      v: 4,
      enrolledAt: Date.now(),
      yubiSerial: info.serial,
      nickname: args.nickname,
      slot: VAULT_SLOT,
      // An adopted key is already in use by another device whose deposit
      // counter this one cannot see, so starting at zero would reissue that
      // device's addresses. See randomDepositStartIndex.
      nextKeyIndex: adopted ? randomDepositStartIndex() : 0
    }
  } finally {
    seed.fill(0)
  }

  args.onPhase('done')
  return { pending: { meta, seal } }
}

/** Commit an enrollment produced by enrollVault. Only here does anything reach
 * disk. The seal is written first: if the process dies between the two
 * writes, `isEnrolled()` (which requires BOTH) still reads false either way,
 * so a half-committed enrollment never looks complete. */
export async function finalizeEnrollment(pending: PendingEnrollment): Promise<void> {
  await vaultStore.setSeal(pending.seal)
  await vaultStore.setMeta(pending.meta)
}

/**
 * Recover the vault HD node from the MAIN wallet mnemonic plus the vault
 * passphrase — the second of the two recovery paths (see this file's header).
 *
 * BIP39 passphrases have no checksum, so a mistyped one silently derives a
 * different, valid, EMPTY vault node rather than throwing. There used to be a
 * stored xpub here to catch that early; v4 meta stores no key material at
 * all, so that check now happens where it can actually verify something —
 * the spend path's pkh match (transfers.ts) — rather than here.
 */
export async function recoverVaultHD(mnemonic: string, passphrase: string): Promise<HD> {
  return deriveVaultHD(mnemonic, passphrase) // throws on empty/invalid
}

/** Re-enroll an existing vault to a fresh YubiKey, e.g. after a lost key.
 *
 * The seal always wraps the 64-byte seed, so reseal re-derives the seed from
 * the mnemonic + passphrase itself (rather than taking an already-derived HD
 * node) and seals it fresh to the new card's public key. Preserves
 * nextKeyIndex so deposit indices are never reissued, and zeroizes the seed
 * as soon as sealing succeeds, with `finally` as a backstop for every other
 * exit — exactly like enrollVault.
 *
 * `verifyHD`, if given, gates the whole operation: BIP39 passphrases carry no
 * checksum, so a mistyped one derives a different, valid, EMPTY vault node
 * with no error of its own. Without a check, that typo would overwrite the
 * ONLY seal that opens the real vault with one nobody can ever unwrap back to
 * the real funds — the old physical key is gone (that is the point of
 * resealing) and the new seal is wrong. The check therefore runs as early as
 * the tap flow allows: seed and HD are derived first (no card needed for
 * that), verified BEFORE `driver.getKeyInfo()` — i.e. before the tap begins
 * at all — so a failed verification never burns a PIN attempt, never risks
 * the slot-occupied refusal, and above all never reaches `generateVaultKey`
 * (which would irreversibly overwrite the slot) or the `vaultStore` writes.
 * A caller that omits `verifyHD` keeps today's behavior: it is on the caller
 * to verify the passphrase itself before calling this, whenever the vault
 * may hold funds (the recover UI wires this in a later task).
 *
 * Outputs created under the OLD key stay spendable, and this is the whole
 * point of the K1-only custody model: there is ONE vault key reached two
 * ways, so the replacement card unwraps the SAME seed the old one did and
 * every existing output's child key derives from it exactly as before. No
 * sweep is required after replacing a YubiKey. (The old physical card stops
 * working nonetheless — the ceremony's serial check in
 * armViaReader/openTapSession, ceremony.ts, refuses any card whose serial
 * does not match the newly-stored yubiSerial.)
 *
 * What protects against resealing to a node that is NOT this vault's is
 * `verifyHD` above, plus the per-input pkh comparison in transfers.ts's
 * prepareSpends: each output's locking script is rebuilt from the key
 * actually in hand and compared against the real script out of the listed
 * BEEF, so a wrong key or a mistyped passphrase fails loudly before anything
 * is reserved or signed.
 */
export async function resealToNewKey(
  mnemonic: string,
  passphrase: string,
  nickname: string,
  getPin: () => Promise<string>,
  verifyHD?: (hd: HD) => Promise<boolean>
): Promise<void> {
  const driver = getVaultDriver()
  if (!driver) throw new VaultError('driver-unavailable')

  const seed = deriveVaultSeed(mnemonic, passphrase)
  try {
    // Fail closed BEFORE any card interaction: see this function's doc
    // comment for why this has to be the earliest possible point.
    if (verifyHD && !(await verifyHD(HD.fromSeed(seed)))) {
      throw new VaultError('bad-passphrase', 'Passphrase does not match this vault')
    }

    const info = await driver.getKeyInfo()
    if (info.pinRetries === 0) throw new VaultError('pin-locked', 'PIN is blocked')
    if (await driver.readVaultPublicKey(VAULT_SLOT)) {
      throw new VaultError('slot-occupied', `PIV slot ${VAULT_SLOT.toString(16)} already holds a key`)
    }
    const pin = await getPin()
    const verified = await driver.verifyPin(pin)
    if (!verified.ok) throw new VaultError('pin-invalid', 'PIN not accepted', verified.retriesLeft)
    const { publicKey } = await driver.generateVaultKey(VAULT_SLOT)

    let seal: SealedBlob
    try {
      seal = sealVaultKey(seed, publicKey, { slot: VAULT_SLOT, serial: info.serial })
    } catch {
      // See enrollVault's identical wrap: never forward the raw error text.
      throw new VaultError('template-invalid', 'YubiKey returned invalid key material')
    }
    // Sealing is done with the seed — zero it now; `finally` is a backstop.
    seed.fill(0)

    // Preserve nextKeyIndex across the re-enrollment so deposit indices are
    // never reissued to a second address.
    const prev = await vaultStore.getMeta()
    const meta: VaultMetaV4 = {
      v: 4,
      enrolledAt: Date.now(),
      yubiSerial: info.serial,
      nickname,
      slot: VAULT_SLOT,
      nextKeyIndex: prev?.nextKeyIndex ?? 0
    }
    await vaultStore.setSeal(seal)
    await vaultStore.setMeta(meta)
  } finally {
    seed.fill(0)
  }
}

/** Remove all vault state. Callers must sweep funds to the default basket
 * BEFORE calling this — see transfers.sweepVaultWithHD. */
export async function disableVault(): Promise<void> {
  await vaultStore.clear()
}
