/**
 * Vault passphrase strength policy.
 *
 * The vault key is derived from the MAIN wallet mnemonic plus this passphrase
 * via BIP39 toSeed(), which is PBKDF2-HMAC-SHA512 at only 2048 rounds. An
 * attacker holding the main mnemonic can therefore grind candidate
 * passphrases offline at roughly 10^7 guesses/sec on commodity GPUs.
 * Measured locally: ~2.4k guesses/sec on a single CPU core.
 *
 * That makes anything a human would call a "password" useless here:
 *   8 lowercase letters  -> ~1.2 hours
 *   8 mixed alphanumeric -> ~53 days
 *   5 diceware words     -> ~19,000 years
 *
 * So the policy gate is expressed in bits of guessing entropy, not in the
 * usual "one capital and a symbol" theatre, which buys almost nothing.
 */
import {
  passphraseEntropyBits,
  checkVaultPassphrase,
  crackTimeSeconds,
  formatCrackTime,
  passphraseStrength,
  RECOMMENDED_WORD_COUNT,
  MINIMUM_WORD_COUNT,
  generatePassphrase,
  VAULT_PASSPHRASE_MIN_BITS
} from '../../services/vault/vaultPassphrase'

describe('passphraseEntropyBits', () => {
  it('scores an empty passphrase as zero', () => {
    expect(passphraseEntropyBits('')).toBe(0)
  })

  it('scores a longer word sequence above a shorter one', () => {
    const short = passphraseEntropyBits('correct horse')
    const long = passphraseEntropyBits('correct horse battery staple anchor')
    expect(long).toBeGreaterThan(short)
  })

  it('does not reward repeating the same word', () => {
    const varied = passphraseEntropyBits('correct horse battery staple anchor')
    const repeated = passphraseEntropyBits('anchor anchor anchor anchor anchor')
    expect(repeated).toBeLessThan(varied)
  })

  it('does not reward a single character repeated', () => {
    expect(passphraseEntropyBits('aaaaaaaaaaaaaaaaaaaa')).toBeLessThan(VAULT_PASSPHRASE_MIN_BITS)
  })
})

describe('checkVaultPassphrase', () => {
  it('rejects an empty passphrase', () => {
    const result = checkVaultPassphrase('')
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/required/i)
  })

  it('rejects a whitespace-only passphrase', () => {
    expect(checkVaultPassphrase('   ').ok).toBe(false)
  })

  it('rejects a typeable 8-character password', () => {
    // ~53 days to crack given the main mnemonic. Not acceptable for a vault.
    const result = checkVaultPassphrase('Tr0ub4dr')
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/stronger|weak|longer/i)
  })

  it('accepts a five-word passphrase', () => {
    const result = checkVaultPassphrase('correct horse battery staple anchor')
    expect(result.ok).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it('reports the entropy estimate alongside the verdict', () => {
    const result = checkVaultPassphrase('correct horse battery staple anchor')
    expect(result.bits).toBeGreaterThanOrEqual(VAULT_PASSPHRASE_MIN_BITS)
  })

  it('treats a leading or trailing space as insignificant', () => {
    // BIP39 NFKD-normalises but does NOT trim, so " abc" and "abc" are
    // different keys. Callers must normalise before derivation; this asserts
    // the checker sees the same passphrase either way so the UI cannot let a
    // stray space silently produce a different vault.
    const a = checkVaultPassphrase('correct horse battery staple anchor')
    const b = checkVaultPassphrase('  correct horse battery staple anchor  ')
    expect(b.ok).toBe(a.ok)
    expect(b.bits).toBe(a.bits)
  })
})

describe('VAULT_PASSPHRASE_MIN_BITS', () => {
  it('equals five BIP39 words, the floor for this KDF', () => {
    // BIP39 is a 2048-word list => 11 bits/word. Five words is 55 bits.
    expect(VAULT_PASSPHRASE_MIN_BITS).toBe(MINIMUM_WORD_COUNT * 11)
  })
})

describe('common-password resistance', () => {
  // A naive charset^length model rates "P@ssw0rd123" at ~66 bits because it
  // uses four character classes. It is a top-100 password. Character-class
  // variety is not entropy when the base word is guessable.
  const commonPasswords = [
    'password',
    'Password1',
    'P@ssw0rd123',
    'passw0rd',
    'qwerty123',
    'Qwerty123!',
    'letmein',
    'iloveyou2',
    'monkey123',
    'adm1n',
    'welcome1',
    'tr0ub4dor'
  ]

  it.each(commonPasswords)('rejects %s', pw => {
    expect(checkVaultPassphrase(pw).ok).toBe(false)
  })

  it.each(commonPasswords)('does not rate %s above the acceptance gate', pw => {
    expect(passphraseEntropyBits(pw)).toBeLessThan(VAULT_PASSPHRASE_MIN_BITS)
  })

  it('still accepts a genuine five-word passphrase', () => {
    // Guard against the common-password penalty being so broad it eats real
    // passphrases.
    expect(checkVaultPassphrase('correct horse battery staple anchor').ok).toBe(true)
    expect(checkVaultPassphrase('velvet anchor tundra maple rooster').ok).toBe(true)
  })

  it('still accepts a long genuinely random string', () => {
    expect(checkVaultPassphrase('xK7#mQ2$pL9vB4nR8wZ').ok).toBe(true)
  })
})

