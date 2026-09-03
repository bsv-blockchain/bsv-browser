/**
 * Backup identity derivation.
 *
 * One derived key serves two purposes: it signs every auth proof, so the server
 * only ever sees a pseudonym rather than the wallet's real identity key; and it is the
 * encryption key, used with counterparty 'self' so the server cannot decrypt what it
 * stores. Both properties are chosen by the client — the server is merely unable to help.
 *
 * The chain is part of the derivation (via the keyID), so each network gets an unrelated
 * pseudonym and an unrelated encryption key. That is the network-separation property:
 * a testnet wallet cannot list, download, or decrypt mainnet backups, and vice versa.
 */
import { CompletedProtoWallet, KeyDeriver, PrivateKey } from '@bsv/sdk'
import { BACKUP_PROTOCOL, backupKeyId, type BackupChain } from './constants'

/**
 * Derive the backup-only wallet from the wallet's primary key (m/0'/0') and the network.
 *
 * primaryKey, NOT rootKey. A wallet restored from printed backup shares recovers only the
 * m/0'/0' WIF and has no rootKey at all, so deriving from rootKey would leave exactly that
 * cohort unable to decrypt their own backups — the cohort this feature most helps.
 *
 * Using a dedicated wallet rather than the app's main one also keeps blob encryption clear
 * of WalletPermissionsManager, so it can never raise a protocol-permission prompt or a
 * spending-authorisation gate.
 */
export function deriveBackupWallet (primaryKey: number[], chain: BackupChain): CompletedProtoWallet {
  return new CompletedProtoWallet(deriveBackupKey(primaryKey, chain))
}

/** The private key behind the backup identity for one network. */
export function deriveBackupKey (primaryKey: number[], chain: BackupChain): PrivateKey {
  const deriver = new KeyDeriver(new PrivateKey(primaryKey))
  return deriver.derivePrivateKey(BACKUP_PROTOCOL, backupKeyId(chain), 'self')
}

/**
 * The server-visible account address: a compressed public key in DER hex.
 *
 * This is never the wallet's identity key, and the server has no other way to address an
 * account — there is no identity field anywhere in the API. One seed yields a DIFFERENT
 * pseudonym per network, so mainnet and testnet logs live in separate server accounts.
 */
export function backupPseudonym (primaryKey: number[], chain: BackupChain): string {
  return deriveBackupKey(primaryKey, chain).toPublicKey().toString()
}
