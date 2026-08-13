/**
 * VaultKeyService — enrollment, recovery, and teardown of the vault key.
 *
 * The vault key V is the BIP32 master key of a fresh 24-word backup mnemonic,
 * so recovery reuses the same audited PBKDF2 + BIP32 path the wallet uses for
 * its own mnemonic and V is always a valid secp256k1 scalar. V is sealed to
 * the YubiKey's PIV public key at enrollment (software-only — the seal needs
 * no touch), and the 24-word phrase is the independent recovery path required
 * because a bricked PIV applet (PIN/PUK exhaustion) would otherwise strand the
 * funds.
 *
 * Deposit keys are derived from V at enrollment and cached, so deposits never
 * need the YubiKey. V is used only transiently here and dropped when the
 * function returns.
 *
 * SECURITY: never log V, the seed, or the mnemonic.
 */
import { PrivateKey, KeyDeriver, HD, Mnemonic, WalletProtocol } from '@bsv/sdk'
import { getVaultDriver } from './driver'
import { vaultStore, VaultMeta } from './vaultStore'
import { sealVaultKey } from './sealing'
import { VaultError } from './types'

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
  onPhase: (p: 'connecting' | 'pin-check' | 'generating' | 'sealing' | 'done') => void
  getPin: () => Promise<string>
  /** Called when the key still has the factory-default PIV PIN; must return a
   * new PIN the user chose. If omitted, enrollment proceeds on the default PIN
   * (dev/test convenience). */
  requestPinChange?: (retries: number) => Promise<{ oldPin: string; newPin: string }>
}): Promise<{ backupMnemonic: string }> {
  const driver = getVaultDriver()
  if (!driver) throw new VaultError('driver-unavailable')

  args.onPhase('connecting')
  const info = await driver.getKeyInfo()

  // Force a PIN change off the factory default when we can detect it.
  args.onPhase('pin-check')
  let pin = await args.getPin()
  if (args.requestPinChange) {
    const probe = await driver.verifyPin(DEFAULT_PIV_PIN).catch(() => ({ ok: false, retriesLeft: 0 }))
    if (probe.ok) {
      const { oldPin, newPin } = await args.requestPinChange(info.pinRetries)
      await driver.changePin(oldPin, newPin)
      pin = newPin
    }
  }
  // Ensure the PIN is valid before we commit an enrollment around it.
  const verified = await driver.verifyPin(pin)
  if (!verified.ok) throw new VaultError('pin-invalid', 'PIN not accepted', verified.retriesLeft)

  // Generate the on-token P-256 key (touch) and read its public key.
  args.onPhase('generating')
  const { publicKey } = await driver.generateVaultKey(VAULT_SLOT)

  // Fresh vault key + its backup phrase.
  const backupMnemonic = Mnemonic.fromRandom(256).toString()
  const v = deriveVaultKey(backupMnemonic)

  // Seal V to the token (software-only) and persist.
  args.onPhase('sealing')
  const seal = sealVaultKey(v, publicKey, { slot: VAULT_SLOT, serial: info.serial })
  await vaultStore.setSeal(seal)

  const depositKeys = deriveDepositKeys(v, 0, DEPOSIT_QUEUE_SIZE)
  const meta: VaultMeta = {
    v: 1,
    enrolledAt: Date.now(),
    yubiSerial: info.serial,
    nickname: args.nickname,
    slot: VAULT_SLOT,
    nextKeyIndex: DEPOSIT_QUEUE_SIZE,
    depositKeys
  }
  await vaultStore.setMeta(meta)

  // Drop V.
  v.fill(0)
  args.onPhase('done')
  return { backupMnemonic }
}

/** Recover V from the backup phrase. Throws on an invalid phrase. */
export async function recoverVaultKey(mnemonic: string): Promise<PrivateKey> {
  const trimmed = mnemonic.trim().replace(/\s+/g, ' ')
  if (!Mnemonic.isValid(trimmed)) throw new VaultError('seal-corrupt', 'Invalid recovery phrase')
  return new PrivateKey(deriveVaultKey(trimmed))
}

/** Re-seal an existing V to a freshly enrolled YubiKey. */
export async function resealToNewKey(
  v: PrivateKey,
  nickname: string,
  getPin: () => Promise<string>
): Promise<void> {
  const driver = getVaultDriver()
  if (!driver) throw new VaultError('driver-unavailable')
  const info = await driver.getKeyInfo()
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
