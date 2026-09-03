import { PrivateKey } from '@bsv/sdk'
import { BACKUP_PROTOCOL, backupKeyId } from '@/utils/backup/constants'
import { backupPseudonym, deriveBackupKey, deriveBackupWallet } from '@/utils/backup/derive'

// A deliberately trivial, well-known test key. Never funded, never used on mainnet.
const TEST_PRIMARY = new PrivateKey(1).toArray('be', 32)

describe('backup key derivation', () => {
  it('is deterministic for a given primaryKey and chain', () => {
    expect(backupPseudonym(TEST_PRIMARY, 'main')).toBe(backupPseudonym(TEST_PRIMARY, 'main'))
  })

  it('produces a compressed public key in hex', () => {
    expect(backupPseudonym(TEST_PRIMARY, 'main')).toMatch(/^0[23][0-9a-f]{64}$/)
  })

  it('differs from the wallet identity key', () => {
    // The privacy property in one assertion: the server authenticates the pseudonym and
    // therefore never learns the identity key the rest of the app uses.
    const identity = new PrivateKey(TEST_PRIMARY).toPublicKey().toString()
    expect(backupPseudonym(TEST_PRIMARY, 'main')).not.toBe(identity)
  })

  it('differs for a different primaryKey', () => {
    expect(backupPseudonym(TEST_PRIMARY, 'main'))
      .not.toBe(backupPseudonym(new PrivateKey(2).toArray('be', 32), 'main'))
  })

  it('differs for every pair of chains', () => {
    // The network-separation property. One seed must land on THREE distinct server
    // accounts, so a testnet wallet can never see — let alone restore — mainnet blobs.
    const main = backupPseudonym(TEST_PRIMARY, 'main')
    const test = backupPseudonym(TEST_PRIMARY, 'test')
    const teratest = backupPseudonym(TEST_PRIMARY, 'teratest')

    expect(main).not.toBe(test)
    expect(main).not.toBe(teratest)
    expect(test).not.toBe(teratest)
  })

  it('MATCHES THE FROZEN VECTORS', () => {
    // Precomputed straight from @bsv/sdk's KeyDeriver with protocol [2, 'wallet backup log']
    // and keyID `1 ${chain}`, counterparty 'self'.
    //
    // If this fails, DO NOT update the expected values. A mismatch means derive.ts disagrees
    // with the spec — most likely the protocol tuple, the keyID, or the counterparty.
    // Changing a vector here would orphan every backup already written under it, silently.
    expect(backupPseudonym(TEST_PRIMARY, 'main'))
      .toBe('03078c66c5f14fdaab3ab1ec6ce0cd4efd736ad35afeed09826dff11e7ce1b1bdb')
    expect(backupPseudonym(TEST_PRIMARY, 'test'))
      .toBe('029a0df2fabef7479dfe7086db3f750fbc526bdac1243f75b9eb8628544a1398cd')
    expect(backupPseudonym(TEST_PRIMARY, 'teratest'))
      .toBe('0313989e4302d8b64975fbe2a2d16c344188a94934df028cd57f058f409bf97c5a')
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
    expect(backupPseudonym(recovered, 'main')).toBe(backupPseudonym(TEST_PRIMARY, 'main'))
  })

  it('derives identically from padded and minimal key encodings', () => {
    // WalletContext's share-restore path calls recoveredKey.toArray() with no padding, so
    // the same key can reach us in either encoding. Both must land on one pseudonym.
    const minimal = new PrivateKey(TEST_PRIMARY).toArray()
    expect(backupPseudonym(minimal, 'main')).toBe(backupPseudonym(TEST_PRIMARY, 'main'))
  })

  it('round-trips encryption with counterparty self', async () => {
    const w = deriveBackupWallet(TEST_PRIMARY, 'main')
    const plaintext = [1, 2, 3, 4, 5]

    const { ciphertext } = await w.encrypt({
      plaintext, protocolID: BACKUP_PROTOCOL, keyID: backupKeyId('main'), counterparty: 'self',
    })
    const { plaintext: out } = await w.decrypt({
      ciphertext, protocolID: BACKUP_PROTOCOL, keyID: backupKeyId('main'), counterparty: 'self',
    })

    expect(out).toEqual(plaintext)
    expect(ciphertext).not.toEqual(plaintext)
  })

  it('produces ciphertext another wallet cannot read', async () => {
    // What makes the store zero-knowledge: nobody without this seed can derive the key,
    // including the server holding the ciphertext.
    const mine = deriveBackupWallet(TEST_PRIMARY, 'main')
    const theirs = deriveBackupWallet(new PrivateKey(9).toArray('be', 32), 'main')

    const { ciphertext } = await mine.encrypt({
      plaintext: [9, 9, 9], protocolID: BACKUP_PROTOCOL, keyID: backupKeyId('main'), counterparty: 'self',
    })

    await expect(theirs.decrypt({
      ciphertext, protocolID: BACKUP_PROTOCOL, keyID: backupKeyId('main'), counterparty: 'self',
    })).rejects.toThrow()
  })

  it('produces ciphertext the SAME wallet on another chain cannot read', async () => {
    // Cross-network restore must be cryptographically impossible, not merely filtered:
    // the testnet-derived key must fail to decrypt a mainnet blob outright.
    const main = deriveBackupWallet(TEST_PRIMARY, 'main')
    const test = deriveBackupWallet(TEST_PRIMARY, 'test')

    const { ciphertext } = await main.encrypt({
      plaintext: [1, 2, 3], protocolID: BACKUP_PROTOCOL, keyID: backupKeyId('main'), counterparty: 'self',
    })

    await expect(test.decrypt({
      ciphertext, protocolID: BACKUP_PROTOCOL, keyID: backupKeyId('test'), counterparty: 'self',
    })).rejects.toThrow()
  })

  it('exposes the private key behind the pseudonym', () => {
    expect(deriveBackupKey(TEST_PRIMARY, 'main').toPublicKey().toString())
      .toBe(backupPseudonym(TEST_PRIMARY, 'main'))
  })
})