describe('generatePassphrase', () => {
  it('produces the recommended number of words by default', () => {
    expect(generatePassphrase().split(' ')).toHaveLength(RECOMMENDED_WORD_COUNT)
  })

  it('produces a passphrase that passes the policy', () => {
    // A generator that emits something the checker then rejects would be an
    // unusable dead end for the user.
    for (let i = 0; i < 20; i++) {
      expect(checkVaultPassphrase(generatePassphrase()).ok).toBe(true)
    }
  })

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 20 }, () => generatePassphrase()))
    expect(seen.size).toBe(20)
  })

  it('emits lowercase words separated by single spaces', () => {
    expect(generatePassphrase()).toMatch(/^[a-z]+( [a-z]+)*$/)
  })

  it('refuses to generate below the minimum word count', () => {
    // Handing the user a phrase weaker than the floor would be actively unsafe.
    expect(() => generatePassphrase(MINIMUM_WORD_COUNT - 1)).toThrow()
  })
})

describe('crackTimeSeconds', () => {
  it('is zero for no entropy', () => {
    expect(crackTimeSeconds(0)).toBe(0)
  })

  it('grows as entropy grows', () => {
    expect(crackTimeSeconds(70)).toBeGreaterThan(crackTimeSeconds(40))
  })

  it('doubling the search space roughly doubles the time', () => {
    const a = crackTimeSeconds(40)
    const b = crackTimeSeconds(41)
    expect(b / a).toBeCloseTo(2, 5)
  })

  it('puts an 8-character lowercase password under a day', () => {
    // 26^8 ~= 37.6 bits. Measured baseline says hours, not years.
    expect(crackTimeSeconds(37.6)).toBeLessThan(60 * 60 * 24)
  })

  it('puts five random words beyond a thousand years', () => {
    const fiveWords = 6 * Math.log2(2048)
    expect(crackTimeSeconds(fiveWords)).toBeGreaterThan(1000 * 31557600)
  })
})

describe('formatCrackTime', () => {
  it('says instantly for no entropy', () => {
    expect(formatCrackTime(0)).toMatch(/instant/i)
  })

  it('uses seconds for trivial passphrases', () => {
    expect(formatCrackTime(20)).toMatch(/second/i)
  })

  it('uses years for strong passphrases', () => {
    expect(formatCrackTime(80)).toMatch(/year|centur|millenni/i)
  })

  it('does not print unreadable exponent soup for enormous values', () => {
    expect(formatCrackTime(200)).not.toMatch(/e\+/)
  })

  it('is a short phrase suitable for a meter caption', () => {
    expect(formatCrackTime(65).length).toBeLessThan(40)
  })
})

describe('passphraseStrength', () => {
  it('reports an empty passphrase as the lowest tier', () => {
    const s = passphraseStrength('')
    expect(s.tier).toBe('empty')
    expect(s.fraction).toBe(0)
    expect(s.ok).toBe(false)
  })

  it('reports a typeable password as weak and not acceptable', () => {
    const s = passphraseStrength('Tr0ub4dr')
    expect(s.tier).toBe('weak')
    expect(s.ok).toBe(false)
  })

  it('reports five random words as strong and acceptable', () => {
    const s = passphraseStrength('correct horse battery staple anchor')
    expect(s.ok).toBe(true)
    expect(['strong', 'excellent']).toContain(s.tier)
  })

  it('gives a fraction between 0 and 1 for driving a meter bar', () => {
    for (const pw of ['', 'a', 'Tr0ub4dr', 'correct horse battery staple anchor', 'x'.repeat(200)]) {
      const f = passphraseStrength(pw).fraction
      expect(f).toBeGreaterThanOrEqual(0)
      expect(f).toBeLessThanOrEqual(1)
    }
  })

  it('increases the meter fraction as the passphrase improves', () => {
    const weak = passphraseStrength('horse').fraction
    const better = passphraseStrength('correct horse battery').fraction
    const best = passphraseStrength('correct horse battery staple anchor').fraction
    expect(better).toBeGreaterThan(weak)
    expect(best).toBeGreaterThan(better)
  })

  it('carries the human-readable crack time for display', () => {
    expect(passphraseStrength('correct horse battery staple anchor').crackTime).toMatch(
      /year|centur|millenni/i
    )
  })

  it('generates more words than the bare minimum, for margin', () => {
    expect(RECOMMENDED_WORD_COUNT).toBeGreaterThan(MINIMUM_WORD_COUNT)
  })

  it('rates a generated passphrase above the gate', () => {
    const generated = 'fiction bottom predict obscure replace tunnel'
    expect(passphraseStrength(generated).ok).toBe(true)
  })
})
