/**
 * Backup identity derivation.
 *
 * One derived key serves two purposes: it is the AuthFetch peer identity, so the server
 * only ever sees a pseudonym rather than the wallet's real identity key; and it is the
 * encryption key, used with counterparty 'self' so the server cannot decrypt what it
 * stores. Both properties are chosen by the client — the server is merely unable to help.
 */
import { CompletedProtoWallet, KeyDeriver, PrivateKey } from '@bsv/sdk'
import { BACKUP_KEY_ID, BACKUP_PROTOCOL } from './constants'

/**
 * Derive the backup-only wallet from the wallet's primary key (m/0'/0').
 *
 * primaryKey, NOT rootKey. A wallet restored from printed backup shares recovers only the
 * m/0'/0' WIF and has no rootKey at all, so deriving from rootKey would leave exactly that
 * cohort unable to decrypt their own backups — the cohort this feature most helps.
 *
 * Using a dedicated wallet rather than the app's main one also keeps blob encryption clear
 * of WalletPermissionsManager, so it can never raise a protocol-permission prompt or a
 * spending-authorisation gate.
 */
export function deriveBackupWallet (primaryKey: number[]): CompletedProtoWallet {
  return new CompletedProtoWallet(deriveBackupKey(primaryKey))
}

/** The private key behind the backup identity. */
export function deriveBackupKey (primaryKey: number[]): PrivateKey {
  const deriver = new KeyDeriver(new PrivateKey(primaryKey))
  return deriver.derivePrivateKey(BACKUP_PROTOCOL, BACKUP_KEY_ID, 'self')
}

/**
 * The server-visible account address: a compressed public key in DER hex.
 *
 * This is never the wallet's identity key, and the server has no other way to address an
 * account — there is no identity field anywhere in the API.
 */
export function backupPseudonym (primaryKey: number[]): string {
  return deriveBackupKey(primaryKey).toPublicKey().toString()
}
