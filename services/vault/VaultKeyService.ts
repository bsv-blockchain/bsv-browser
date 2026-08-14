/**
 * VaultKeyService — enrollment, recovery, and teardown of the vault key.
 *
 * The vault key V is derived from the SAME mnemonic as the main wallet,
 * domain-separated by a non-empty vault passphrase (BIP39 toSeed). The user
 * therefore backs up ONE phrase, not two. See vaultDerivation.ts.
 *
 * What gets sealed to the YubiKey is the 64-byte BIP39 SEED, not a bare
 * private key: without the chain code, device+PIN recovery could not
 * deriveChild(n) and every deposit address would be unreachable.
 *
 * Deposit addresses are BIP32 children of the stored xpub, so deposits never
 * need the YubiKey and never run out. (The previous design cached 64 key
 * hashes and needed a privileged ceremony to refill them.)
 *
 * Recovery paths, and there are exactly two:
 *   1. YubiKey + PIN               — the sealed seed
 *   2. main mnemonic + passphrase  — deriveVaultHD
 * There is no third path.
 *
 * SECURITY: never log V, the seed, the mnemonic, or the passphrase.
 */
import { PrivateKey, KeyDeriver, HD, Mnemonic, WalletProtocol } from '@bsv/sdk'
import { getVaultDriver } from './driver'
import { withKeySession } from './session'
import { vaultStore, VaultMeta, VaultMetaV2 } from './vaultStore'
import { sealVaultKey } from './sealing'
import { VaultError, SealedBlob } from './types'
import { deriveVaultSeed, deriveVaultHD, vaultXpub } from './vaultDerivation'
import { checkVaultPassphrase } from './vaultPassphrase'

export interface PendingEnrollment {
  seal: SealedBlob
  meta: VaultMeta
}

export const VAULT_SLOT = 0x82
export const VAULT_PROTOCOL: WalletProtocol = [2, 'vault']
const DEPOSIT_QUEUE_SIZE = 64
const DEFAULT_PIV_PIN = '123456'

/** V = BIP32 master private key of the backup mnemonic's seed. */
function deriveVaultKey(mnemonic: string): number[] {
  const seed = Mnemonic.fromString(mnemonic).toSeed('')
  return HD.fromSeed(seed).privKey.toArray()
}

/** Derive `count` deposit keys (pubkey hash160) from V, starting at `from`. */
function deriveDepositKeys(v: number[], from: number, count: number): { keyID: string; pkh: string }[] {
  const kd = new KeyDeriver(new PrivateKey(v))
  const out: { keyID: string; pkh: string }[] = []
  for (let i = from; i < from + count; i++) {
    const keyID = `vault/${i}`
    const pub = kd.derivePublicKey(VAULT_PROTOCOL, keyID, 'self', true)
    out.push({ keyID, pkh: pub.toHash('hex') as string })
  }
  return out
}

