# Vault Backup Prerequisite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a working backup a hard precondition for setting up a vault or depositing into one, and move recovery shares to BRC-157 so printed paper can actually rebuild the mnemonic.

**Architecture:** Backup shares stop splitting the hardened primary key and start splitting a 32-byte framed payload — `entropy(16) || sha256(entropy)[0..16]` — whose tag distinguishes new shares from legacy ones on recovery without a version marker on the paper. A new first step in the vault enrollment wizard requires the user to either reveal-and-attest their phrase or print shares, recording that in a per-wallet attestation store; `depositToVault` refuses while that store is empty.

**Tech Stack:** TypeScript, React Native (Expo), `@bsv/sdk` 2.4.0 (`Mnemonic`, `PrivateKey`, `Hash`), `expo-secure-store`, `@react-native-async-storage/async-storage`, `expo-print`, Jest (`jest-expo` preset).

**Spec:** `docs/superpowers/specs/2026-08-16-vault-backup-prerequisite-design.md`

## Global Constraints

- Payload is **always exactly 32 bytes**: `entropy(16) || sha256(entropy)[0..16]`. Left-pad to 32 on recovery, unconditionally, before inspecting anything.
- Never classify by length. `PrivateKey.toArray()` drops leading zero bytes (~1 in 256 payloads), and a 24-word phrase yields 32 bytes of entropy, identical in length to a legacy primary key.
- `Mnemonic.fromEntropy` **computes** the BIP39 checksum, so it accepts any 16 bytes. It is not a validator. Never use it as one.
- The deposit gate goes in `depositToVault` and **never** in `nextDepositKey` — partial withdrawals re-vault their remainder through `nextDepositKey`, so a gate there blocks withdrawals.
- The attestation flag is scoped per wallet identity. A global key survives Delete Wallet (which is wired straight to `logout()`), so the next wallet would be born already backed up.
- The flag is advisory. It records that a user said they wrote something down. It is not a security control and no comment or copy may imply otherwise.
- New i18n strings land in the `en` block only, inserted at the `vault_off` anchor (`context/i18n/translations.tsx:300`). The other 11 locales are backfilled in a separate machine-translation commit — the house pattern. Nothing enforces parity; a typo renders as the raw key.
- Vault components use the module-level `const t = (k, o?) => i18n.t(k, o) as string` helper, **not** `useTranslation()`.
- Colours always come inline from `useTheme()`; never hardcoded, never baked into `StyleSheet`.
- Tests assert on shape and on equality of derived values. Never assert on real key material, and never print a phrase or key to test output.
- Run the full suite with `npm test`. It must stay green; 839 tests pass on this branch today.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `services/vault/backupAttestation.ts` | Per-wallet record that a backup happened. Get/set/clear, AsyncStorage, identity-scoped. |
| `components/vault/PhraseBackupSheet.tsx` | Reveals the 12 words and takes the "I have written these down" attestation. |
| `__tests__/backupShares.test.ts` | Payload framing, classification, round-trip, leading-zero, legacy. |
| `__tests__/vault/backupAttestation.test.ts` | Scoping, clear-on-logout, corrupt-value tolerance. |

**Modified**

| File | Change |
|---|---|
| `utils/backupShares.ts` | Framing + classification; split the two producers by name. |
| `utils/printRecoveryShares.ts` | Print from entropy; return a result union; keep legacy path for WIF wallets. |
| `app/auth/scan-shares.tsx` | Classify on recovery; persist the mnemonic for v2; warn for legacy. |
| `services/vault/types.ts` | New `backup-required` error code. |
| `services/vault/transfers.ts` | Gate inside `depositToVault`. |
| `components/vault/EnrollWizard.tsx` | New `backup` first step; corrected recovery copy. |
| `app/vault-transfer.tsx` | Blocked-deposit alert; fix the broken unknown-code i18n fallback. |
| `context/WalletContext.tsx` | Clear attestations on logout. |
| `context/i18n/translations.tsx` | New `en` strings; correct the two false ones. |
| `app/auth/mnemonic.tsx` | Use the shared print util. |
| `app/wallet-config.tsx` | Use the shared print util. |
| `__tests__/vault/transfers.test.ts` | Seed the attestation; cover the gate and the withdrawal exemption. |

---

## Task 1: Share payload framing and classification

The pure crypto core. Everything else depends on it, and it is the only part with a silent-wrong-wallet failure mode, so it lands first with full coverage.

**Files:**
- Modify: `utils/backupShares.ts:1-27` (header comment and the producer)
- Test: `__tests__/backupShares.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `ENTROPY_BYTES = 16`, `PAYLOAD_BYTES = 32`
  - `frameEntropy(entropy: number[]): number[]`
  - `padPayload(bytes: number[]): number[]`
  - `type RecoveredSecret = { kind: 'entropy'; entropy: number[] } | { kind: 'legacy'; primaryKey: number[] }`
  - `classifyPayload(raw: number[]): RecoveredSecret`
  - `generateEntropyShares(entropy: number[], threshold?: number, totalShares?: number): string[]`
  - `generateLegacyKeyShares(privateKeyBytes: number[], threshold?: number, totalShares?: number): string[]`
  - `recoverSecretFromShares(shareStrings: string[]): RecoveredSecret`
  - Existing exports `parseShare` and `validateShareCompatibility` are unchanged. `generatePrintHTML` is unchanged here and gains a third parameter in Task 2.
  - `generateBackupShares` and `recoverKeyFromShares` are **deleted** — Tasks 2, 3 and 11 update every caller.

- [ ] **Step 1: Write the failing test**

Create `__tests__/backupShares.test.ts`:

```ts
/**
 * Backup share payload format (BRC-157).
 *
 * The single failure mode worth this much coverage: a misclassified payload
 * restores a DIFFERENT wallet without erroring. Length cannot arbitrate —
 * PrivateKey drops leading zero bytes, and a 24-word phrase's entropy is 32
 * bytes, the same width as a legacy primary key. The sha256 tag is what
 * decides.
 */
import { Mnemonic, PrivateKey, Hash } from '@bsv/sdk'
import {
  ENTROPY_BYTES,
  PAYLOAD_BYTES,
  frameEntropy,
  padPayload,
  classifyPayload,
  generateEntropyShares,
  generateLegacyKeyShares,
  recoverSecretFromShares
} from '../utils/backupShares'

const entropyOf = (m: Mnemonic): number[] => m.toEntropy()

describe('payload framing', () => {
  test('frames entropy to exactly 32 bytes with a sha256 tag', () => {
    const entropy = new Array(ENTROPY_BYTES).fill(7)
    const payload = frameEntropy(entropy)

    expect(payload).toHaveLength(PAYLOAD_BYTES)
    expect(payload.slice(0, ENTROPY_BYTES)).toEqual(entropy)
    expect(payload.slice(ENTROPY_BYTES)).toEqual(Hash.sha256(entropy).slice(0, 16))
  })

  test('rejects entropy that is not 16 bytes', () => {
    expect(() => frameEntropy(new Array(32).fill(1))).toThrow(/16 bytes/)
  })

  test('left-pads a truncated payload back to full width', () => {
    // PrivateKey is a BigNumber: a payload starting 0x00 comes back short.
    expect(padPayload([1, 2, 3])).toHaveLength(PAYLOAD_BYTES)
    expect(padPayload([1, 2, 3]).slice(-3)).toEqual([1, 2, 3])
    expect(padPayload([1, 2, 3]).slice(0, 29).every(b => b === 0)).toBe(true)
  })

  test('rejects an over-wide payload rather than silently truncating', () => {
    expect(() => padPayload(new Array(33).fill(1))).toThrow(/32 bytes/)
  })
})

describe('classification', () => {
  test('classifies a framed payload as entropy and returns it exactly', () => {
    const entropy = entropyOf(Mnemonic.fromRandom(128))
    const result = classifyPayload(frameEntropy(entropy))

    expect(result.kind).toBe('entropy')
    expect(result.kind === 'entropy' && result.entropy).toEqual(entropy)
  })

  test('classifies a random 32-byte private key as legacy', () => {
    for (let i = 0; i < 50; i++) {
      const key = Array.from(PrivateKey.fromRandom().toArray())
      expect(classifyPayload(key).kind).toBe('legacy')
    }
  })

  test('a corrupted tag degrades to legacy rather than yielding a wrong entropy', () => {
    const entropy = entropyOf(Mnemonic.fromRandom(128))
    const payload = frameEntropy(entropy)
    payload[PAYLOAD_BYTES - 1] ^= 0xff

    expect(classifyPayload(payload).kind).toBe('legacy')
  })

  test('recovers a truncated entropy payload correctly', () => {
    // Force a payload whose first byte is 0x00, which PrivateKey.toArray() drops.
    let entropy: number[] | null = null
    for (let i = 0; i < 5000 && entropy === null; i++) {
      const e = entropyOf(Mnemonic.fromRandom(128))
      if (e[0] === 0) entropy = e
    }
    expect(entropy).not.toBeNull()

    const truncated = frameEntropy(entropy as number[]).slice(1)
    const result = classifyPayload(truncated)

    expect(result.kind).toBe('entropy')
    expect(result.kind === 'entropy' && result.entropy).toEqual(entropy)
  })
})

