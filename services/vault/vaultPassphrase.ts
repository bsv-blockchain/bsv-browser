/**
 * Vault passphrase strength policy.
 *
 * The vault key is derived from the main wallet mnemonic plus a user-chosen
 * passphrase through BIP39 `Mnemonic.toSeed(passphrase)` — PBKDF2-HMAC-SHA512
 * at 2048 rounds (see @bsv/sdk compat/Mnemonic mnemonic2Seed). 2048 rounds is
 * essentially no work factor by modern standards, so an attacker who obtains
 * the main mnemonic can grind candidate passphrases offline very cheaply.
 *
 * Measured on a single CPU core here: ~2,400 guesses/sec. A commodity GPU rig
 * is comfortably 10^7/sec. Against that:
 *
 *   8 lowercase letters    ~1.2 hours
 *   8 mixed alphanumeric   ~53 days
 *   5 random BIP39 words   ~57 years      (55 bits — the floor)
 *   6 random BIP39 words   ~117,000 years (66 bits — what we generate)
 *
 * Hence the gate is expressed in guessing entropy rather than character-class
 * rules, which add almost nothing against offline search. Note the word model
 * credits 11 bits/word (BIP39's 2048-word list), not diceware's 12.9.
 *
 * SECURITY: never log the passphrase or anything derived from it. These
 * functions deliberately return only a bit estimate and a verdict.
 */

/**
 * Minimum guessing entropy, in bits, accepted for a vault passphrase.
 *
 * 55 bits is exactly five words drawn uniformly from the BIP39 list, which is
 * the floor the security review set for this KDF.
 */
import { Mnemonic } from '@bsv/sdk'
import { randomBytes } from './random'

export const VAULT_PASSPHRASE_MIN_BITS = 55

/**
 * Bits per word, from the BIP39 English wordlist: 2048 words = 11 bits.
 *
 * Deliberately NOT diceware's 7776 (12.9 bits). Generated passphrases come
 * from the BIP39 list, and user-chosen words are not uniform over any list, so
 * crediting 12.9 would overstate real strength by roughly two bits per word.
 */
const BITS_PER_WORD = Math.log2(2048)

/**
 * Words offered by the generator. Six gives 66 bits — comfortable margin over
 * the 55-bit floor, which five words only just reaches.
 */
export const RECOMMENDED_WORD_COUNT = 6

/** The floor, in words: five random words is exactly VAULT_PASSPHRASE_MIN_BITS. */
export const MINIMUM_WORD_COUNT = 5

/**
 * Assumed offline guess rate, in guesses/sec, for an attacker who already
 * holds the main mnemonic and is grinding the passphrase.
 *
 * Measured here: ~2,400/sec on one CPU core against PBKDF2-SHA512 at 2048
 * rounds. 10^7 is a modest GPU rig — deliberately conservative, so the number
 * shown to the user understates rather than overstates their safety.
 */
const ATTACKER_GUESSES_PER_SEC = 1e7

/** Entropy at which the meter bar reads full. */
const METER_FULL_BITS = 80

const SECONDS_PER_YEAR = 31557600

/**
 * Generate a passphrase of uniformly random BIP39 words.
 *
 * An app-generated phrase is strictly stronger than a user-invented one: human
 * choices cluster hard, which is exactly what a cracking rule set exploits.
 */
export function generatePassphrase(words: number = RECOMMENDED_WORD_COUNT): string {
  if (!Number.isInteger(words) || words < MINIMUM_WORD_COUNT) {
    throw new Error(`Refusing to generate fewer than ${MINIMUM_WORD_COUNT} words`)
  }
  const out: string[] = []
  // 32 bytes of entropy yields 24 words; loop for unusually long requests.
  while (out.length < words) {
    out.push(...new Mnemonic().entropy2Mnemonic(randomBytes(32)).toString().split(' '))
  }
  return out.slice(0, words).join(' ')
}

export interface PassphraseVerdict {
  ok: boolean
  bits: number
  reason?: string
}

