/**
 * Vault key derivation from the MAIN wallet mnemonic + a vault passphrase,
 * with BIP32 HD deposit addresses.
 *
 *   main wallet    : HD.fromSeed(Mnemonic.toSeed(''))
 *   vault HD node  : HD.fromSeed(Mnemonic.toSeed(vaultPassphrase))
 *   deposit addr n : vaultHD.deriveChild(n)
 *
 * Persistence is a single counter (`nextKeyIndex`) plus the vault xpub — no
 * precomputed queue of key hashes. The xpub is what lets deposits derive
 * address n on demand with no YubiKey and no replenishment ceremony.
 *
 * Recovery paths, and there are exactly two:
 *   1. YubiKey + PIN               — signs directly, nothing to unseal
 *   2. main mnemonic + passphrase  (this file)
 *
 * The passphrase has NO checksum, so a typo silently yields a different,
 * valid, EMPTY vault. The stored xpub doubles as the offline verifier.
 */
import { Mnemonic, HD } from '@bsv/sdk'
import {
  deriveVaultSeed,
  deriveVaultHD,
  vaultXpub,
  depositPkhFromXpub,
  depositPrivKey,
  verifyVaultPassphrase,
  bip32KeyID,
  indexFromKeyID
} from '../../services/vault/vaultDerivation'

// A fixed, well-known throwaway BIP39 test vector. NEVER a real wallet phrase.
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const PASSPHRASE = 'correct horse battery staple anchor'

describe('deriveVaultSeed', () => {
  it('is deterministic for the same mnemonic and passphrase', () => {
    expect(deriveVaultSeed(TEST_MNEMONIC, PASSPHRASE)).toEqual(
      deriveVaultSeed(TEST_MNEMONIC, PASSPHRASE)
    )
  })

  it('yields a different seed for a different passphrase', () => {
    expect(deriveVaultSeed(TEST_MNEMONIC, PASSPHRASE)).not.toEqual(
      deriveVaultSeed(TEST_MNEMONIC, PASSPHRASE + ' extra')
    )
  })

  it('is a 64-byte BIP39 seed, so the HD chain code supports BIP32 child derivation', () => {
    // A bare 32-byte private key carries no chain code. deriveVaultHD /
    // depositPkhFromXpub / depositPrivKey all need to deriveChild(n) — both
    // for ordinary deposits (derived from the xpub, no YubiKey involved) and
    // for the K1 recovery sweep — so the seed must be the full 64 bytes.
    expect(deriveVaultSeed(TEST_MNEMONIC, PASSPHRASE)).toHaveLength(64)
  })

  it('refuses an empty passphrase', () => {
    // An empty passphrase makes the vault seed identical to the main wallet's
    // seed — the hot wallet could then spend the vault.
    expect(() => deriveVaultSeed(TEST_MNEMONIC, '')).toThrow(/passphrase/i)
  })

  it('refuses a whitespace-only passphrase', () => {
    expect(() => deriveVaultSeed(TEST_MNEMONIC, '   ')).toThrow(/passphrase/i)
  })

  it('refuses an invalid mnemonic', () => {
    expect(() => deriveVaultSeed('not a real mnemonic at all', PASSPHRASE)).toThrow()
  })

  it('ignores surrounding whitespace on the passphrase', () => {
    // BIP39 does not trim, so without normalisation a stray trailing space
    // would silently derive a different, empty vault.
    expect(deriveVaultSeed(TEST_MNEMONIC, `  ${PASSPHRASE}  `)).toEqual(
      deriveVaultSeed(TEST_MNEMONIC, PASSPHRASE)
    )
  })
})

describe('deriveVaultHD', () => {
  it('is domain-separated from the main wallet key derived from the same mnemonic', () => {
    // The whole point: same entropy, different key. If these ever matched the
    // vault would be spendable by the hot wallet.
    const mainKey = HD.fromSeed(Mnemonic.fromString(TEST_MNEMONIC).toSeed('')).privKey.toArray()
    const vaultKey = deriveVaultHD(TEST_MNEMONIC, PASSPHRASE).privKey.toArray()
    expect(vaultKey).not.toEqual(mainKey)
  })

  it('returns a private node', () => {
    expect(deriveVaultHD(TEST_MNEMONIC, PASSPHRASE).isPrivate()).toBe(true)
  })
})

describe('vaultXpub', () => {
  it('is public-only, so storing it can never leak spend authority', () => {
    const xpub = vaultXpub(deriveVaultHD(TEST_MNEMONIC, PASSPHRASE))
    expect(HD.fromString(xpub).isPrivate()).toBe(false)
  })

  it('is stable for the same mnemonic and passphrase', () => {
    expect(vaultXpub(deriveVaultHD(TEST_MNEMONIC, PASSPHRASE))).toBe(
      vaultXpub(deriveVaultHD(TEST_MNEMONIC, PASSPHRASE))
    )
  })

  it('differs for a different passphrase', () => {
    expect(vaultXpub(deriveVaultHD(TEST_MNEMONIC, PASSPHRASE))).not.toBe(
      vaultXpub(deriveVaultHD(TEST_MNEMONIC, 'a completely different passphrase here'))
    )
  })
})