describe('share round-trip', () => {
  test('entropy survives split and recombine, and rebuilds the same phrase', () => {
    const mnemonic = Mnemonic.fromRandom(128)
    const entropy = entropyOf(mnemonic)
    const shares = generateEntropyShares(entropy)

    expect(shares).toHaveLength(3)

    const result = recoverSecretFromShares(shares.slice(0, 2))
    expect(result.kind).toBe('entropy')
    expect(result.kind === 'entropy' && result.entropy).toEqual(entropy)
    expect(
      result.kind === 'entropy' && Mnemonic.fromEntropy(result.entropy).toString()
    ).toBe(mnemonic.toString())
  })

  test('any two of three shares recover the same secret', () => {
    const entropy = entropyOf(Mnemonic.fromRandom(128))
    const shares = generateEntropyShares(entropy)

    for (const pair of [[0, 1], [0, 2], [1, 2]]) {
      const r = recoverSecretFromShares([shares[pair[0]], shares[pair[1]]])
      expect(r.kind === 'entropy' && r.entropy).toEqual(entropy)
    }
  })

  test('legacy key shares still recombine and classify as legacy', () => {
    const key = Array.from(PrivateKey.fromRandom().toArray())
    const result = recoverSecretFromShares(generateLegacyKeyShares(key).slice(0, 2))

    expect(result.kind).toBe('legacy')
    expect(result.kind === 'legacy' && result.primaryKey).toEqual(key)
  })

  test('entropy and legacy shares of the same wallet carry different integrity hashes', () => {
    // This is what makes mixing v1 and v2 paper impossible; validateShareCompatibility
    // already rejects on it.
    const mnemonic = Mnemonic.fromRandom(128)
    const entropy = entropyOf(mnemonic)
    const key = Array.from(PrivateKey.fromRandom().toArray())

    const a = generateEntropyShares(entropy)[0].split('.')[3]
    const b = generateLegacyKeyShares(key)[0].split('.')[3]

    expect(a).not.toBe(b)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx jest __tests__/backupShares.test.ts
```

Expected: FAIL — `ENTROPY_BYTES`, `frameEntropy`, `padPayload`, `classifyPayload`, `generateEntropyShares`, `generateLegacyKeyShares`, `recoverSecretFromShares` are not exported from `utils/backupShares`.

- [ ] **Step 3: Replace the header comment and producer section**

In `utils/backupShares.ts`, replace lines 1-27 (the file header through the end of `generateBackupShares`) with:

```ts
/**
 * Backup shares — Shamir 2-of-3 recovery paper.
 *
 * The secret being split is the MNEMONIC ENTROPY, per BRC-157, not the primary
 * key at m/0'/0'. That derivation is hardened and one-way, so shares of it can
 * restore spending authority but can never rebuild the phrase — and the vault
 * key needs the phrase. Splitting the entropy makes paper and phrase two
 * encodings of one secret.
 *
 * The split payload is always exactly 32 bytes:
 *
 *     entropy(16) || sha256(entropy)[0..16]
 *
 * The tag exists so recovery can tell new paper from old WITHOUT a version
 * marker on the printed page, which would break every sheet already in a
 * drawer. Length cannot do that job: PrivateKey is a BigNumber and drops
 * leading zero bytes (~1 payload in 256), and an imported 24-word phrase
 * yields 32 bytes of entropy — the exact width of a legacy primary key.
 *
 * Do NOT try to validate the entropy branch by rebuilding a mnemonic and
 * checking its BIP39 checksum. Mnemonic.fromEntropy COMPUTES that checksum, so
 * it accepts any 16 bytes and can never reject a misclassification.
 */

import { PrivateKey, Hash } from '@bsv/sdk'
import QRCode from 'qrcode'

// ── Payload framing ──────────────────────────────────────────────────────────

/** Entropy of a 12-word BIP39 phrase. The only width v2 shares support. */
export const ENTROPY_BYTES = 16
/** Fixed width of the split secret. Never varies, never inferred. */
export const PAYLOAD_BYTES = 32

/** What a recombined payload turned out to be. */
export type RecoveredSecret =
  | { kind: 'entropy'; entropy: number[] }
  | { kind: 'legacy'; primaryKey: number[] }

/** Wrap 16 bytes of entropy in the tagged 32-byte payload. */
export function frameEntropy(entropy: number[]): number[] {
  if (entropy.length !== ENTROPY_BYTES) {
    throw new Error(`frameEntropy: expected ${ENTROPY_BYTES} bytes, got ${entropy.length}`)
  }
  return [...entropy, ...Hash.sha256(entropy).slice(0, PAYLOAD_BYTES - ENTROPY_BYTES)]
}

/**
 * Restore a recombined payload to full width.
 *
 * Shamir recombination yields a PrivateKey, whose toArray() drops leading zero
 * bytes. Without this pad, roughly one payload in 256 decodes short and fails
 * to match anything.
 */
export function padPayload(bytes: number[]): number[] {
  if (bytes.length > PAYLOAD_BYTES) {
    throw new Error(`padPayload: payload exceeds ${PAYLOAD_BYTES} bytes`)
  }
  return [...new Array(PAYLOAD_BYTES - bytes.length).fill(0), ...bytes]
}

/** Decide whether a recombined payload is framed entropy or a legacy key. */
export function classifyPayload(raw: number[]): RecoveredSecret {
  const payload = padPayload(raw)
  const entropy = payload.slice(0, ENTROPY_BYTES)
  const tag = payload.slice(ENTROPY_BYTES)
  const expected = Hash.sha256(entropy).slice(0, PAYLOAD_BYTES - ENTROPY_BYTES)

  return tag.every((b, i) => b === expected[i])
    ? { kind: 'entropy', entropy }
    : { kind: 'legacy', primaryKey: payload }
}

// ── Share generation ─────────────────────────────────────────────────────────

/**
 * Split mnemonic entropy into backup shares (the current format).
 * @param entropy 16 bytes, from Mnemonic.toEntropy()
 * @returns Share strings in the format base58(x).base58(y).threshold.integrity
 */
export function generateEntropyShares(
  entropy: number[],
  threshold: number = 2,
  totalShares: number = 3
): string[] {
  return new PrivateKey(frameEntropy(entropy)).toBackupShares(threshold, totalShares)
}

/**
 * Split a raw private key (the legacy format).
 *
 * Still reachable for wallets that were themselves restored from legacy paper
 * and therefore have no mnemonic to frame. Removing it would leave that cohort
 * with no way to back up at all; the tag check routes their shares back to the
 * legacy branch on recovery, so this stays self-consistent.
 */
export function generateLegacyKeyShares(
  privateKeyBytes: number[],
  threshold: number = 2,
  totalShares: number = 3
): string[] {
  return new PrivateKey(privateKeyBytes).toBackupShares(threshold, totalShares)
}
```

- [ ] **Step 4: Replace the recovery function**

In the same file, replace the `recoverKeyFromShares` block (originally lines 81-89, the JSDoc and function) with:

```ts
/**
 * Recombine shares and say what came out.
 * @param shareStrings At least `threshold` raw share strings
 * @throws If the shares are invalid or their integrity hashes disagree
 */
export function recoverSecretFromShares(shareStrings: string[]): RecoveredSecret {
  return classifyPayload(Array.from(PrivateKey.fromBackupShares(shareStrings).toArray()))
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx jest __tests__/backupShares.test.ts
```

Expected: PASS, 12 tests.

- [ ] **Step 6: Confirm the deleted exports are the only breakage**

```bash
npx tsc --noEmit 2>&1 | grep -E "generateBackupShares|recoverKeyFromShares"
```

Expected: errors in exactly `app/auth/mnemonic.tsx`, `app/wallet-config.tsx`, `app/auth/scan-shares.tsx`, `utils/printRecoveryShares.ts`. Tasks 2, 3 and 11 fix them. Do not fix them here.

- [ ] **Step 7: Commit**

```bash
git add utils/backupShares.ts __tests__/backupShares.test.ts
git commit -m "feat(backup): split mnemonic entropy in a tagged 32-byte payload"
```

---

## Task 2: Print shares from entropy

**Files:**
- Modify: `utils/printRecoveryShares.ts` (whole file)
- Test: `__tests__/printRecoveryShares.test.ts` (create)

**Interfaces:**
- Consumes: `generateEntropyShares`, `generateLegacyKeyShares` from Task 1.
- Produces:
  - `type PrintSharesResult = { ok: true; format: 'entropy' | 'legacy' } | { ok: false; reason: 'no-material' | 'unsupported-word-count' }`
  - `printRecoveryShares(sources: PrintSharesSources): Promise<PrintSharesResult>` — the boolean return is gone.
  - `PrintSharesSources` is unchanged: `{ mnemonic: string | null; recoveredKeyWif?: string | null }`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/printRecoveryShares.test.ts`:

```ts
/**
 * printRecoveryShares picks a share format from the key material it is given.
 * expo-print is mocked: this asserts the decision, not the print sheet.
 */
import { Mnemonic, PrivateKey } from '@bsv/sdk'

const printAsync = jest.fn(async () => ({ uri: 'file:///out.pdf' }))
jest.mock('expo-print', () => ({ printAsync: (...a: unknown[]) => printAsync(...a) }))

import { printRecoveryShares } from '../utils/printRecoveryShares'
import { recoverSecretFromShares, parseShare } from '../utils/backupShares'

beforeEach(() => printAsync.mockClear())

/** Pull the share strings back out of the generated HTML. */
function sharesFromHtml(html: string): string[] {
  const found = [...html.matchAll(/class="data-value share-text">([^<]+)</g)].map(m => m[1])
  return found.filter(s => parseShare(s) !== null)
}

describe('printRecoveryShares', () => {
  test('prints entropy-format shares for a 12-word wallet', async () => {
    const mnemonic = Mnemonic.fromRandom(128)
    const result = await printRecoveryShares({ mnemonic: mnemonic.toString() })

    expect(result).toEqual({ ok: true, format: 'entropy' })
    expect(printAsync).toHaveBeenCalledTimes(1)

    const html = (printAsync.mock.calls[0][0] as { html: string }).html
    const shares = sharesFromHtml(html)
    expect(shares).toHaveLength(3)

    const recovered = recoverSecretFromShares(shares.slice(0, 2))
    expect(recovered.kind).toBe('entropy')
    expect(
      recovered.kind === 'entropy' && Mnemonic.fromEntropy(recovered.entropy).toString()
    ).toBe(mnemonic.toString())
  })

  test('refuses a 24-word wallet, because 32 bytes of entropy leaves no room for the tag', async () => {
    const result = await printRecoveryShares({ mnemonic: Mnemonic.fromRandom(256).toString() })

    expect(result).toEqual({ ok: false, reason: 'unsupported-word-count' })
    expect(printAsync).not.toHaveBeenCalled()
  })

  test('prints legacy shares for a wallet that has only a recovered key', async () => {
    const wif = PrivateKey.fromRandom().toWif()
    const result = await printRecoveryShares({ mnemonic: null, recoveredKeyWif: wif })

    expect(result).toEqual({ ok: true, format: 'legacy' })

    const html = (printAsync.mock.calls[0][0] as { html: string }).html
    const recovered = recoverSecretFromShares(sharesFromHtml(html).slice(0, 2))
    expect(recovered.kind).toBe('legacy')
    expect(recovered.kind === 'legacy' && recovered.primaryKey).toEqual(
      Array.from(PrivateKey.fromWif(wif).toArray())
    )
  })

  test('reports no material rather than throwing', async () => {
    expect(await printRecoveryShares({ mnemonic: null })).toEqual({
      ok: false,
      reason: 'no-material'
    })
    expect(printAsync).not.toHaveBeenCalled()
  })

  test('prefers the mnemonic when both are present', async () => {
    const result = await printRecoveryShares({
      mnemonic: Mnemonic.fromRandom(128).toString(),
      recoveredKeyWif: PrivateKey.fromRandom().toWif()
    })
    expect(result).toEqual({ ok: true, format: 'entropy' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx jest __tests__/printRecoveryShares.test.ts
```

Expected: FAIL — `printRecoveryShares` still resolves to a boolean and still imports `generateBackupShares`.

- [ ] **Step 3: Rewrite the module**

Replace the entire contents of `utils/printRecoveryShares.ts`:

```ts
/**
 * One-tap "print my recovery shares", shared by Settings, onboarding and vault
 * enrollment.
 *
 * WHAT THESE SHARES COVER
 *
 * For a wallet with a mnemonic, the shares split the mnemonic ENTROPY
 * (BRC-157). Any two rebuild the phrase, and therefore the seed, m/0'/0', the
 * everyday balance AND the vault. The printed sheet is seed-equivalent paper —
 * treat it with the same care as the phrase itself.
 *
 * For a wallet restored from legacy paper there is no mnemonic to frame, so
 * the shares split the raw recovered key, exactly as before. Those restore
 * spending authority only and can never open a vault. That cohort cannot
 * upgrade in place; their remedy is to sweep to a fresh wallet.
 *
 * 24-word phrases are refused: their entropy is 32 bytes, which fills the
 * split secret completely and leaves no room for the tag that tells the two
 * formats apart on recovery.
 */
import { Mnemonic, PrivateKey } from '@bsv/sdk'
import * as Print from 'expo-print'
import {
  ENTROPY_BYTES,
  generateEntropyShares,
  generateLegacyKeyShares,
  generatePrintHTML
} from './backupShares'
import { recoverMnemonicWallet } from './mnemonicWallet'

export interface PrintSharesSources {
  /** The wallet mnemonic, when the wallet has one. */
  mnemonic: string | null
  /** WIF of a share-restored wallet, which has no mnemonic. */
  recoveredKeyWif?: string | null
}

export type PrintSharesResult =
  | { ok: true; format: 'entropy' | 'legacy' }
  | { ok: false; reason: 'no-material' | 'unsupported-word-count' }

/**
 * Present the print sheet for a 2-of-3 recovery share set.
 *
 * Never throws for the "cannot print" cases — callers surface the reason as a
 * message. A dismissed print sheet still rejects from expo-print and is the
 * caller's business.
 */
export async function printRecoveryShares(
  sources: PrintSharesSources
): Promise<PrintSharesResult> {
  let shares: string[]
  let identityKey: string
  let format: 'entropy' | 'legacy'

  if (sources.mnemonic) {
    const entropy = Mnemonic.fromString(sources.mnemonic).toEntropy()
    if (entropy.length !== ENTROPY_BYTES) return { ok: false, reason: 'unsupported-word-count' }

    shares = generateEntropyShares(entropy)
    identityKey = recoverMnemonicWallet(sources.mnemonic).identityKey
    format = 'entropy'
  } else if (sources.recoveredKeyWif) {
    const priv = PrivateKey.fromWif(sources.recoveredKeyWif)
    shares = generateLegacyKeyShares(Array.from(priv.toArray()))
    identityKey = priv.toPublicKey().toString()
    format = 'legacy'
  } else {
    return { ok: false, reason: 'no-material' }
  }

  await Print.printAsync({ html: await generatePrintHTML(shares, identityKey) })
  return { ok: true, format }
}
```

- [ ] **Step 4: Tell the printed page what it is carrying**

The sheet's own recovery instructions still say the shares recover "your wallet key" — true of legacy paper, an understatement for entropy paper, which is seed-equivalent. `generatePrintHTML` needs to know which it is printing.

In `utils/backupShares.ts`, widen the signature:

```ts
export async function generatePrintHTML(
  shares: string[],
  identityKey: string,
  format: 'entropy' | 'legacy' = 'entropy'
): Promise<string> {
```

Replace the `.instructions` block inside the page template:

```ts
      <div class="instructions">
        <strong>Recovery Instructions</strong>
        <p>This is 1 of ${shares.length} backup shares. You need any ${shares[0].split('.')[2]} shares to recover your wallet.</p>
        <p>Store each share in a separate, secure location. Do not store shares together.</p>
        <p>${
          format === 'entropy'
            ? 'Any two of these pages rebuild your twelve-word recovery phrase, and therefore your entire wallet — everyday balance and vault alike. Treat two pages together as you would the phrase itself.'
            : 'These shares are an older format. They restore your everyday balance but cannot open a vault.'
        }</p>
        <p>To recover: In BSV Browser, go to Enable Web3 &rarr; Import Existing Wallet &rarr; Scan Backup Shares.</p>
      </div>
```

Then pass the format from `printRecoveryShares`, replacing the print call:

```ts
  await Print.printAsync({ html: await generatePrintHTML(shares, identityKey, format) })
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx jest __tests__/printRecoveryShares.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add utils/printRecoveryShares.ts __tests__/printRecoveryShares.test.ts
git commit -m "feat(backup): print entropy-format shares, refuse 24-word phrases"
```

---

## Task 3: Restore persists the mnemonic

Without this the format change buys nothing — a restored wallet would still have no phrase and still be barred from the vault.

**Files:**
- Modify: `app/auth/scan-shares.tsx:83-125` (`handleRecovery`), plus imports at `:11` and the hook destructure at `:20-21`
- Test: covered by Task 1 and 2 units plus manual verification in Task 13. No new unit test — this function is UI-bound and its logic is one branch over already-tested primitives.

**Interfaces:**
- Consumes: `recoverSecretFromShares`, `RecoveredSecret` from Task 1.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Update the imports**

Replace line 11 of `app/auth/scan-shares.tsx`:

```tsx
import { parseShare, validateShareCompatibility, recoverSecretFromShares, ParsedShare } from '@/utils/backupShares'
```

Add below it:

```tsx
import { Mnemonic } from '@bsv/sdk'
```

- [ ] **Step 2: Widen the hook destructure**

Replace lines 20-21:

```tsx
  const { buildWalletFromRecoveredKey, buildWalletFromMnemonic } = useWallet()
  const { setRecoveredKey, setMnemonic, deleteRecoveredKey } = useLocalStorage()
```

- [ ] **Step 3: Rewrite handleRecovery**

Replace lines 83-125 with:

```tsx
  /**
   * Two formats reach this point.
   *
   * Entropy shares (current) rebuild the phrase, so the wallet is stored as a
   * mnemonic wallet — identical to one that never lost its phone. Any stale
   * recoveredKey is removed afterwards so two secrets cannot coexist and
   * disagree; it is removed only AFTER the mnemonic write succeeds, because
   * setMnemonic sits behind a biometric prompt and a refusal between the two
   * would leave no wallet at all.
   *
   * Legacy shares carry the hardened primary key and cannot rebuild the
   * phrase, so they keep the old WIF path and the user is told what that costs.
   */
  const handleRecovery = async (shareStrings: string[]) => {
    setRecovering(true)
    try {
      const secret = recoverSecretFromShares(shareStrings)

      if (secret.kind === 'entropy') {
        const mnemonic = Mnemonic.fromEntropy(secret.entropy).toString()

        const stored = await setMnemonic(mnemonic)
        if (!stored) {
          if (await retryOrReset(shareStrings)) return
          return
        }
        await deleteRecoveredKey()
        await buildWalletFromMnemonic(mnemonic)
      } else {
        const wif = new PrivateKey(secret.primaryKey).toWif()

        const stored = await setRecoveredKey(wif)
        if (!stored) {
          if (await retryOrReset(shareStrings)) return
          return
        }
        await buildWalletFromRecoveredKey(wif)

        await showAlert({
          title: t('scan_shares_legacy_title'),
          message: t('scan_shares_legacy_message'),
          buttons: [{ text: t('scan_shares_legacy_ack'), key: 'ok' }]
        })
      }

      setRecovered(true)
      setCelebrating(true)
    } catch (err: any) {
      console.error('[ScanShares] Recovery failed:', err)
      setError(err.message || t('scan_shares_recovery_failed'))
      haptics.error()
      // Allow re-scanning
      setRecovered(false)
      setScannedShares([])
      setThreshold(null)
      lastScannedRef.current = ''
    } finally {
      setRecovering(false)
    }
  }

  /**
   * Shared biometric-refusal handling for both formats.
   * @returns true when the caller should stop (the user cancelled or a retry
   * took over), false never — it always handles the outcome itself.
   */
  const retryOrReset = async (shareStrings: string[]): Promise<boolean> => {
    const choice = await showAlert({
      title: 'Biometric Access Required',
      message: 'Biometric access is needed to protect your wallet keys. Please try again.',
      buttons: [
        { text: 'Cancel', style: 'cancel', key: 'cancel' },
        { text: 'Try Again', key: 'retry' },
      ],
    })
    if (choice === 'cancel') {
      setScannedShares([])
      setThreshold(null)
      lastScannedRef.current = ''
    } else {
      await handleRecovery(shareStrings)
    }
    return true
  }
```

Add `PrivateKey` to the `@bsv/sdk` import from Step 1:

```tsx
import { Mnemonic, PrivateKey } from '@bsv/sdk'
```

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep "scan-shares"
```

Expected: no output. (`scan_shares_legacy_*` strings are added in Task 9; missing keys render as the raw key and do not fail typecheck.)

- [ ] **Step 5: Commit**

```bash
git add app/auth/scan-shares.tsx
git commit -m "feat(backup): store a restored phrase as a mnemonic wallet"
```

---

## Task 4: Backup attestation store

**Files:**
- Create: `services/vault/backupAttestation.ts`
- Test: `__tests__/vault/backupAttestation.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type BackupMedium = 'phrase' | 'shares'`
  - `interface BackupAttestation { v: 1; medium: BackupMedium; at: number }`
  - `backupAttestation.get(identityKey: string): Promise<BackupAttestation | null>`
  - `backupAttestation.set(identityKey: string, medium: BackupMedium): Promise<void>`
  - `backupAttestation.clear(identityKey: string): Promise<void>`
  - `backupAttestation.clearAll(): Promise<void>`
  - `ATTEST_KEY_PREFIX = 'vault_backup_attest_v1_'`

- [ ] **Step 1: Write the failing test**

Create `__tests__/vault/backupAttestation.test.ts`:

```ts
/**
 * The attestation records that a user SAID they wrote something down. It is
 * advisory, not a security control. What matters here is scoping: a global
 * flag would survive Delete Wallet (wired straight to logout) and the next
 * wallet on the device would be born already backed up.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

import AsyncStorage from '@react-native-async-storage/async-storage'
import { backupAttestation, ATTEST_KEY_PREFIX } from '../../services/vault/backupAttestation'

const IDENTITY_A = '02' + 'a'.repeat(62)
const IDENTITY_B = '02' + 'b'.repeat(62)

beforeEach(async () => {
  await AsyncStorage.clear()
})

describe('backupAttestation', () => {
  test('returns null before anything is recorded', async () => {
    expect(await backupAttestation.get(IDENTITY_A)).toBeNull()
  })

  test('records the medium and a timestamp', async () => {
    await backupAttestation.set(IDENTITY_A, 'phrase')
    const got = await backupAttestation.get(IDENTITY_A)

    expect(got).toMatchObject({ v: 1, medium: 'phrase' })
    expect(typeof got?.at).toBe('number')
    expect(got!.at).toBeGreaterThan(0)
  })

  test('scopes per wallet identity', async () => {
    await backupAttestation.set(IDENTITY_A, 'shares')

    expect(await backupAttestation.get(IDENTITY_B)).toBeNull()
    expect((await backupAttestation.get(IDENTITY_A))?.medium).toBe('shares')
  })

  test('the later medium replaces the earlier one', async () => {
    await backupAttestation.set(IDENTITY_A, 'shares')
    await backupAttestation.set(IDENTITY_A, 'phrase')

    expect((await backupAttestation.get(IDENTITY_A))?.medium).toBe('phrase')
  })

  test('clear removes only the named identity', async () => {
    await backupAttestation.set(IDENTITY_A, 'phrase')
    await backupAttestation.set(IDENTITY_B, 'phrase')
    await backupAttestation.clear(IDENTITY_A)

    expect(await backupAttestation.get(IDENTITY_A)).toBeNull()
    expect(await backupAttestation.get(IDENTITY_B)).not.toBeNull()
  })

  test('clearAll removes every attestation and nothing else', async () => {
    await AsyncStorage.setItem('unrelated_key', 'keep me')
    await backupAttestation.set(IDENTITY_A, 'phrase')
    await backupAttestation.set(IDENTITY_B, 'shares')

    await backupAttestation.clearAll()

    expect(await backupAttestation.get(IDENTITY_A)).toBeNull()
    expect(await backupAttestation.get(IDENTITY_B)).toBeNull()
    expect(await AsyncStorage.getItem('unrelated_key')).toBe('keep me')
  })

  test('a corrupt value reads as absent rather than throwing', async () => {
    await AsyncStorage.setItem(ATTEST_KEY_PREFIX + IDENTITY_A.slice(-8), 'not json')

    expect(await backupAttestation.get(IDENTITY_A)).toBeNull()
  })

  test('an unknown persisted version reads as absent', async () => {
    await AsyncStorage.setItem(
      ATTEST_KEY_PREFIX + IDENTITY_A.slice(-8),
      JSON.stringify({ v: 99, medium: 'phrase', at: 1 })
    )

    expect(await backupAttestation.get(IDENTITY_A)).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx jest __tests__/vault/backupAttestation.test.ts
```

Expected: FAIL — cannot find module `services/vault/backupAttestation`.

- [ ] **Step 3: Write the implementation**

Create `services/vault/backupAttestation.ts`:

```ts
/**
 * Did this wallet's owner back up?
 *
 * This is an ADVISORY record, not a security control. It stores the fact that
 * a user pressed "I have written these down" or completed a print — nothing
 * verifies that paper exists. It gates the vault because inviting someone to
 * lock funds behind a hardware key with no recovery path is a lie, not because
 * the flag protects anything.
 *
 * Scoped per wallet identity ON PURPOSE. Logout clears only four keys and
 * "Delete Wallet" is wired straight to logout(), so a global key would survive
 * a wipe and the next wallet on the device would be born already backed up.
 *
 * Follows vaultStore's conventions: a frozen object literal with async
 * accessors, a numeric `v` discriminant, and getters that swallow parse errors
 * and return null instead of throwing.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'

export const ATTEST_KEY_PREFIX = 'vault_backup_attest_v1_'

export type BackupMedium = 'phrase' | 'shares'

export interface BackupAttestation {
  v: 1
  /** Which route the user took. Both are equivalent for recovery. */
  medium: BackupMedium
  at: number
}

/** Last 8 hex chars of the identity key — the app's established scope suffix. */
const scopeKey = (identityKey: string): string => ATTEST_KEY_PREFIX + identityKey.slice(-8)

export const backupAttestation = {
  async get(identityKey: string): Promise<BackupAttestation | null> {
    const raw = await AsyncStorage.getItem(scopeKey(identityKey))
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as BackupAttestation
      return parsed?.v === 1 ? parsed : null
    } catch {
      return null
    }
  },

  async set(identityKey: string, medium: BackupMedium): Promise<void> {
    const record: BackupAttestation = { v: 1, medium, at: Date.now() }
    await AsyncStorage.setItem(scopeKey(identityKey), JSON.stringify(record))
  },

  async clear(identityKey: string): Promise<void> {
    await AsyncStorage.removeItem(scopeKey(identityKey))
  },

  /** Logout has no identity key to hand, so sweep the prefix. */
  async clearAll(): Promise<void> {
    const keys = await AsyncStorage.getAllKeys()
    const mine = keys.filter(k => k.startsWith(ATTEST_KEY_PREFIX))
    if (mine.length > 0) await AsyncStorage.multiRemove(mine)
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx jest __tests__/vault/backupAttestation.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add services/vault/backupAttestation.ts __tests__/vault/backupAttestation.test.ts
git commit -m "feat(vault): record a per-wallet backup attestation"
```

---

## Task 5: Clear attestations on logout

**Files:**
- Modify: `context/WalletContext.tsx:1713-1729` (`logout`)

**Interfaces:**
- Consumes: `backupAttestation.clearAll` from Task 4.
- Produces: nothing.

- [ ] **Step 1: Add the import**

Next to the other vault imports in `context/WalletContext.tsx`, add:

```tsx
import { backupAttestation } from '@/services/vault/backupAttestation'
```

- [ ] **Step 2: Clear inside logout**

In the `logout` callback, immediately after `deleteRecoveredKey()`, add:

```tsx
      // The attestation is per wallet. "Delete Wallet" routes here, so leaving
      // it behind would let the NEXT wallet on this device inherit a backup it
      // never made.
      backupAttestation.clearAll()
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep "WalletContext"
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add context/WalletContext.tsx
git commit -m "fix(vault): drop backup attestations on logout"
```

---

## Task 6: Gate deposits

**Files:**
- Modify: `services/vault/types.ts:24-52` (`VaultErrorCode`)
- Modify: `services/vault/transfers.ts:225-232` (`depositToVault` preamble) and the import block at `:40-42`
- Test: `__tests__/vault/transfers.test.ts` — update `makeFakeWallet`, seed the existing deposit tests, add gate coverage

**Interfaces:**
- Consumes: `backupAttestation` from Task 4.
- Produces: `VaultErrorCode` gains `'backup-required'`.

- [ ] **Step 1: Add the error code**

In `services/vault/types.ts`, inside the `VaultErrorCode` union, after `| 'bad-derivation-index'`:

```ts
  /** No backup attestation for this wallet — depositing would create funds
   *  with no recovery path. Advisory gate, not a security control. */
  | 'backup-required'
```

- [ ] **Step 2: Write the failing tests**

In `__tests__/vault/transfers.test.ts`, first make the fake wallet answer identity queries. Replace its `getPublicKey`:

```ts
    async getPublicKey(args: any) {
      if (args.identityKey) return { publicKey: IDENTITY_KEY }
      return { publicKey: derivedPubHex(args.keyID) }
    },
```

Add the constant next to `ADMIN` near the top of the file:

```ts
const IDENTITY_KEY = '02' + 'f'.repeat(62)
```

Import the store next to the `vaultStore` import:

```ts
import { backupAttestation } from '../../services/vault/backupAttestation'
```

Then replace the whole `describe('depositToVault', ...)` block:

```ts
describe('depositToVault', () => {
  test('builds a P2PKH output in the admin vault basket and drains the queue', async () => {
    await enrollFakeMeta()
    await backupAttestation.set(IDENTITY_KEY, 'phrase')
    const w = makeFakeWallet()
    const { txid } = await depositToVault(w, ADMIN, 5000)
    expect(txid).toBeDefined()
    const args = w.calls.createAction[0] as any
    expect(args.outputs[0].basket).toBe(VAULT_BASKET)
    expect(args.outputs[0].satoshis).toBe(5000)
    expect(JSON.parse(args.outputs[0].customInstructions).keyID).toBe('vault/0')
    expect(args.labels).toEqual(['vault', 'vault-deposit'])
    // queue drained by one
    expect(((await vaultStore.getMeta()) as VaultMetaV1).depositKeys[0].keyID).toBe('vault/1')
  })

  test('rejects a below-dust deposit', async () => {
    await enrollFakeMeta()
    await backupAttestation.set(IDENTITY_KEY, 'phrase')
    await expect(depositToVault(makeFakeWallet(), ADMIN, 100)).rejects.toMatchObject({
      code: 'below-dust'
    })
  })

  test('refuses to deposit when the wallet has no backup attestation', async () => {
    await enrollFakeMeta()
    const w = makeFakeWallet()

    await expect(depositToVault(w, ADMIN, 5000)).rejects.toMatchObject({
      code: 'backup-required'
    })
    expect(w.calls.createAction).toBeUndefined()
  })

  test('checks the backup before spending the deposit index', async () => {
    // A refused deposit must not burn a deposit key: the index is monotonic and
    // never reused, so a gate that ran late would leak addresses on every
    // blocked attempt.
    await enrollFakeMeta()
    await expect(depositToVault(makeFakeWallet(), ADMIN, 5000)).rejects.toMatchObject({
      code: 'backup-required'
    })
    expect(((await vaultStore.getMeta()) as VaultMetaV1).depositKeys[0].keyID).toBe('vault/0')
  })

  test('an attestation for a different wallet does not unlock this one', async () => {
    await enrollFakeMeta()
    await backupAttestation.set('02' + '9'.repeat(62), 'phrase')
    await expect(depositToVault(makeFakeWallet(), ADMIN, 5000)).rejects.toMatchObject({
      code: 'backup-required'
    })
  })
})
```

Add a withdrawal-exemption test at the end of the `describe('withdrawFromVault', ...)` block. Copy the setup from the existing partial-withdrawal test in that block verbatim, omit any `backupAttestation.set` call, and assert it succeeds:

```ts
  test('a partial withdrawal still re-vaults its remainder with no attestation', async () => {
    // Regression guard: nextDepositKey is the funnel for the re-vaulted
    // remainder as well as for deposits. Gating there would block most
    // WITHDRAWALS — locking users out of their own money is the exact failure
    // this feature exists to prevent. Note the absent backupAttestation.set.
    await enrollFakeMeta()
    const fx = vaultOutputsFixture() // two 6000-sat outputs = 12000
    const w = makeFakeWallet({
      async listOutputs() {
        return { outputs: fx.map(({ src: _s, ...o }) => o), BEEF: stitchBeef(fx) }
      },
      async createAction(args: any) {
        const tx = new Transaction()
        for (const inp of args.inputs) {
          const f = fx.find(x => x.outpoint === inp.outpoint)!
          tx.addInput({ sourceTransaction: f.src, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new UnlockingScript([]) })
        }
        for (const out of args.outputs) tx.addOutput({ satoshis: out.satoshis, lockingScript: P2PKH.prototype.lock.call(new P2PKH(), Utils.toArray(derivedPkh('vault/50'), 'hex')) })
        return { signableTransaction: { tx: tx.toAtomicBEEF(), reference: 'ref-gate' } }
      }
    })

    await withdrawFromVault(w, ADMIN, 5000, 'Withdraw 5000')

    const ca = w.calls.createAction[0] as any
    expect(ca.outputs).toHaveLength(1)
    expect(ca.outputs[0].basket).toBe(VAULT_BASKET)
    expect(ca.outputs[0].satoshis).toBe(1000)
  })
```

`vaultOutputsFixture` is defined at the top of the `withdrawFromVault` describe block, so this test must live inside that block.

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npx jest __tests__/vault/transfers.test.ts -t "backup"
```

Expected: FAIL — deposits still succeed without an attestation, so `backup-required` is never thrown.

- [ ] **Step 4: Implement the gate**

In `services/vault/transfers.ts`, add to the import block:

```ts
import { backupAttestation } from './backupAttestation'
```

Then replace the first two lines of `depositToVault`'s body:

```ts
  if (satoshis < DUST_LIMIT) throw new VaultError('below-dust', 'Deposit below dust limit')

  // Depositing into a wallet with no recovery path would hide funds behind a
  // hardware key the user cannot get past. Advisory — the wizard is the real
  // gate — but it also covers the deep link straight to the transfer screen.
  //
  // DELIBERATELY NOT in nextDepositKey, even though that is the single funnel
  // for every vault-basket output: partial withdrawals re-vault their
  // remainder through it, so a check there would block withdrawals.
  //
  // Checked BEFORE nextDepositKey so a refusal does not burn a deposit index.
  const { publicKey: identityKey } = await w.getPublicKey({ identityKey: true }, adminOriginator)
  if (!(await backupAttestation.get(identityKey))) {
    throw new VaultError('backup-required', 'Back up this wallet before depositing')
  }

  const key = await nextDepositKey()
```

- [ ] **Step 5: Fill in the withdrawal-exemption test**

Replace the placeholder body written in Step 2 with the copied setup and assertions described in its comment. The test must exercise a withdrawal whose selected inputs exceed the requested amount by at least `DUST_LIMIT`, so the re-vault path runs.

- [ ] **Step 6: Run the suite to verify it passes**

```bash
npx jest __tests__/vault/transfers.test.ts
```

Expected: PASS, all tests including the four new ones.

- [ ] **Step 7: Commit**

```bash
git add services/vault/types.ts services/vault/transfers.ts __tests__/vault/transfers.test.ts
git commit -m "feat(vault): refuse deposits until the wallet is backed up"
```

---

## Task 7: Phrase reveal sheet

**Files:**
- Create: `components/vault/PhraseBackupSheet.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `PhraseBackupSheet: React.FC<{ mnemonic: string; onAttest: () => void; onCancel: () => void }>`

- [ ] **Step 1: Write the component**

Create `components/vault/PhraseBackupSheet.tsx`:

```tsx
/**
 * Reveals the recovery phrase and takes the user's word that they wrote it
 * down.
 *
 * No verification quiz by design: the person needs to be held accountable, but
 * verification should not be painful. The confirm is an attestation, and the
 * caller records it as such.
 *
 * The caller is responsible for reading the mnemonic out of secure storage —
 * getMnemonic() is already behind the biometric latch, so this component never
 * touches storage and never holds the phrase beyond its own mount.
 */
import React, { useState } from 'react'
import { View, Text, StyleSheet, ScrollView } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import Clipboard from '@react-native-clipboard/clipboard'
import PressableScale from '@/components/ui/PressableScale'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { showToast } from '@/components/ui/Toast'
import i18n from '@/context/i18n/translations'

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string

export const PhraseBackupSheet: React.FC<{
  mnemonic: string
  onAttest: () => void
  onCancel: () => void
}> = ({ mnemonic, onAttest, onCancel }) => {
  const { colors } = useTheme()
  const [acknowledged, setAcknowledged] = useState(false)
  const words = mnemonic.trim().split(/\s+/)

  return (
    <ScrollView contentContainerStyle={styles.body}>
      <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_phrase_title')}</Text>
      <Text style={[styles.p, { color: colors.textSecondary }]}>{t('vault_phrase_intro')}</Text>

      <View style={[styles.grid, { borderColor: colors.separator }]}>
        {words.map((word, i) => (
          <View key={i} style={[styles.wordCell, { backgroundColor: colors.backgroundSecondary }]}>
            <Text style={[styles.wordIndex, { color: colors.textTertiary }]}>{i + 1}</Text>
            <Text style={[styles.word, { color: colors.textPrimary }]}>{word}</Text>
          </View>
        ))}
      </View>

      <PressableScale
        onPress={() => {
          Clipboard.setString(mnemonic)
          showToast(t('vault_phrase_copied'), { type: 'success' })
        }}
        style={[styles.ghost, { borderColor: colors.separator }]}
      >
        <Ionicons name="copy-outline" size={16} color={colors.info} />
        <Text style={[styles.ghostLabel, { color: colors.info }]}>{t('vault_phrase_copy')}</Text>
      </PressableScale>

      <View style={[styles.warnBox, { borderColor: colors.warning }]}>
        <Ionicons name="warning-outline" size={16} color={colors.warning} />
        <Text style={[styles.warnText, { color: colors.textSecondary }]}>
          {t('vault_phrase_warning')}
        </Text>
      </View>

      <PressableScale onPress={() => setAcknowledged(a => !a)} style={styles.checkRow}>
        <Ionicons
          name={acknowledged ? 'checkbox' : 'square-outline'}
          size={22}
          color={acknowledged ? colors.accent : colors.textTertiary}
        />
        <Text style={[styles.checkLabel, { color: colors.textPrimary }]}>
          {t('vault_phrase_attest')}
        </Text>
      </PressableScale>

      <PressableScale
        haptic="confirm"
        onPress={acknowledged ? onAttest : undefined}
        style={[
          styles.primary,
          {
            backgroundColor: acknowledged ? colors.accent : colors.backgroundSecondary,
            opacity: acknowledged ? 1 : 0.6
          }
        ]}
      >
        <Text
          style={[
            styles.primaryLabel,
            { color: acknowledged ? colors.textOnAccent : colors.textTertiary }
          ]}
        >
          {t('vault_phrase_done')}
        </Text>
      </PressableScale>

      <PressableScale onPress={onCancel} style={styles.secondary}>
        <Text style={[styles.secondaryLabel, { color: colors.textSecondary }]}>
          {t('vault_back')}
        </Text>
      </PressableScale>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  body: { padding: spacing.xl, gap: spacing.lg },
  h1: { ...typography.title2, textAlign: 'center' },
  p: { ...typography.subhead, textAlign: 'center' },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md
  },
  wordCell: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.xs,
    borderRadius: radii.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    minWidth: '30%'
  },
  wordIndex: { ...typography.caption2 },
  word: { ...typography.body, fontWeight: '600' },
  ghost: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.md
  },
  ghostLabel: { ...typography.footnote, fontWeight: '600' },
  warnBox: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md
  },
  warnText: { ...typography.footnote, flex: 1 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  checkLabel: { ...typography.footnote, flex: 1 },
  primary: {
    width: '100%',
    borderRadius: radii.md,
    paddingVertical: spacing.lg,
    alignItems: 'center'
  },
  primaryLabel: { ...typography.headline },
  secondary: { paddingVertical: spacing.md, alignItems: 'center' },
  secondaryLabel: { ...typography.body }
})
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep "PhraseBackupSheet"
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add components/vault/PhraseBackupSheet.tsx
git commit -m "feat(vault): add the phrase reveal and attestation sheet"
```

---

## Task 8: The backup step in the wizard

**Files:**
- Modify: `components/vault/EnrollWizard.tsx` — `Step` union at `:31`, state and callbacks at `:44-98`, the `intro` block at `:146-201`, `RecoveryPaths` at `:316-341`, styles at `:343`

**Interfaces:**
- Consumes: `PhraseBackupSheet` (Task 7), `backupAttestation` (Task 4), `printRecoveryShares` returning `PrintSharesResult` (Task 2).
- Produces: nothing.

- [ ] **Step 1: Extend the Step union and imports**

Replace line 31:

```tsx
type Step = 'backup' | 'phrase' | 'intro' | 'passphrase' | 'running' | 'done'
```

Add to the imports:

```tsx
import { PhraseBackupSheet } from './PhraseBackupSheet'
import { backupAttestation, type BackupMedium } from '@/services/vault/backupAttestation'
import { useWallet } from '@/context/WalletContext'
```

- [ ] **Step 2: Add state and load the existing attestation**

Replace line 46 (`const [step, setStep] = useState<Step>('intro')`) with:

```tsx
  const [step, setStep] = useState<Step>('backup')
  const [medium, setMedium] = useState<BackupMedium | null>(null)
  const [revealed, setRevealed] = useState<string | null>(null)
```

Add `useEffect` to the React import on line 13, then add below the state block:

```tsx
  const { managers, adminOriginator } = useWallet()

  /** The wallet identity is the attestation's scope key. */
  const identity = useCallback(async (): Promise<string | null> => {
    const r = await managers?.permissionsManager?.getPublicKey(
      { identityKey: true },
      adminOriginator
    )
    return r?.publicKey ?? null
  }, [managers, adminOriginator])

  // A user who already backed up on a previous visit should not be asked twice.
  useEffect(() => {
    let alive = true
    void (async () => {
      const key = await identity()
      if (!key) return
      const existing = await backupAttestation.get(key)
      if (alive && existing) setMedium(existing.medium)
    })()
    return () => {
      alive = false
    }
  }, [identity])

  const attest = useCallback(
    async (m: BackupMedium) => {
      const key = await identity()
      if (key) await backupAttestation.set(key, m)
      setMedium(m)
    },
    [identity]
  )
```

- [ ] **Step 3: Rewrite the print handler to use the result union**

Replace `onPrintShares` (lines 70-84):

```tsx
  const onPrintShares = useCallback(async () => {
    if (printing) return
    setPrinting(true)
    try {
      const result = await printRecoveryShares({
        mnemonic: await getMnemonic(),
        recoveredKeyWif: await getRecoveredKey?.()
      })
      if (result.ok) {
        // Only a resolved print sheet counts. A cancelled one produced no paper.
        await attest('shares')
      } else if (result.reason === 'unsupported-word-count') {
        showToast(t('vault_shares_word_count'), { type: 'error' })
      } else {
        showToast(t('vault_shares_unavailable'), { type: 'error' })
      }
    } catch {
      // Print sheet dismissed or unavailable — not an error worth blocking on.
    } finally {
      setPrinting(false)
    }
  }, [printing, getMnemonic, getRecoveredKey, attest])
```

- [ ] **Step 4: Add the phrase-reveal handler**

Add below `onPrintShares`:

```tsx
  const onRevealPhrase = useCallback(async () => {
    setError(null)
    // getMnemonic() is behind the biometric latch, so the reveal is
    // re-authenticated without a second prompt of our own.
    const mnemonic = await getMnemonic()
    if (!mnemonic) {
      setError(t('vault_requires_mnemonic'))
      haptics.error()
      return
    }
    setRevealed(mnemonic)
    setStep('phrase')
  }, [getMnemonic])
```

- [ ] **Step 5: Add the backup step render**

Insert immediately before the `// ── intro ──` comment on line 145:

```tsx
  // ── backup (prerequisite) ───────────────────────────────────────────
  if (step === 'backup') {
    return (
      <ScrollView contentContainerStyle={styles.body}>
        <Ionicons
          name="shield-checkmark-outline"
          size={48}
          color={colors.textPrimary}
          style={styles.hero}
        />
        <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_backup_title')}</Text>
        <Text style={[styles.p, { color: colors.textSecondary }]}>{t('vault_backup_intro')}</Text>

        <BackupRow
          icon="document-text-outline"
          title={t('vault_backup_phrase_title')}
          subtitle={t('vault_backup_phrase_sub')}
          done={medium === 'phrase'}
          busy={false}
          onPress={onRevealPhrase}
        />
        <BackupRow
          icon="print-outline"
          title={t('vault_backup_shares_title')}
          subtitle={t('vault_backup_shares_sub')}
          done={medium === 'shares'}
          busy={printing}
          onPress={onPrintShares}
        />

        <Text style={[styles.fine, { color: colors.textTertiary }]}>
          {t('vault_backup_either_note')}
        </Text>

        {error && <Text style={[styles.err, { color: colors.error }]}>{error}</Text>}
        <PressableScale
          haptic="confirm"
          onPress={medium ? () => setStep('intro') : undefined}
          style={[
            styles.primary,
            {
              backgroundColor: medium ? colors.accent : colors.backgroundSecondary,
              opacity: medium ? 1 : 0.6
            }
          ]}
        >
          <Text
            style={[
              styles.primaryLabel,
              { color: medium ? colors.textOnAccent : colors.textTertiary }
            ]}
          >
            {t('vault_continue')}
          </Text>
        </PressableScale>
        <PressableScale onPress={onCancel} style={styles.secondary}>
          <Text style={[styles.secondaryLabel, { color: colors.textSecondary }]}>
            {t('vault_cancel')}
          </Text>
        </PressableScale>
      </ScrollView>
    )
  }

  // ── phrase reveal ───────────────────────────────────────────────────
  if (step === 'phrase' && revealed) {
    return (
      <PhraseBackupSheet
        mnemonic={revealed}
        onAttest={async () => {
          await attest('phrase')
          setRevealed(null)
          setStep('backup')
        }}
        onCancel={() => {
          setRevealed(null)
          setStep('backup')
        }}
      />
    )
  }
```

- [ ] **Step 6: Strip the print button out of the intro step**

In the `intro` block, delete the `PressableScale` calling `onPrintShares` and the `vault_print_shares_note` `Text` beneath it (originally lines 167-182). The `RecoveryPaths` card and everything else stay. Then point the intro's Back affordance at the new first step by replacing the `onCancel` on line 194:

```tsx
        <PressableScale onPress={() => setStep('backup')} style={styles.secondary}>
          <Text style={[styles.secondaryLabel, { color: colors.textSecondary }]}>
            {t('vault_back')}
          </Text>
        </PressableScale>
```

- [ ] **Step 7: Add the BackupRow component**

Insert immediately above `const RecoveryPaths` (line 316):

```tsx
/** One backup route: tappable, ticks when satisfied, stays tappable after. */
const BackupRow: React.FC<{
  icon: React.ComponentProps<typeof Ionicons>['name']
  title: string
  subtitle: string
  done: boolean
  busy: boolean
  onPress: () => void
}> = ({ icon, title, subtitle, done, busy, onPress }) => {
  const { colors } = useTheme()
  return (
    <PressableScale
      onPress={busy ? undefined : onPress}
      style={[styles.backupRow, { borderColor: done ? colors.success : colors.separator }]}
    >
      {busy ? (
        <ActivityIndicator color={colors.info} size="small" />
      ) : (
        <Ionicons name={icon} size={22} color={done ? colors.success : colors.info} />
      )}
      <View style={styles.backupRowText}>
        <Text style={[styles.backupRowTitle, { color: colors.textPrimary }]}>{title}</Text>
        <Text style={[styles.backupRowSub, { color: colors.textSecondary }]}>{subtitle}</Text>
      </View>
      {done && <Ionicons name="checkmark-circle" size={20} color={colors.success} />}
    </PressableScale>
  )
}
```

- [ ] **Step 8: Correct the RecoveryPaths doc comment**

Replace line 316's comment (`/** The two — and only two — ways to get vault funds back. */`) with:

```tsx
/**
 * The two ways to get vault funds back.
 *
 * Backup shares now split the mnemonic entropy (BRC-157), so paper reaches the
 * phrase path rather than being a dead end — the copy says "phrase or shares"
 * for that reason.
 */
```

- [ ] **Step 9: Add the row styles**

Add to the `StyleSheet.create` block:

```tsx
  backupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg
  },
  backupRowText: { flex: 1, gap: spacing.xs },
  backupRowTitle: { ...typography.headline },
  backupRowSub: { ...typography.footnote },
```

- [ ] **Step 10: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep -E "EnrollWizard|PhraseBackupSheet"
```

Expected: no output. (`colors.success` exists in both palettes — `context/theme/tokens.ts:104` and `:152`.)

- [ ] **Step 11: Commit**

```bash
git add components/vault/EnrollWizard.tsx
git commit -m "feat(vault): require a backup before enrollment can proceed"
```

---

## Task 9: Copy

Three existing strings assert that shares cannot open the vault. Under BRC-157 that is false, and leaving it would tell users their vault backup is worthless.

**Files:**
- Modify: `context/i18n/translations.tsx:190-205` (corrections) and `:300` (new keys at the `vault_off` anchor)

**Interfaces:**
- Consumes: key names referenced by Tasks 3, 8 and 10.
- Produces: the `en` strings those tasks render.

- [ ] **Step 1: Correct the false strings**

In the `en` block, replace `vault_recovery_path_phrase` (lines 193-194):

```tsx
      vault_recovery_path_phrase:
        'Your wallet recovery phrase — or your backup shares, which rebuild it — plus the vault passphrase you are about to choose.',
```

Delete `vault_print_shares_note` (lines 201-202) entirely, along with the three-line comment above `vault_print_shares_cta` (lines 197-199). Replace that comment with:

```tsx
      // Backup shares split the mnemonic ENTROPY (BRC-157), so any two rebuild
      // the phrase — and therefore the vault. The printed sheet is
      // seed-equivalent paper.
```

Keep `vault_print_shares_cta` — Task 11 still uses it in Settings.

- [ ] **Step 2: Add the new strings**

In the `en` block only, immediately after `vault_off: 'Off',` (line 300):

```tsx

      // Backup prerequisite — a vault with no recovery path is worse than no
      // vault, so this step gates enrollment and deposits.
      vault_backup_title: 'Back up before you lock anything away',
      vault_backup_intro:
        'The vault protects your funds from someone holding your phone. It cannot protect them from losing it. Do one of these first.',
      vault_backup_phrase_title: 'Write down your recovery phrase',
      vault_backup_phrase_sub: 'Twelve words, on paper, somewhere only you can reach.',
      vault_backup_shares_title: 'Print recovery shares',
      vault_backup_shares_sub: 'Three pages. Any two recover everything — store them apart.',
      vault_backup_either_note:
        'Either one is enough. Both restore your whole wallet, vault included.',
      vault_shares_word_count:
        'Recovery shares support twelve-word phrases only. Write your phrase down instead.',

      // Phrase reveal
      vault_phrase_title: 'Your recovery phrase',
      vault_phrase_intro: 'Write these twelve words down in order. Do not photograph them.',
      vault_phrase_copy: 'Copy to clipboard',
      vault_phrase_copied: 'Copied',
      vault_phrase_warning:
        'Anyone with these words owns everything in this wallet, including the vault. Nobody can reset them for you.',
      vault_phrase_attest: 'I have written these down and stored them safely.',
      vault_phrase_done: 'Done',

      // Deposit gate
      vault_err_backup_required:
        'Back up this wallet before moving funds into the vault.',
      vault_deposit_blocked_title: 'Back up first',
      vault_deposit_blocked_message:
        'This wallet has no recovery backup. If you lost this phone right now, the funds in the vault would be gone for good.',
      vault_deposit_blocked_cta: 'Back up now',
      vault_deposit_blocked_dismiss: 'Not now',

      // Legacy backup shares
      scan_shares_legacy_title: 'Older backup format',
      scan_shares_legacy_message:
        'These shares are an older format that restores your everyday balance but cannot open a vault. If you still have your twelve-word recovery phrase, restore from that instead — it recovers everything — and print fresh shares afterwards. If the phrase is gone, send your funds to a new wallet and start again.',
      scan_shares_legacy_ack: 'I understand',
```

- [ ] **Step 3: Verify every referenced key resolves**

```bash
for k in vault_backup_title vault_backup_intro vault_backup_phrase_title \
  vault_backup_phrase_sub vault_backup_shares_title vault_backup_shares_sub \
  vault_backup_either_note vault_shares_word_count vault_phrase_title \
  vault_phrase_intro vault_phrase_copy vault_phrase_copied vault_phrase_warning \
  vault_phrase_attest vault_phrase_done vault_err_backup_required \
  vault_deposit_blocked_title vault_deposit_blocked_message vault_deposit_blocked_cta \
  vault_deposit_blocked_dismiss scan_shares_legacy_title scan_shares_legacy_message \
  scan_shares_legacy_ack; do
  grep -q "      $k:" context/i18n/translations.tsx || echo "MISSING: $k"
done
```

Expected: no output.

- [ ] **Step 4: Confirm the false string is gone**

```bash
grep -n "cannot open the vault" context/i18n/translations.tsx
```

Expected: no output from the `en` block. Other locales still carry translated copies of `vault_print_shares_note`; leave them — the key is unused and the backfill commit removes them.

- [ ] **Step 5: Commit**

```bash
git add context/i18n/translations.tsx
git commit -m "feat(vault): copy for the backup step, and correct the share claims"
```

---

## Task 10: Blocked-deposit surfacing

The transfer screen renders errors as one inline red footnote, and its fallback for unknown codes is broken — `t()` returns the key itself for a missing string, which is truthy, so `|| t('vault_err_generic')` never fires and a raw key ships to the user.

**Files:**
- Modify: `app/vault-transfer.tsx:76-88` (the catch block)

**Interfaces:**
- Consumes: `vault_err_backup_required` and the `vault_deposit_blocked_*` strings from Task 9.
- Produces: nothing.

- [ ] **Step 1: Add the imports**

```tsx
import { showAlert } from '@/components/ui/AlertCard'
```

- [ ] **Step 2: Replace the catch block**

Replace lines 76-88 of `app/vault-transfer.tsx`:

```tsx
    } catch (e) {
      console.error('[vault] transfer failed:', e instanceof Error ? e.message : e, e)
      const code = e instanceof VaultError ? e.code : undefined

      if (code === 'backup-required') {
        // A blocked deposit needs a route out, not a red footnote. Matches the
        // disable-while-funded pattern on the vault screen.
        haptics.error()
        const choice = await showAlert({
          title: t('vault_deposit_blocked_title'),
          message: t('vault_deposit_blocked_message'),
          buttons: [
            { text: t('vault_deposit_blocked_dismiss'), style: 'cancel', key: 'cancel' },
            { text: t('vault_deposit_blocked_cta'), key: 'backup' }
          ]
        })
        if (choice === 'backup') router.replace('/vault')
        return
      }

      setError(translateVaultError(code))
      haptics.error()
    } finally {
```

- [ ] **Step 3: Add the fallback helper**

Add above the component:

```tsx
/**
 * i18next returns the KEY itself when a string is missing, and a key is
 * truthy — so the old `t(...) || t('vault_err_generic')` fallback never fired
 * and shipped raw keys like `vault_err_backup_required` to the screen.
 */
function translateVaultError(code: string | undefined): string {
  if (!code) return t('vault_err_generic')
  const key = `vault_err_${code.replace(/-/g, '_')}`
  const translated = t(key)
  return translated === key ? t('vault_err_generic') : translated
}
```

This file already imports the i18n singleton at module scope (`app/vault-transfer.tsx:35`), so the helper sits beside the component rather than inside it.

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep "vault-transfer"
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add app/vault-transfer.tsx
git commit -m "fix(vault): surface a blocked deposit and repair the error fallback"
```

---

## Task 11: Collapse the duplicate share producers

Three call sites generate shares. Two inline the whole pipeline and would keep minting legacy paper.

**Files:**
- Modify: `app/auth/mnemonic.tsx:124-137`
- Modify: `app/wallet-config.tsx:130-161`

**Interfaces:**
- Consumes: `printRecoveryShares` returning `PrintSharesResult` (Task 2).
- Produces: nothing.

- [ ] **Step 1: Replace the onboarding handler**

In `app/auth/mnemonic.tsx`, replace `handlePrintRecoveryShares` with:

```tsx
  const handlePrintRecoveryShares = async () => {
    if (isPrinting) return
    setIsPrinting(true)
    try {
      const result = await printRecoveryShares({ mnemonic, recoveredKeyWif: null })
      if (!result.ok) {
        showToast(
          result.reason === 'unsupported-word-count'
            ? t('vault_shares_word_count')
            : t('vault_shares_unavailable'),
          { type: 'error' }
        )
      }
    } catch (error: any) {
      console.info('[Mnemonic] Print recovery shares did not complete:', error?.message)
    } finally {
      setIsPrinting(false)
    }
  }
```

Replace the `generateBackupShares` / `generatePrintHTML` / `Print` imports with:

```tsx
import { printRecoveryShares } from '@/utils/printRecoveryShares'
```

Remove `recoverMnemonicWallet`, `expo-print` and `backupShares` imports if nothing else in the file uses them — check with `grep -n "recoverMnemonicWallet\|Print\.\|backupShares" app/auth/mnemonic.tsx` before deleting each.

- [ ] **Step 2: Replace the settings handler**

In `app/wallet-config.tsx`, replace `handlePrintRecoveryShares` with:

```tsx
  const handlePrintRecoveryShares = async () => {
    if (isPrinting) return
    setIsPrinting(true)
    try {
      const result = await printRecoveryShares({
        mnemonic: await getMnemonic(),
        recoveredKeyWif: await getRecoveredKey()
      })
      if (!result.ok) {
        showToast(
          result.reason === 'unsupported-word-count'
            ? t('vault_shares_word_count')
            : 'Unable to access wallet key. Please authenticate and try again.',
          { type: 'error' }
        )
      }
    } catch (error: any) {
      console.info('[WalletConfig] Print recovery shares did not complete:', error?.message)
    } finally {
      setIsPrinting(false)
    }
  }
```

Apply the same import cleanup as Step 1.

- [ ] **Step 3: Verify no producer survives outside the util**

```bash
grep -rn "toBackupShares\|generateEntropyShares\|generateLegacyKeyShares" app/ components/ utils/
```

Expected: matches only in `utils/backupShares.ts` and `utils/printRecoveryShares.ts`.

- [ ] **Step 4: Typecheck and run the full suite**

```bash
npx tsc --noEmit && npm test
```

Expected: clean typecheck; all tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/auth/mnemonic.tsx app/wallet-config.tsx
git commit -m "refactor(backup): route every share producer through one util"
```

---

## Task 12: Full verification pass

**Files:** none modified.

- [ ] **Step 1: Typecheck, lint, test**

```bash
npx tsc --noEmit && npx eslint . --ext .ts,.tsx && npm test
```

Expected: all clean. The suite was 839 tests before this work; it should now be roughly 864 and fully green.

- [ ] **Step 2: Confirm the gate placement by inspection**

```bash
grep -n "backupAttestation" services/vault/transfers.ts
```

Expected: exactly two lines — the import, and the check inside `depositToVault`. **Any match inside `nextDepositKey` is a bug** that blocks withdrawals.

- [ ] **Step 3: Confirm no stale API survives**

```bash
grep -rn "generateBackupShares\|recoverKeyFromShares" app/ components/ utils/ services/ __tests__/
```

Expected: no output.

- [ ] **Step 4: Manual verification on the simulator**

Use a **disposable wallet profile**. Never reveal, screenshot, or paste a funded mainnet phrase — assert on shape, not content.

1. Create a fresh wallet, note that the vault screen's first step is now the backup step and Continue is disabled.
2. Tap the phrase row, confirm 12 words render and Continue stays disabled until the checkbox is ticked.
3. Attest, confirm the row ticks and Continue enables.
4. Cancel out, re-enter the wizard, confirm the tick persists.
5. Print shares on a second fresh wallet, confirm that route ticks too.
6. Restore a third wallet from those printed shares; confirm the wallet comes back **with a phrase** — check that Settings' recovery-phrase row copies words rather than hex, and that vault enrollment is no longer refused.
7. Deep-link to `bsv-browser:///vault-transfer?direction=deposit` on a wallet with no attestation and confirm the blocked alert appears rather than a raw key string.

- [ ] **Step 5: Commit any fixes and push**

```bash
git push origin feat/wallet-backup-log
```

---

## Task 13 (optional): Screenshot protection

Independently rejectable: it needs a new native dependency and a rebuild, and on iOS it cannot actually block a screenshot — only detect one after the fact. Android's `FLAG_SECURE` does block. Skip this task if the rebuild cost is not worth partial coverage.

**Files:**
- Modify: `package.json`, `components/vault/PhraseBackupSheet.tsx`, `app/auth/mnemonic.tsx`

- [ ] **Step 1: Add the dependency**

```bash
npx expo install expo-screen-capture
```

- [ ] **Step 2: Guard the reveal surfaces**

In both `components/vault/PhraseBackupSheet.tsx` and the phrase-display branch of `app/auth/mnemonic.tsx`:

```tsx
import * as ScreenCapture from 'expo-screen-capture'

  useEffect(() => {
    // Android FLAG_SECURE genuinely blocks capture. iOS cannot block it — this
    // only makes the attempt detectable — so do not describe it as protection
    // in user-facing copy.
    void ScreenCapture.preventScreenCaptureAsync()
    return () => {
      void ScreenCapture.allowScreenCaptureAsync()
    }
  }, [])
```

- [ ] **Step 3: Rebuild and verify on both platforms**

```bash
npx expo prebuild --clean
```

Then rebuild the dev clients. Verify on the Android emulator that a screenshot of the phrase screen comes out black, and confirm the iOS build still launches.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json components/vault/PhraseBackupSheet.tsx app/auth/mnemonic.tsx
git commit -m "feat(vault): block screen capture while a phrase is on screen"
```