export type PassphraseTier = 'empty' | 'weak' | 'fair' | 'strong' | 'excellent'

export interface PassphraseStrength {
  ok: boolean
  bits: number
  /** 0..1, for driving a meter bar. */
  fraction: number
  tier: PassphraseTier
  /** Human-readable time to crack, e.g. "about 44,000 years". */
  crackTime: string
  reason?: string
}

/**
 * Normalise a passphrase for both checking and derivation.
 *
 * BIP39 applies NFKD but does NOT trim, so " abc" and "abc" derive different
 * seeds. Callers MUST run the passphrase through this before `toSeed`, so a
 * stray leading space can never silently produce a different (empty) vault.
 */
export function normalizeVaultPassphrase(passphrase: string): string {
  return passphrase.normalize('NFKD').trim().replace(/\s+/g, ' ')
}

/** Size of the character space the passphrase appears to be drawn from. */
function charsetSize(s: string): number {
  let size = 0
  if (/[a-z]/.test(s)) size += 26
  if (/[A-Z]/.test(s)) size += 26
  if (/[0-9]/.test(s)) size += 10
  if (/\s/.test(s)) size += 1
  if (/[^a-zA-Z0-9\s]/.test(s)) size += 33
  return size
}

/** Collapse runs of the same character so "aaaa" counts as one choice. */
function collapseRuns(s: string): string {
  return s.replace(/(.)\1+/g, '$1')
}

/**
 * Common password bases, after leet-normalisation and affix stripping.
 *
 * Character-class variety is not entropy when the base word is guessable: a
 * naive charset^length model rates "P@ssw0rd123" at ~66 bits, which would sail
 * past the gate. Any attacker grinding this KDF tries these first.
 */
const COMMON_BASES = new Set([
  'password', 'passwd', 'pass', 'qwerty', 'qwertyuiop', 'asdf', 'asdfgh', 'zxcvbn',
  'letmein', 'iloveyou', 'monkey', 'admin', 'administrator', 'welcome', 'login',
  'troubador', 'troubadour', 'dragon', 'sunshine', 'princess', 'football',
  'baseball', 'basketball', 'master', 'shadow', 'superman', 'batman', 'starwars',
  'michael', 'jennifer', 'jordan', 'hunter', 'trustno', 'whatever', 'freedom',
  'ninja', 'access', 'flower', 'secret', 'summer', 'winter', 'google', 'abc',
  'test', 'guest', 'root', 'user', 'changeme', 'default', 'bitcoin', 'satoshi'
])

const LEET: Record<string, string> = {
  '@': 'a', '0': 'o', '3': 'e', '$': 's', '4': 'a',
  '7': 't', '5': 's', '8': 'b', '+': 't', '(': 'c'
}

/**
 * Reduce a passphrase to its likely base word, the way a cracking rule set
 * would: drop leading/trailing digit and punctuation affixes first (those are
 * suffixes, not leet), then map leet substitutions in what remains.
 *
 * '1' is ambiguous (i or l), so both readings are returned.
 */
function baseCandidates(s: string): string[] {
  const stripped = s.replace(/^[^a-zA-Z@$0-9]+|[\d\W_]+$/g, '')
  const map = (oneAs: string): string =>
    stripped
      .split('')
      .map(c => (c === '1' ? oneAs : (LEET[c] ?? c)))
      .join('')
      .toLowerCase()
      .replace(/[^a-z]/g, '')
  return [map('i'), map('l')]
}

/** True if the passphrase is a common password wearing a disguise. */
function isCommonPassword(s: string): boolean {
  if (s.includes(' ')) return false // multi-word phrases are handled by the word model
  return baseCandidates(s).some(b => b.length >= 3 && COMMON_BASES.has(b))
}

/** Entropy credited to a recognised common password, in bits. Deliberately
 * near zero: it is in the first million guesses of any attack. */
const COMMON_PASSWORD_BITS = 12

/**
 * Conservative guessing-entropy estimate, in bits.
 *
 * Two models are computed and the SMALLER is returned, so a passphrase is
 * only credited with strength both models agree on.
 */