describe('depositPkhFromXpub', () => {
  it('derives address n from the xpub alone, with no private key present', () => {
    // This is what removes the YubiKey from the deposit path entirely: no
    // precomputed queue, no replenishment ceremony, unlimited addresses.
    const xpub = vaultXpub(deriveVaultHD(TEST_MNEMONIC, PASSPHRASE))
    expect(depositPkhFromXpub(xpub, 0)).toMatch(/^[0-9a-f]{40}$/)
  })

  it('agrees with the private derivation at the same index', () => {
    // The load-bearing BIP32 property. If public and private derivation ever
    // disagreed, funds would be sent to addresses the vault cannot spend.
    const hd = deriveVaultHD(TEST_MNEMONIC, PASSPHRASE)
    const xpub = vaultXpub(hd)
    for (const n of [0, 1, 7, 64, 1000]) {
      const fromPublic = depositPkhFromXpub(xpub, n)
      const fromPrivate = depositPrivKey(hd, n).toPublicKey().toHash('hex') as string
      expect(fromPublic).toBe(fromPrivate)
    }
  })

  it('gives a different address for each index', () => {
    const xpub = vaultXpub(deriveVaultHD(TEST_MNEMONIC, PASSPHRASE))
    const seen = new Set([0, 1, 2, 3, 4, 5].map(n => depositPkhFromXpub(xpub, n)))
    expect(seen.size).toBe(6)
  })

  it('derives an index far beyond the old 64-key queue', () => {
    // The queue design failed closed at 64 addresses until another ceremony.
    const xpub = vaultXpub(deriveVaultHD(TEST_MNEMONIC, PASSPHRASE))
    expect(depositPkhFromXpub(xpub, 5000)).toMatch(/^[0-9a-f]{40}$/)
  })

  it('uses non-hardened indices, since hardened cannot derive from an xpub', () => {
    const xpub = vaultXpub(deriveVaultHD(TEST_MNEMONIC, PASSPHRASE))
    expect(() => depositPkhFromXpub(xpub, 0x80000000)).toThrow()
  })
})

describe('bip32 keyID encoding', () => {
  it('round trips an index', () => {
    expect(indexFromKeyID(bip32KeyID(42))).toBe(42)
  })

  it('is distinguishable from a legacy v1 keyID', () => {
    // v1 outputs carry 'vault/<n>' BRC-42 key ids. A v2 signer must not
    // mistake one for a BIP32 child index, or it would sign with the wrong key.
    expect(indexFromKeyID('vault/42')).toBeNull()
  })

  it('rejects malformed key ids rather than coercing them', () => {
    for (const bad of ['', 'bip32/', 'bip32/abc', 'bip32/-1', 'bip32/1.5', 'nonsense']) {
      expect(indexFromKeyID(bad)).toBeNull()
    }
  })
})

describe('verifyVaultPassphrase', () => {
  it('accepts the passphrase the vault was created with', () => {
    const xpub = vaultXpub(deriveVaultHD(TEST_MNEMONIC, PASSPHRASE))
    expect(verifyVaultPassphrase(TEST_MNEMONIC, PASSPHRASE, xpub)).toBe(true)
  })

  it('rejects a single-character typo', () => {
    // The headline hazard: without this a typo silently opens a different,
    // empty vault and the user believes their funds are gone.
    const xpub = vaultXpub(deriveVaultHD(TEST_MNEMONIC, PASSPHRASE))
    expect(verifyVaultPassphrase(TEST_MNEMONIC, 'correct horse battery staple anchoe', xpub)).toBe(
      false
    )
  })

  it('rejects a correct passphrase against the wrong mnemonic', () => {
    const xpub = vaultXpub(deriveVaultHD(TEST_MNEMONIC, PASSPHRASE))
    const other = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
    expect(verifyVaultPassphrase(other, PASSPHRASE, xpub)).toBe(false)
  })

  it('returns false rather than throwing on an empty passphrase', () => {
    // The UI calls this while the user is still typing; it must not throw.
    const xpub = vaultXpub(deriveVaultHD(TEST_MNEMONIC, PASSPHRASE))
    expect(verifyVaultPassphrase(TEST_MNEMONIC, '', xpub)).toBe(false)
  })

  it('returns false rather than throwing on a malformed mnemonic', () => {
    const xpub = vaultXpub(deriveVaultHD(TEST_MNEMONIC, PASSPHRASE))
    expect(verifyVaultPassphrase('garbage', PASSPHRASE, xpub)).toBe(false)
  })

  it('returns false rather than throwing on a malformed xpub', () => {
    expect(verifyVaultPassphrase(TEST_MNEMONIC, PASSPHRASE, 'not-an-xpub')).toBe(false)
  })
})