export async function enrollVault(args: {
  nickname: string
  /** The MAIN wallet mnemonic. Wallets restored from backup shares do not have
   * one and cannot enroll — callers must gate on this before calling. */
  mnemonic: string
  /** Non-empty vault passphrase. Must pass checkVaultPassphrase. */
  passphrase: string
  onPhase: (p: 'connecting' | 'pin-check' | 'generating' | 'sealing' | 'done') => void
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
  // passphrase — no second phrase is generated, and nothing new to write down.
  const seed = deriveVaultSeed(args.mnemonic, args.passphrase)
  const hd = HD.fromSeed(seed)

  // Seal the serialised HD NODE, not a bare private key: the chain code must
  // survive, or device+PIN recovery could not deriveChild(n) and every deposit
  // address would be unreachable.
  args.onPhase('sealing')
  const seal = sealVaultKey(hd.toBinary(), publicKey, { slot: VAULT_SLOT, serial: info.serial })
  const meta: VaultMetaV2 = {
    v: 2,
    enrolledAt: Date.now(),
    yubiSerial: info.serial,
    nickname: args.nickname,
    slot: VAULT_SLOT,
    nextKeyIndex: 0,
    xpub: vaultXpub(hd)
  }

  // Drop the seed.
  seed.fill(0)
  args.onPhase('done')
  return { pending: { seal, meta } }
}

/** Commit an enrollment produced by enrollVault, after the user has confirmed
 * the backup phrase. Only here does anything reach disk (fix #4). */
export async function finalizeEnrollment(pending: { seal: SealedBlob; meta: VaultMeta }): Promise<void> {
  await vaultStore.setSeal(pending.seal)
  await vaultStore.setMeta(pending.meta)
}

/**
 * Recover a LEGACY v1 vault from its separate random backup phrase.
 *
 * Kept so existing enrollments are never stranded. v1 vaults were sealed from
 * a second 24-word mnemonic with an empty passphrase.
 */
export async function recoverVaultKeyV1(mnemonic: string): Promise<PrivateKey> {
  const trimmed = mnemonic.trim().replace(/\s+/g, ' ')
  if (!Mnemonic.isValid(trimmed)) throw new VaultError('seal-corrupt', 'Invalid recovery phrase')
  return new PrivateKey(deriveVaultKey(trimmed))
}

/**
 * Recover a v2 vault from the MAIN wallet mnemonic plus the vault passphrase.
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

/** @deprecated v1 name kept for callers not yet migrated. */
export const recoverVaultKey = recoverVaultKeyV1

/** Re-seal an existing vault node to a freshly enrolled YubiKey, e.g. after a
 * lost or bricked key. Takes the HD node so the chain code survives. */
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

  // Preserve nextKeyIndex across the re-seal so deposit indices are never
  // reissued to a second address.
  const prev = await vaultStore.getMeta()
  await vaultStore.setSeal(
    sealVaultKey(hd.toBinary(), publicKey, { slot: VAULT_SLOT, serial: info.serial })
  )
  await vaultStore.setMeta({
    v: 2,
    enrolledAt: Date.now(),
    yubiSerial: info.serial,
    nickname,
    slot: VAULT_SLOT,
    nextKeyIndex: prev?.nextKeyIndex ?? 0,
    xpub: vaultXpub(hd)
  })
}

/** @deprecated v1 path. Re-seal a bare V to a freshly enrolled YubiKey. */
export async function resealToNewKey(
  v: PrivateKey,
  nickname: string,
  getPin: () => Promise<string>
): Promise<void> {
  const driver = getVaultDriver()
  if (!driver) throw new VaultError('driver-unavailable')
  const info = await driver.getKeyInfo()
  if (info.pinRetries === 0) throw new VaultError('pin-locked', 'PIN is blocked')
  // Same non-destructive rule as enrollVault: never overwrite an occupied slot.
  if (await driver.readVaultPublicKey(VAULT_SLOT)) {
    throw new VaultError('slot-occupied', `PIV slot ${VAULT_SLOT.toString(16)} already holds a key`)
  }
  const pin = await getPin()
  const verified = await driver.verifyPin(pin)
  if (!verified.ok) throw new VaultError('pin-invalid', 'PIN not accepted', verified.retriesLeft)
  const { publicKey } = await driver.generateVaultKey(VAULT_SLOT)
  const bytes = v.toArray()
  const seal = sealVaultKey(bytes, publicKey, { slot: VAULT_SLOT, serial: info.serial })
  await vaultStore.setSeal(seal)
  const depositKeys = deriveDepositKeys(bytes, 0, DEPOSIT_QUEUE_SIZE)
  await vaultStore.setMeta({
    v: 1,
    enrolledAt: Date.now(),
    yubiSerial: info.serial,
    nickname,
    slot: VAULT_SLOT,
    nextKeyIndex: DEPOSIT_QUEUE_SIZE,
    depositKeys
  })
  bytes.fill(0)
}

/** Remove all vault state. Callers must sweep funds to the default basket
 * BEFORE calling this — see transfers.sweepVaultWithKey. */
export async function disableVault(): Promise<void> {
  await vaultStore.clear()
}
