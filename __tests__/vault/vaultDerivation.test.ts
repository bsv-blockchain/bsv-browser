/**
 * Vault key derivation from the MAIN wallet mnemonic + a vault passphrase,
 * with BIP32 HD deposit addresses.
 *
 *   main wallet    : HD.fromSeed(Mnemonic.toSeed(''))
 *   vault HD node  : HD.fromSeed(Mnemonic.toSeed(vaultPassphrase))
 *   deposit addr n : vaultHD.deriveChild(n)
 *
 * There is no xpub anywhere in this design: nothing public is ever at rest.
 * Deposit addresses derive from the private HD node, which exists only after
 * one of the two recovery routes below reaches it.
 *
 * Recovery paths, and there are exactly two:
 *   1. YubiKey-unseal of the sealed seed  — nothing to derive from a phrase
 *   2. main mnemonic + passphrase          (this file)
 * Both reach the same HD node; deposits derive post-unseal either way.
 */
import { Mnemonic, HD, Hash } from '@bsv/sdk'
import {
  deriveVaultSeed,
  deriveVaultHD,
  depositPrivKey,
  depositPubKeyHash,
  bip32KeyID,
  indexFromKeyID,
  randomDepositStartIndex
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
    // depositPubKeyHash / depositPrivKey all need to deriveChild(n) — both
    // for ordinary deposits and for the K1 recovery sweep — so the seed must
    // be the full 64 bytes.
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

describe('depositPubKeyHash', () => {
  it("matches the hash of depositPrivKey's public key", () => {
    const hd = deriveVaultHD(TEST_MNEMONIC, PASSPHRASE)
    const pkh = depositPubKeyHash(hd, 7)
    const fromPriv = Hash.hash160(depositPrivKey(hd, 7).toPublicKey().encode(true) as number[])
    expect(pkh).toEqual(fromPriv)
  })

  it('agrees with the private derivation at every index', () => {
    // The load-bearing BIP32 property. If the two ever disagreed, deposits
    // would be sent to addresses the vault cannot spend.
    const hd = deriveVaultHD(TEST_MNEMONIC, PASSPHRASE)
    for (const n of [0, 1, 7, 64, 1000]) {
      const pkh = depositPubKeyHash(hd, n)
      const fromPriv = Hash.hash160(depositPrivKey(hd, n).toPublicKey().encode(true) as number[])
      expect(pkh).toEqual(fromPriv)
    }
  })

  it('gives a different hash for each index', () => {
    const hd = deriveVaultHD(TEST_MNEMONIC, PASSPHRASE)
    const seen = new Set([0, 1, 2, 3, 4, 5].map(n => depositPubKeyHash(hd, n).join(',')))
    expect(seen.size).toBe(6)
  })

  it('rejects hardened indices', () => {
    const hd = deriveVaultHD(TEST_MNEMONIC, PASSPHRASE)
    expect(() => depositPubKeyHash(hd, 0x80000000)).toThrow()
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

describe('randomDepositStartIndex', () => {
  it('stays inside the non-hardened range with room to increment', () => {
    for (let i = 0; i < 200; i++) {
      const n = randomDepositStartIndex()
      expect(Number.isSafeInteger(n)).toBe(true)
      // Above any counter a from-zero device could plausibly have reached...
      expect(n).toBeGreaterThanOrEqual(1 << 20)
      // ...and far enough below the hardened boundary that a lifetime of
      // deposits can never walk into it.
      expect(n).toBeLessThan(0x40000000)
      // Derivable, which is the whole point — a hardened index would not be.
      expect(depositPubKeyHash(deriveVaultHD(TEST_MNEMONIC, PASSPHRASE), n)).toHaveLength(20)
    }
  })

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 50 }, () => randomDepositStartIndex()))
    expect(seen.size).toBe(50)
  })
})
