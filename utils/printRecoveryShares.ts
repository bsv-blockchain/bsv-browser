/**
 * One-tap "print my recovery shares", shared by Settings and vault enrollment.
 *
 * IMPORTANT — what these shares do and do NOT cover:
 *
 * The shares are Shamir 2-of-3 over the wallet's primary key at m/0'/0'. That
 * derivation is HARDENED, so it is one-way: the shares can restore spending
 * authority for the everyday balance, but they can NEVER reconstruct the
 * mnemonic. Since the vault key is derived from the mnemonic plus the vault
 * passphrase, these shares cannot recover the vault.
 *
 * Do not describe them to the user as vault backup. The vault has exactly two
 * recovery paths: hardware key + PIN, or mnemonic + vault passphrase.
 */
import { PrivateKey } from '@bsv/sdk'
import * as Print from 'expo-print'
import { generateBackupShares, generatePrintHTML } from './backupShares'
import { recoverMnemonicWallet } from './mnemonicWallet'

export interface PrintSharesSources {
  /** The wallet mnemonic, when the wallet has one. */
  mnemonic: string | null
  /** WIF of a share-restored wallet, which has no mnemonic. */
  recoveredKeyWif?: string | null
}

/**
 * Print the 2-of-3 recovery shares.
 *
 * @returns true if the print sheet was presented, false if there was no key
 * material to work from. Never throws for the "no material" case — callers
 * surface that as a message rather than an error.
 */
export async function printRecoveryShares(sources: PrintSharesSources): Promise<boolean> {
  let primaryKeyBytes: number[] | null = null
  let identityKey = ''

  if (sources.mnemonic) {
    const { primaryKey, identityKey: id } = recoverMnemonicWallet(sources.mnemonic)
    primaryKeyBytes = primaryKey
    identityKey = id
  } else if (sources.recoveredKeyWif) {
    const priv = PrivateKey.fromWif(sources.recoveredKeyWif)
    primaryKeyBytes = priv.toArray()
    identityKey = priv.toPublicKey().toString()
  }

  if (!primaryKeyBytes) return false

  const shares = generateBackupShares(primaryKeyBytes)
  const html = await generatePrintHTML(shares, identityKey)
  await Print.printAsync({ html })
  return true
}
