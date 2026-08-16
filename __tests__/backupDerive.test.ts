import { PrivateKey } from '@bsv/sdk'
import { BACKUP_KEY_ID, BACKUP_PROTOCOL } from '@/utils/backup/constants'
import { backupPseudonym, deriveBackupKey, deriveBackupWallet } from '@/utils/backup/derive'

// A deliberately trivial, well-known test key. Never funded, never used on mainnet.
const TEST_PRIMARY = new PrivateKey(1).toArray('be', 32)

describe('backup key derivation', () => {
  it('is deterministic for a given primaryKey', () => {
    expect(backupPseudonym(TEST_PRIMARY)).toBe(backupPseudonym(TEST_PRIMARY))
  })

  it('produces a compressed public key in hex', () => {
    expect(backupPseudonym(TEST_PRIMARY)).toMatch(/^0[23][0-9a-f]{64}$/)
  })

  it('differs from the wallet identity key', () => {
    // The privacy property in one assertion: the server authenticates the pseudonym and
    // therefore never learns the identity key the rest of the app uses.
    const identity = new PrivateKey(TEST_PRIMARY).toPublicKey().toString()
    expect(backupPseudonym(TEST_PRIMARY)).not.toBe(identity)
  })

  it('differs for a different primaryKey', () => {
    expect(backupPseudonym(TEST_PRIMARY)).not.toBe(backupPseudonym(new PrivateKey(2).toArray('be', 32)))
  })

  it('MATCHES THE FROZEN VECTOR', () => {
    // Precomputed and verified identical on @bsv/sdk 2.1.9 and 2.4.0.
    //
    // If this fails, DO NOT update the expected value. The constant is correct; a mismatch
    // means derive.ts disagrees with the spec — most likely the protocol tuple, the keyID,
    // or the counterparty. Changing it here would orphan every backup already written by a
    // shipped build, silently.
    expect(backupPseudonym(TEST_PRIMARY))
      .toBe('03d7a8c57df91ccdc3704f2cc546b0c19b2dcfab5d3e0a438d2a8ae6cd3d3618b5')
  })

  it('recovers the same pseudonym from a share-restored primary key', () => {
    // Share restore yields only the m/0'/0' WIF and no rootKey. Deriving the backup key
    // from rootKey would silently lock this cohort out of their own backups, so this test
    // is what pins the choice of primaryKey.
    const shares = new PrivateKey(TEST_PRIMARY).toBackupShares(2, 3)
    const recovered = PrivateKey.fromBackupShares([shares[0], shares[2]]).toArray()

    // Compare as scalars, not byte arrays: toArray() returns the minimal big-endian form,
    // so a leading-zero key is shorter than 32 bytes. Derivation reads the scalar, so the
    // encoding difference is immaterial — and asserting on it would be asserting on the
    // wrong thing.
    expect(new PrivateKey(recovered).toHex()).toBe(new PrivateKey(TEST_PRIMARY).toHex())
    expect(backupPseudonym(recovered)).toBe(backupPseudonym(TEST_PRIMARY))
  })

  it('derives identically from padded and minimal key encodings', () => {
    // WalletContext's share-restore path calls recoveredKey.toArray() with no padding, so
    // the same key can reach us in either encoding. Both must land on one pseudonym.
    const minimal = new PrivateKey(TEST_PRIMARY).toArray()
    expect(backupPseudonym(minimal)).toBe(backupPseudonym(TEST_PRIMARY))
  })

  it('round-trips encryption with counterparty self', async () => {
    const w = deriveBackupWallet(TEST_PRIMARY)
    const plaintext = [1, 2, 3, 4, 5]

    const { ciphertext } = await w.encrypt({
      plaintext, protocolID: BACKUP_PROTOCOL, keyID: BACKUP_KEY_ID, counterparty: 'self',
    })
    const { plaintext: out } = await w.decrypt({
      ciphertext, protocolID: BACKUP_PROTOCOL, keyID: BACKUP_KEY_ID, counterparty: 'self',
    })

    expect(out).toEqual(plaintext)
    expect(ciphertext).not.toEqual(plaintext)
  })

  it('produces ciphertext another wallet cannot read', async () => {
    // What makes the store zero-knowledge: nobody without this seed can derive the key,
    // including the server holding the ciphertext.
    const mine = deriveBackupWallet(TEST_PRIMARY)
    const theirs = deriveBackupWallet(new PrivateKey(9).toArray('be', 32))

    const { ciphertext } = await mine.encrypt({
      plaintext: [9, 9, 9], protocolID: BACKUP_PROTOCOL, keyID: BACKUP_KEY_ID, counterparty: 'self',
    })

    await expect(theirs.decrypt({
      ciphertext, protocolID: BACKUP_PROTOCOL, keyID: BACKUP_KEY_ID, counterparty: 'self',
    })).rejects.toThrow()
  })

  it('exposes the private key behind the pseudonym', () => {
    expect(deriveBackupKey(TEST_PRIMARY).toPublicKey().toString()).toBe(backupPseudonym(TEST_PRIMARY))
  })
})