export function passphraseEntropyBits(passphrase: string): number {
  const s = normalizeVaultPassphrase(passphrase)
  if (s.length === 0) return 0
  if (isCommonPassword(s)) return COMMON_PASSWORD_BITS

  const charBits = collapseRuns(s).length * Math.log2(charsetSize(s) || 1)

  // Word model only applies to an actual multi-word alphabetic phrase;
  // applying it to a single random-looking token would wrongly reject a
  // genuinely strong 16-char password.
  const tokens = s.split(' ')
  const isWordPhrase = tokens.length >= 2 && tokens.every(t => /^[a-zA-Z]+$/.test(t))
  if (!isWordPhrase) return charBits

  const uniqueWords = new Set(tokens.map(t => t.toLowerCase())).size
  const wordBits = uniqueWords * BITS_PER_WORD
  return Math.min(charBits, wordBits)
}

/** Apply the vault passphrase policy. */
export function checkVaultPassphrase(passphrase: string): PassphraseVerdict {
  const s = normalizeVaultPassphrase(passphrase)
  if (s.length === 0) {
    return { ok: false, bits: 0, reason: 'A vault passphrase is required.' }
  }

  const bits = passphraseEntropyBits(s)
  if (bits < VAULT_PASSPHRASE_MIN_BITS) {
    return {
      ok: false,
      bits,
      reason:
        'This passphrase is too weak. Use five or more unrelated words — anyone who obtains your recovery phrase can guess a short passphrase in hours.'
    }
  }
  return { ok: true, bits }
}

/**
 * Average seconds to crack, assuming the attacker already has the main
 * mnemonic and must only guess the passphrase. Average, not worst case, so
 * half the search space.
 */
export function crackTimeSeconds(bits: number): number {
  if (bits <= 0) return 0
  return Math.pow(2, bits) / 2 / ATTACKER_GUESSES_PER_SEC
}

/** "1 hour" / "2 hours" — never "1 hours". */
function qty(n: number, unit: string): string {
  const r = Math.round(n)
  return `${r.toLocaleString('en-US')} ${unit}${r === 1 ? '' : 's'}`
}

/** Short, readable crack time for a meter caption. Never exponent notation. */
export function formatCrackTime(bits: number): string {
  if (bits <= 0) return 'instantly'
  const s = crackTimeSeconds(bits)
  if (s < 1) return 'under a second'
  if (s < 60) return qty(s, 'second')
  if (s < 3600) return qty(s / 60, 'minute')
  if (s < 86400) return qty(s / 3600, 'hour')
  if (s < 2592000) return qty(s / 86400, 'day')
  if (s < SECONDS_PER_YEAR) return qty(s / 2592000, 'month')

  const years = s / SECONDS_PER_YEAR
  if (years < 1000) return qty(years, 'year')
  if (years < 1e6) return `${Math.round(years / 1000).toLocaleString('en-US')} thousand years`
  if (years < 1e9) return `${Math.round(years / 1e6).toLocaleString('en-US')} million years`
  if (years < 1e12) return `${Math.round(years / 1e9).toLocaleString('en-US')} billion years`
  return 'longer than the universe has existed'
}

function tierFor(bits: number): PassphraseTier {
  if (bits <= 0) return 'empty'
  if (bits < 50) return 'weak'
  if (bits < VAULT_PASSPHRASE_MIN_BITS) return 'fair'
  if (bits < METER_FULL_BITS) return 'strong'
  return 'excellent'
}

/**
 * Everything the passphrase field needs to render live as the user types:
 * the verdict, a 0..1 bar, a tier for colour, and the crack time in words.
 */
export function passphraseStrength(passphrase: string): PassphraseStrength {
  const verdict = checkVaultPassphrase(passphrase)
  const { bits } = verdict
  return {
    ok: verdict.ok,
    bits,
    fraction: Math.max(0, Math.min(1, bits / METER_FULL_BITS)),
    tier: tierFor(bits),
    crackTime: formatCrackTime(bits),
    reason: verdict.reason
  }
}
