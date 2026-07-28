# Payments Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `/payments`, `/legacy-payments`, `/local-payments` and the Identity-Key QR modal with one `/pay` screen on a 2×3 grid — direction (Pay / Get paid) × counterparty (nearby / handle / address) — where the transport is inferred, never chosen, and legacy receive sweeps itself in the background.

**Architecture:** Every money path is *moved*, never rewritten. The three screens' logic is extracted into transport-agnostic modules under `utils/pay/` (pure/testable seams first, then the network calls, then the UI). `app/pay.tsx` owns the grid and the chrome and composes six cell components under `components/pay/`. `utils/localpay/*` is not touched at all: the nearby cell mounts today's `local-payments.tsx` body verbatim as `components/pay/NearbyFlow.tsx`. Legacy receive's poll-then-import loop leaves the screen and becomes a bounded background sweeper owned by `WalletContext`, beside the existing NetInfo-triggered localpay retry.

**Tech Stack:** Expo Router 55 (file routes under `app/`), React Native 0.83, TypeScript, `@bsv/sdk`, `@bsv/message-box-client` (PeerPay), `@bsv/wallet-toolbox-mobile` (storage), react-i18next (12 locales in one file), jest + jest-expo.

## Global Constraints

Every task's requirements implicitly include this section.

- **`utils/localpay/*` is read-only.** No edits, no moves, no signature changes. It is device-proven with 210 tests behind it. The nearby rail is a thin adapter over it.
- **Money-path code is moved verbatim, quirks included.** Specifically, these must survive byte-for-byte in behaviour:
  - BRC-29 protocol ID `[2, '3241645161d8']`.
  - The legacy key ID is `derivationPrefix + ' ' + derivationSuffix` (one ASCII space), with `derivationPrefix = base64(YYYY-MM-DD)` and `derivationSuffix = base64('legacy')`.
  - `getPublicKey({ protocolID, keyID, counterparty: 'anyone', forSelf: true })` then `PublicKey.fromString(pk).toAddress(network)`.
  - `getCurrentDate` computes `new Date()`, `setDate(getDate() - daysOffset)`, `toISOString().split('T')[0]`. Do **not** "fix" the local-time/UTC mix — it selects the derivation key, so changing it makes previously-issued addresses unreachable.
  - Legacy internalize uses `senderIdentityKey: new PrivateKey(1).toPublicKey().toString()`.
  - Legacy internalize labels are exactly `['legacy', 'inbound', 'bsvbrowser', <address>, 'ts:<unixSeconds>']`. The `<address>` label is what `listActions({ labels: [address] })` uses to detect already-internalized UTXOs — dropping it double-credits.
  - PeerPay internalize uses `protocol: 'wallet payment'`, `labels: ['peerpay']`, and `acknowledgeMessage` after a successful `internalizeAction`.
  - PeerPay send order is: `createPaymentToken` → `saveOutboxEntry` → `sendMessage` → `markOutboxSent`. The outbox write happens **before** delivery is attempted.
- **Copy rules (from the spec's Naming section):**
  - "Nearby", never "Local", "P2P", or "Device to Device".
  - "Legacy Bridge" never appears in user-facing copy. Transport names live only in subtitles/support docs, never on buttons.
  - Success reads **"Paid"**, not "Payment sent".
  - In-person receive shows a **payment code**; only a fixed figure is a "request".
- **i18n: 12 locales, one file.** `context/i18n/translations.tsx`, keys under `resources.<locale>.translation`. Locales, in file order: `en, zh, hi, es, fr, ar, pt, bn, ru, id, ja, pl`. Every new key goes into all 12; orphaned keys are deleted from all 12.
- **Verification commands:** `npm test` (jest), `npx tsc --noEmit`, `npm run lint`. A task is not done until all three pass for the files it touched.
- **Commits:** conventional-commit subject, one commit per task, and every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01XHvqS5dJLcsbBYC2DfHNa5
  ```
- **Decided open questions** (spec §Open questions):
  - Q3 — **Yes**: Get paid → handle offers a `peerpay:<identityKey>` share-sheet action alongside the QR and Copy.
  - Q4 — **Nothing outside the app deep-links to `/legacy-payments`.** Verified: the only references in the repo are `app/settings.tsx:132` and `app/_layout.tsx:149`. `peerpay:` is the only external entry point and it targets `/payments` (`app/+native-intent.ts:5`, `hooks/useDeepLinking.ts:95`).
  - Q5 — **Sweep bounds** (Task 4/5/6): interval **30 s**; only while `walletBuilt && AppState === 'active' && NetInfo connected`; watchlist holds at most **8** addresses; an entry is dropped after **24 h** with no activity (`lastActivityAt` = later of issue and last successful sweep) or once its date is more than **7 days** old; the sweeper never derives an address it was not handed (no blind look-back).
- **Spec-vs-spec resolution:** Migration says the three screen files are *deleted*; Risks says *"Redirects, and a test per legacy route"*. Both are satisfied by deleting the ~5,000 lines of screen and leaving a 6-line `<Redirect>` stub at each old path (Task 14). The redirect target is computed by a pure, tested function.

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `utils/pay/rails/index.ts` | `RailId`, `PayTarget`, `inferRail`, `classifyScan`, precondition/consequence copy keys, `legacyRedirectTarget` |
| `utils/pay/rails/address.ts` | Everything address-rail: date-keyed derivation, WoC reads, sweep/internalize, send, address validation |
| `utils/pay/rails/handle.ts` | Everything PeerPay: send-with-outbox, incoming list/accept/internalize, `peerPayLinkFor` |
| `utils/pay/rails/nearby.ts` | Thin re-export adapter over `utils/localpay/*` — no logic of its own |
| `utils/pay/watchlist.ts` | Issued-address watchlist in KV storage, with the bounds from Q5 |
| `utils/pay/sweeper.ts` | `runSweep` over the watchlist + `shouldSweepNow` gate |
| `components/pay/NearbyFlow.tsx` | `app/local-payments.tsx`'s body, verbatim, minus its own header/route chrome |
| `components/pay/HandleSend.tsx` | Pay → handle: identity search/scan, amount, send, outbox list |
| `components/pay/HandleReceive.tsx` | Get paid → handle: your-handle QR, copy, share link, incoming inbox |
| `components/pay/AddressSend.tsx` | Pay → address: paste/scan an address, amount, consequence line, send |
| `components/pay/AddressReceive.tsx` | Get paid → address: address QR, copy, watching state, earlier-day recovery |
| `components/pay/PayCellRow.tsx` | One row of the picker (icon, title, subtitle, chevron) |
| `app/pay.tsx` | The one route: direction control, three rows, cell host, deep-link params |
| `__tests__/payRails.test.ts` | Task 1 |
| `__tests__/payAddressDerivation.test.ts` | Task 2 |
| `__tests__/payAddressRail.test.ts` | Task 3 |
| `__tests__/payWatchlist.test.ts` | Task 4 |
| `__tests__/paySweeper.test.ts` | Task 5 |
| `__tests__/payHandleRail.test.ts` | Task 7 |
| `__tests__/payNearbyRail.test.ts` | Task 8 |
| `__tests__/payScreen.test.tsx` | Task 13 |

**Modified**

| File | Change |
|---|---|
| `context/WalletContext.tsx` | Mount the background address sweeper beside the localpay retry loop; widen `localPayNotification` usage to carry sweep toasts |
| `app/settings.tsx` | Four Activity rows + identity-QR modal → one **Pay** row |
| `app/_layout.tsx` | Register `pay`; keep the three legacy `Stack.Screen` entries (now redirect stubs) |
| `app/+native-intent.ts` | `peerpay:` → `/pay?peerpay=…` |
| `hooks/useDeepLinking.ts` | `handlePeerPayLink` → `/pay` |
| `app/payments.tsx`, `app/legacy-payments.tsx`, `app/local-payments.tsx` | Replaced by redirect stubs |
| `context/i18n/translations.tsx` | New `pay_*` keys ×12 locales; orphans removed ×12 |

**Deleted (content, not path):** the three screens' bodies. Their logic lands in `utils/pay/*` and `components/pay/*`.

---

### Task 1: Rail identity, scan classification, legacy redirects

The pure core the whole feature hangs off. No React, no network, no wallet.

**Files:**
- Create: `utils/pay/rails/index.ts`
- Test: `__tests__/payRails.test.ts`

**Interfaces:**
- Consumes: `validatePeerPayURI` from `@/utils/parsePeerPayURI`, `decodeSession`/`Session` from `@/utils/localpay/session`, `Utils` from `@bsv/sdk`.
- Produces:
  ```ts
  type RailId = 'nearby' | 'handle' | 'address'
  type PayTarget =
    | { kind: 'nearby'; session: Session }
    | { kind: 'handle'; identityKey: string; sats?: number }
    | { kind: 'address'; address: string; sats?: number }
  type PayCell = 'pay-nearby' | 'pay-handle' | 'pay-address' | 'get-nearby' | 'get-handle' | 'get-address'
  function inferRail(target: PayTarget): RailId
  function classifyScan(raw: string): PayTarget | null
  function isValidBsvAddress(text: string): boolean
  function normalizeAddressInput(raw: string): string
  function legacyRedirectTarget(route: 'payments' | 'legacy-payments' | 'local-payments', params: Record<string, string | undefined>): { pathname: '/pay'; params: Record<string, string> }
  const PRECONDITION_KEYS: Record<RailId, string>
  const CONSEQUENCE_KEYS: Record<RailId, string>
  ```

- [ ] **Step 1: Write the failing test**

Create `__tests__/payRails.test.ts`:

```ts
import {
  inferRail,
  classifyScan,
  isValidBsvAddress,
  normalizeAddressInput,
  legacyRedirectTarget,
  PRECONDITION_KEYS,
  CONSEQUENCE_KEYS
} from '@/utils/pay/rails'
import { encodeSession, mintSession } from '@/utils/localpay/session'

// secp256k1 generator point — a genuinely valid compressed pubkey.
const KEY = '0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798'
// A real mainnet P2PKH address (base58check).
const ADDRESS = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'

const session = () =>
  mintSession({
    identityKey: KEY,
    derivationPrefix: 'ZGV2LXByZWZpeA==',
    derivationSuffix: 'ZGV2LXN1ZmZpeA==',
    supportsAwdl: false
  })

describe('inferRail', () => {
  it('maps a scanned nearby session to the nearby rail', () => {
    expect(inferRail({ kind: 'nearby', session: session() })).toBe('nearby')
  })

  it('maps a resolved identity to the handle rail', () => {
    expect(inferRail({ kind: 'handle', identityKey: KEY })).toBe('handle')
  })

  it('maps a validated address to the address rail', () => {
    expect(inferRail({ kind: 'address', address: ADDRESS })).toBe('address')
  })
})

describe('classifyScan', () => {
  it('reads a peerpay URI as a handle target, carrying the amount', () => {
    const target = classifyScan(`peerpay:${KEY}?sats=5000`)
    expect(target).toEqual({ kind: 'handle', identityKey: KEY, sats: 5000 })
  })

  it('rejects a peerpay URI whose identity key is malformed', () => {
    expect(classifyScan('peerpay:not-a-key')).toBeNull()
  })

  it('reads a bare compressed public key as a handle target', () => {
    expect(classifyScan(KEY)).toEqual({ kind: 'handle', identityKey: KEY })
  })

  it('reads an encoded localpay session as a nearby target', () => {
    const target = classifyScan(encodeSession(session()))
    expect(target?.kind).toBe('nearby')
  })

  it('reads a bare base58 address as an address target', () => {
    expect(classifyScan(ADDRESS)).toEqual({ kind: 'address', address: ADDRESS })
  })

  it('strips a bitcoin: scheme and its query before classifying', () => {
    expect(classifyScan(`bitcoin:${ADDRESS}?amount=0.1`)).toEqual({ kind: 'address', address: ADDRESS })
  })

  it('returns null for junk rather than guessing a rail', () => {
    expect(classifyScan('hello world')).toBeNull()
  })

  it('tolerates surrounding whitespace', () => {
    expect(classifyScan(`  ${ADDRESS}  `)).toEqual({ kind: 'address', address: ADDRESS })
  })
})

describe('address validation', () => {
  it('accepts a base58check address', () => {
    expect(isValidBsvAddress(ADDRESS)).toBe(true)
  })

  it('rejects an empty string', () => {
    expect(isValidBsvAddress('')).toBe(false)
  })

  it('rejects a checksum-broken address', () => {
    expect(isValidBsvAddress(`${ADDRESS.slice(0, -1)}X`)).toBe(false)
  })

  it('normalizes a bitcoin: URI to a bare address', () => {
    expect(normalizeAddressInput(`bitcoin:${ADDRESS}?label=x`)).toBe(ADDRESS)
  })
})

describe('copy keys', () => {
  it('names a precondition and a consequence for every rail', () => {
    for (const rail of ['nearby', 'handle', 'address'] as const) {
      expect(PRECONDITION_KEYS[rail]).toMatch(/^pay_pre_/)
      expect(CONSEQUENCE_KEYS[rail]).toMatch(/^pay_conseq_/)
    }
  })
})

describe('legacyRedirectTarget', () => {
  it('sends /payments to the pay-handle cell', () => {
    expect(legacyRedirectTarget('payments', {})).toEqual({ pathname: '/pay', params: { cell: 'pay-handle' } })
  })

  it('forwards a peerpay URI so the deep link still lands on the recipient', () => {
    const uri = `peerpay:${KEY}?sats=1000`
    expect(legacyRedirectTarget('payments', { peerpay: uri })).toEqual({
      pathname: '/pay',
      params: { cell: 'pay-handle', peerpay: uri }
    })
  })

  it('forwards identityKey and sats params', () => {
    expect(legacyRedirectTarget('payments', { identityKey: KEY, sats: '42' })).toEqual({
      pathname: '/pay',
      params: { cell: 'pay-handle', identityKey: KEY, sats: '42' }
    })
  })

  it('sends /legacy-payments to the get-address cell', () => {
    expect(legacyRedirectTarget('legacy-payments', {})).toEqual({
      pathname: '/pay',
      params: { cell: 'get-address' }
    })
  })

  it('sends /local-payments to the get-nearby cell', () => {
    expect(legacyRedirectTarget('local-payments', {})).toEqual({
      pathname: '/pay',
      params: { cell: 'get-nearby' }
    })
  })

  it('drops undefined params rather than forwarding them', () => {
    expect(legacyRedirectTarget('payments', { sats: undefined }).params).toEqual({ cell: 'pay-handle' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest __tests__/payRails.test.ts`
Expected: FAIL — `Cannot find module '@/utils/pay/rails'`.

- [ ] **Step 3: Write the implementation**

Create `utils/pay/rails/index.ts`:

```ts
/**
 * Rail identity.
 *
 * A rail is never chosen by the user. It is derived from HOW the counterparty
 * was identified: a scanned nearby session, an identity key, or a base58
 * address. Everything in this file is pure — no wallet, no network — so the
 * classification a payment depends on is testable in isolation.
 */
import { PublicKey, Utils } from '@bsv/sdk'
import { decodeSession, type Session } from '@/utils/localpay/session'
import { validatePeerPayURI } from '@/utils/parsePeerPayURI'

export type RailId = 'nearby' | 'handle' | 'address'

/** How a counterparty was identified. Each variant carries only what its rail needs. */
export type PayTarget =
  | { kind: 'nearby'; session: Session }
  | { kind: 'handle'; identityKey: string; sats?: number }
  | { kind: 'address'; address: string; sats?: number }

/** The six cells of the grid: direction × counterparty. */
export type PayCell = 'pay-nearby' | 'pay-handle' | 'pay-address' | 'get-nearby' | 'get-handle' | 'get-address'

export const PAY_CELLS: readonly PayCell[] = [
  'pay-nearby',
  'pay-handle',
  'pay-address',
  'get-nearby',
  'get-handle',
  'get-address'
] as const

export function isPayCell(value: string | undefined): value is PayCell {
  return !!value && (PAY_CELLS as readonly string[]).includes(value)
}

/** Pure. Derived from how the counterparty was identified, never from a user choosing a transport. */
export function inferRail(target: PayTarget): RailId {
  return target.kind
}

/** What the user must already have for a rail to be possible. */
export const PRECONDITION_KEYS: Record<RailId, string> = {
  nearby: 'pay_pre_nearby',
  handle: 'pay_pre_handle',
  address: 'pay_pre_address'
}

/**
 * What happens after they tap Pay. The address line is the one that must never
 * be implicit: a user who pastes an address expecting messaging-style delivery
 * has effectively posted cash.
 */
export const CONSEQUENCE_KEYS: Record<RailId, string> = {
  nearby: 'pay_conseq_nearby',
  handle: 'pay_conseq_handle',
  address: 'pay_conseq_address'
}

/** Strips a `bitcoin:` scheme and any query string, leaving a bare address candidate. */
export function normalizeAddressInput(raw: string): string {
  return raw.replace(/^bitcoin:/i, '').split('?')[0].trim()
}

export function isValidBsvAddress(text: string): boolean {
  if (!text) return false
  try {
    Utils.fromBase58Check(text)
    return true
  } catch {
    return false
  }
}

function isCompressedPublicKey(text: string): boolean {
  try {
    PublicKey.fromString(text)
    return true
  } catch {
    return false
  }
}

/**
 * The one place a scanned or pasted string becomes a rail.
 *
 * Order matters: the two schemed forms are unambiguous and go first, then the
 * localpay session envelope, then the two bare forms. A string that matches
 * nothing returns null — the caller shows "not recognised" rather than
 * guessing a rail, because guessing wrong on this input sends money the wrong
 * way.
 */
export function classifyScan(raw: string): PayTarget | null {
  const text = raw.trim()
  if (!text) return null

  if (text.toLowerCase().startsWith('peerpay:')) {
    const result = validatePeerPayURI(text)
    if (!result.identityKey || result.errors.identityKey) return null
    return { kind: 'handle', identityKey: result.identityKey, sats: result.sats }
  }

  if (/^bitcoin:/i.test(text)) {
    const address = normalizeAddressInput(text)
    return isValidBsvAddress(address) ? { kind: 'address', address } : null
  }

  try {
    return { kind: 'nearby', session: decodeSession(text) }
  } catch {
    // Not a session envelope. Fall through to the bare forms.
  }

  if (isCompressedPublicKey(text)) return { kind: 'handle', identityKey: text }
  if (isValidBsvAddress(text)) return { kind: 'address', address: text }
  return null
}

/**
 * Where an old route sends the user now.
 *
 * `/payments` carried the only external deep link in the app (`peerpay:` via
 * +native-intent), so its params are forwarded verbatim; the other two never
 * took params.
 */
export function legacyRedirectTarget(
  route: 'payments' | 'legacy-payments' | 'local-payments',
  params: Record<string, string | undefined>
): { pathname: '/pay'; params: Record<string, string> } {
  const cell: PayCell =
    route === 'payments' ? 'pay-handle' : route === 'legacy-payments' ? 'get-address' : 'get-nearby'
  const forwarded: Record<string, string> = { cell }
  for (const key of ['peerpay', 'identityKey', 'sats'] as const) {
    const value = params[key]
    if (value !== undefined) forwarded[key] = value
  }
  return { pathname: '/pay', params: forwarded }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest __tests__/payRails.test.ts`
Expected: PASS, 19 tests.

Then: `npx tsc --noEmit` — expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add utils/pay/rails/index.ts __tests__/payRails.test.ts
git commit -m "$(cat <<'EOF'
feat(pay): rail inference, scan classification and legacy redirect targets

The pure core of the consolidated Pay screen. A rail is derived from how the
counterparty was identified — nearby session, identity key, base58 address —
never chosen by the user. classifyScan returns null on anything it cannot
place rather than guessing, because guessing sends money the wrong way.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XHvqS5dJLcsbBYC2DfHNa5
EOF
)"
```

---

### Task 2: Address rail — date-keyed derivation

The highest-risk port in the plan. The spec: *"Port with tests over `getCurrentDate`/offset before any UI work"* — a mis-ported derivation makes a previously-issued address unreachable and its funds unsweepable.

**Files:**
- Create: `utils/pay/rails/address.ts`
- Test: `__tests__/payAddressDerivation.test.ts`
- Reference (source of truth to port from): `app/legacy-payments.tsx:44` (protocol ID), `:61-65` (`getCurrentDate`), `:101-102` (prefix/suffix), `:151-166` (`getPaymentAddress`), `:143-148` (WoC config).

**Interfaces:**
- Consumes: `PublicKey`, `Utils` from `@bsv/sdk`; `AppChain` from `@/types` (see note in Step 3).
- Produces:
  ```ts
  const BRC29_PROTOCOL_ID: [number, string]
  const LEGACY_DERIVATION_SUFFIX: string          // base64('legacy')
  const MAX_RECOVERY_DAYS: number                 // 30 — the manual stepper's floor
  function getCurrentDate(daysOffset: number, now?: Date): string
  function derivationPrefixFor(date: string): string
  function legacyKeyId(derivationPrefix: string): string
  function wocConfigFor(network: AppChain): { apiBase: string; segment: string; network: 'mainnet' | 'testnet' }
  interface AddressDerivingWallet { getPublicKey(args: unknown, originator?: string): Promise<{ publicKey: string }> }
  function getPaymentAddress(wallet: AddressDerivingWallet, adminOriginator: string, derivationPrefix: string, network: 'mainnet' | 'testnet'): Promise<string>
  ```

- [ ] **Step 1: Write the failing test**

Create `__tests__/payAddressDerivation.test.ts`:

```ts
import { PublicKey, Utils } from '@bsv/sdk'
import {
  BRC29_PROTOCOL_ID,
  LEGACY_DERIVATION_SUFFIX,
  derivationPrefixFor,
  getCurrentDate,
  getPaymentAddress,
  legacyKeyId,
  wocConfigFor
} from '@/utils/pay/rails/address'

const dayMs = 86_400_000

describe('getCurrentDate', () => {
  it('formats as YYYY-MM-DD', () => {
    expect(getCurrentDate(0)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('steps back exactly one calendar day per offset, across 40 days', () => {
    // Invariant, not a golden value: holds in every timezone. Spacing is
    // asserted in UTC-parsed milliseconds, which is what makes it TZ-proof.
    const dates = Array.from({ length: 41 }, (_, i) => getCurrentDate(i))
    for (let i = 1; i < dates.length; i++) {
      const later = Date.parse(`${dates[i - 1]}T00:00:00Z`)
      const earlier = Date.parse(`${dates[i]}T00:00:00Z`)
      expect(later - earlier).toBe(dayMs)
    }
  })

  it('matches independent date arithmetic at a fixed instant', () => {
    // 12:00Z keeps every timezone on the same calendar day, so the two
    // arithmetics (setDate vs millisecond subtraction) agree. A DST boundary
    // at local midnight is the one case where they could differ — hence noon.
    const now = new Date('2026-07-28T12:00:00.000Z')
    const expected = (offset: number) => new Date(now.getTime() - offset * dayMs).toISOString().split('T')[0]
    for (const offset of [0, 1, 7, 30]) {
      expect(getCurrentDate(offset, now)).toBe(expected(offset))
    }
  })

  it('crosses a month boundary', () => {
    expect(getCurrentDate(1, new Date('2026-03-01T12:00:00.000Z'))).toBe('2026-02-28')
  })

  it('crosses a year boundary', () => {
    expect(getCurrentDate(1, new Date('2026-01-01T12:00:00.000Z'))).toBe('2025-12-31')
  })
})

describe('derivation key material', () => {
  it('pins the BRC-29 protocol ID', () => {
    expect(BRC29_PROTOCOL_ID).toEqual([2, '3241645161d8'])
  })

  it("derives the prefix as base64 of the date string", () => {
    expect(derivationPrefixFor('2026-07-28')).toBe(Utils.toBase64(Utils.toArray('2026-07-28', 'utf8')))
  })

  it("pins the suffix as base64 of 'legacy'", () => {
    expect(LEGACY_DERIVATION_SUFFIX).toBe(Utils.toBase64(Utils.toArray('legacy', 'utf8')))
  })

  it('joins prefix and suffix with a single space to form the key ID', () => {
    expect(legacyKeyId('AAA=')).toBe(`AAA= ${LEGACY_DERIVATION_SUFFIX}`)
  })

  it('reproduces the exact key ID a 2026-07-28 address was issued under', () => {
    // Regression pin: this is the string the old screen sent to getPublicKey.
    expect(legacyKeyId(derivationPrefixFor('2026-07-28'))).toBe('MjAyNi0wNy0yOA== bGVnYWN5')
  })
})

describe('wocConfigFor', () => {
  it('maps mainnet', () => {
    expect(wocConfigFor('main')).toEqual({
      apiBase: 'https://api.whatsonchain.com',
      segment: 'main',
      network: 'mainnet'
    })
  })

  it('maps testnet', () => {
    expect(wocConfigFor('test')).toEqual({
      apiBase: 'https://api.whatsonchain.com',
      segment: 'test',
      network: 'testnet'
    })
  })

  it('maps teratest to its own WoC host', () => {
    expect(wocConfigFor('teratest')).toEqual({
      apiBase: 'https://api.woc-ttn.bsvblockchain.tech',
      segment: 'test',
      network: 'testnet'
    })
  })
})

describe('getPaymentAddress', () => {
  it('asks the wallet for a BRC-29 key for anyone, forSelf, and converts it to an address', async () => {
    const publicKey = '0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798'
    const wallet = { getPublicKey: jest.fn().mockResolvedValue({ publicKey }) }
    const prefix = derivationPrefixFor('2026-07-28')

    const address = await getPaymentAddress(wallet, 'admin.com', prefix, 'mainnet')

    expect(wallet.getPublicKey).toHaveBeenCalledWith(
      {
        protocolID: BRC29_PROTOCOL_ID,
        keyID: legacyKeyId(prefix),
        counterparty: 'anyone',
        forSelf: true
      },
      'admin.com'
    )
    expect(address).toBe(PublicKey.fromString(publicKey).toAddress('mainnet'))
  })

  it('rejects when the wallet cannot derive', async () => {
    const wallet = { getPublicKey: jest.fn().mockRejectedValue(new Error('locked')) }
    await expect(getPaymentAddress(wallet, 'admin.com', 'AAA=', 'mainnet')).rejects.toThrow('locked')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest __tests__/payAddressDerivation.test.ts`
Expected: FAIL — `Cannot find module '@/utils/pay/rails/address'`.

- [ ] **Step 3: Write the implementation**

First confirm the `AppChain` type's location and value set:

Run: `grep -rn "AppChain" types/ context/WalletContext.tsx | head -5`

Expected: `AppChain` is `'main' | 'test' | 'teratest'`. Import it from wherever that grep shows it declared (do not redeclare it).

Create `utils/pay/rails/address.ts`:

```ts
/**
 * The address rail — payments to and from conventional wallets.
 *
 * This is the only bridge between this wallet and the rest of the ecosystem,
 * so every line here is a straight port from app/legacy-payments.tsx. The
 * derivation in particular is load-bearing in a way that is easy to miss: the
 * key ID is `base64(YYYY-MM-DD) + ' ' + base64('legacy')`, so the date string
 * IS part of the private key path. Any change to how that string is produced
 * makes previously-issued addresses — and the money sitting on them —
 * unreachable. getCurrentDate's local-time/UTC mix is therefore deliberate and
 * must not be "corrected".
 */
import { PublicKey, Utils, type WalletProtocol } from '@bsv/sdk'
import type { AppChain } from '@/types'   // adjust to the path the grep in Step 3 found

export const BRC29_PROTOCOL_ID: WalletProtocol = [2, '3241645161d8']

export const LEGACY_DERIVATION_SUFFIX = Utils.toBase64(Utils.toArray('legacy', 'utf8'))

/**
 * How far back the manual recovery stepper may reach. The background sweeper
 * has its own, much tighter bound (see utils/pay/watchlist.ts): this one exists
 * because an address a payer sat on for three weeks still holds real money.
 */
export const MAX_RECOVERY_DAYS = 30

/**
 * Verbatim from legacy-payments.tsx. `setDate` on a local Date then
 * `toISOString()` — the mix is what previously-issued addresses were derived
 * with, so it stays. `now` is injectable for tests only; production always
 * takes the default.
 */
export const getCurrentDate = (daysOffset: number, now: Date = new Date()): string => {
  const today = new Date(now.getTime())
  today.setDate(today.getDate() - daysOffset)
  return today.toISOString().split('T')[0]
}

export function derivationPrefixFor(date: string): string {
  return Utils.toBase64(Utils.toArray(date, 'utf8'))
}

/** One ASCII space. The wallet derives a different key for any other separator. */
export function legacyKeyId(derivationPrefix: string): string {
  return `${derivationPrefix} ${LEGACY_DERIVATION_SUFFIX}`
}

export interface WocConfig {
  apiBase: string
  segment: string
  network: 'mainnet' | 'testnet'
}

export function wocConfigFor(network: AppChain): WocConfig {
  return {
    main: { apiBase: 'https://api.whatsonchain.com', segment: 'main', network: 'mainnet' as const },
    test: { apiBase: 'https://api.whatsonchain.com', segment: 'test', network: 'testnet' as const },
    teratest: { apiBase: 'https://api.woc-ttn.bsvblockchain.tech', segment: 'test', network: 'testnet' as const }
  }[network]
}

export interface AddressDerivingWallet {
  getPublicKey(args: unknown, originator?: string): Promise<{ publicKey: string }>
}

export async function getPaymentAddress(
  wallet: AddressDerivingWallet,
  adminOriginator: string,
  derivationPrefix: string,
  network: 'mainnet' | 'testnet'
): Promise<string> {
  const { publicKey } = await wallet.getPublicKey(
    {
      protocolID: BRC29_PROTOCOL_ID,
      keyID: legacyKeyId(derivationPrefix),
      counterparty: 'anyone',
      forSelf: true
    },
    adminOriginator
  )
  return PublicKey.fromString(publicKey).toAddress(network)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest __tests__/payAddressDerivation.test.ts`
Expected: PASS, 14 tests. If the `MjAyNi0wNy0yOA== bGVnYWN5` pin fails, **stop** — the base64 of the date or of `'legacy'` has changed and the port is wrong.

Then: `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add utils/pay/rails/address.ts __tests__/payAddressDerivation.test.ts
git commit -m "$(cat <<'EOF'
feat(pay): port the date-keyed address derivation with tests

base64(YYYY-MM-DD) + ' ' + base64('legacy') is the key ID, so the date string
is part of the key path: a previously-issued address whose derivation cannot
be reproduced is unsweepable money. Pins the protocol ID, both base64 halves,
the single-space separator, the getPublicKey argument shape, and one golden
key ID, plus TZ-proof invariants over the day-offset arithmetic.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XHvqS5dJLcsbBYC2DfHNa5
EOF
)"
```

---

### Task 3: Address rail — reads, sweep, send

The UTXO reads, the internalize (the *sweep mechanism*, which must survive verbatim — only its trigger changes), and the outbound send.

**Files:**
- Modify: `utils/pay/rails/address.ts` (append)
- Test: `__tests__/payAddressRail.test.ts`
- Reference to port from: `app/legacy-payments.tsx:168-201` (`getUtxosForAddress`, `getInternalizedUtxos`), `:203-244` (`getProcessedTransactions`, `fetchBalance`), `:273-368` (`handleImportFunds` — the sweep), `:449-481` (`handleSendBSV`).

**Interfaces:**
- Consumes: everything from Task 2; `Beef`, `PrivateKey`, `P2PKH`, `InternalizeActionArgs`, `InternalizeOutput` from `@bsv/sdk`.
- Produces:
  ```ts
  interface Utxo { txid: string; vout: number; satoshis: number }
  interface ProcessedTx { txid: string; satoshis: number; status: string; importedAt: Date | null }
  interface AddressRailWallet extends AddressDerivingWallet {
    listActions(args: unknown, originator?: string): Promise<{ actions: any[] }>
    internalizeAction(args: unknown, originator?: string): Promise<{ accepted?: boolean } | undefined>
    createAction(args: unknown, originator?: string): Promise<unknown>
  }
  function getUtxosForAddress(woc: WocConfig, address: string): Promise<Utxo[]>
  function getInternalizedUtxos(wallet, adminOriginator, address): Promise<Set<string>>
  function availableUtxos(all: Utxo[], internalized: Set<string>): Utxo[]
  function fetchBalance(wallet, adminOriginator, woc, address): Promise<number>
  function getProcessedTransactions(wallet, adminOriginator, address): Promise<ProcessedTx[]>
  function sweepAddress(args: { wallet; adminOriginator; woc; address; derivationPrefix; nowSeconds?: number }): Promise<{ importedSatoshis: number; failureCount: number }>
  function sendToAddress(args: { wallet; adminOriginator; address; satoshis }): Promise<void>
  ```

- [ ] **Step 1: Write the failing test**

Create `__tests__/payAddressRail.test.ts`:

```ts
import {
  availableUtxos,
  derivationPrefixFor,
  fetchBalance,
  getInternalizedUtxos,
  getProcessedTransactions,
  getUtxosForAddress,
  sendToAddress,
  sweepAddress,
  wocConfigFor
} from '@/utils/pay/rails/address'

const woc = wocConfigFor('main')
const ADDRESS = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'

function mockFetchOnce(handler: (url: string) => { json?: unknown; text?: string }) {
  global.fetch = jest.fn(async (url: string) => {
    const r = handler(String(url))
    return {
      json: async () => r.json,
      text: async () => r.text ?? ''
    } as unknown as Response
  }) as unknown as typeof fetch
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe('getUtxosForAddress', () => {
  it('maps the WoC unspent shape and drops mempool-spent outputs', async () => {
    mockFetchOnce(() => ({
      json: {
        result: [
          { tx_hash: 'aa', tx_pos: 0, value: 1000, isSpentInMempoolTx: false },
          { tx_hash: 'bb', tx_pos: 1, value: 2000, isSpentInMempoolTx: true }
        ]
      }
    }))
    await expect(getUtxosForAddress(woc, ADDRESS)).resolves.toEqual([{ txid: 'aa', vout: 0, satoshis: 1000 }])
  })

  it('calls the network-specific unspent/all endpoint', async () => {
    mockFetchOnce(() => ({ json: { result: [] } }))
    await getUtxosForAddress(woc, ADDRESS)
    expect(global.fetch).toHaveBeenCalledWith(
      `https://api.whatsonchain.com/v1/bsv/main/address/${ADDRESS}/unspent/all`
    )
  })
})

describe('getInternalizedUtxos', () => {
  it('keys already-imported outputs as txid.outputIndex', async () => {
    const wallet = {
      listActions: jest.fn().mockResolvedValue({
        actions: [{ txid: 'aa', outputs: [{ outputIndex: 0 }, { outputIndex: 3 }] }]
      })
    }
    const set = await getInternalizedUtxos(wallet as never, 'admin.com', ADDRESS)
    expect([...set].sort()).toEqual(['aa.0', 'aa.3'])
  })

  it('queries by the address label with labelQueryMode all', async () => {
    const wallet = { listActions: jest.fn().mockResolvedValue({ actions: [] }) }
    await getInternalizedUtxos(wallet as never, 'admin.com', ADDRESS)
    expect(wallet.listActions).toHaveBeenCalledWith(
      { labels: [ADDRESS], labelQueryMode: 'all', includeOutputs: true, limit: 1000 },
      'admin.com'
    )
  })

  it('returns an empty set when listActions throws, so a read failure never blocks a sweep', async () => {
    const wallet = { listActions: jest.fn().mockRejectedValue(new Error('db')) }
    await expect(getInternalizedUtxos(wallet as never, 'admin.com', ADDRESS)).resolves.toEqual(new Set())
  })
})

describe('availableUtxos', () => {
  it('excludes outputs already internalized', () => {
    const all = [
      { txid: 'aa', vout: 0, satoshis: 10 },
      { txid: 'bb', vout: 1, satoshis: 20 }
    ]
    expect(availableUtxos(all, new Set(['aa.0']))).toEqual([{ txid: 'bb', vout: 1, satoshis: 20 }])
  })

  it('is identity when nothing has been internalized', () => {
    const all = [{ txid: 'aa', vout: 0, satoshis: 10 }]
    expect(availableUtxos(all, new Set())).toEqual(all)
  })
})

describe('fetchBalance', () => {
  it('sums only the not-yet-internalized outputs', async () => {
    mockFetchOnce(() => ({
      json: {
        result: [
          { tx_hash: 'aa', tx_pos: 0, value: 1000, isSpentInMempoolTx: false },
          { tx_hash: 'bb', tx_pos: 0, value: 500, isSpentInMempoolTx: false }
        ]
      }
    }))
    const wallet = {
      listActions: jest.fn().mockResolvedValue({ actions: [{ txid: 'aa', outputs: [{ outputIndex: 0 }] }] })
    }
    await expect(fetchBalance(wallet as never, 'admin.com', woc, ADDRESS)).resolves.toBe(500)
  })
})

describe('getProcessedTransactions', () => {
  it('sums output satoshis, reads the ts: label as an import time, and sorts newest first', async () => {
    const wallet = {
      listActions: jest.fn().mockResolvedValue({
        actions: [
          { txid: 'old', status: 'completed', outputs: [{ satoshis: 100 }], labels: ['ts:1000'] },
          { txid: 'new', status: 'completed', outputs: [{ satoshis: 50 }, { satoshis: 25 }], labels: ['ts:2000'] }
        ]
      })
    }
    const rows = await getProcessedTransactions(wallet as never, 'admin.com', ADDRESS)
    expect(rows.map(r => r.txid)).toEqual(['new', 'old'])
    expect(rows[0].satoshis).toBe(75)
    expect(rows[0].importedAt).toEqual(new Date(2000 * 1000))
  })

  it('returns [] rather than throwing when listActions fails', async () => {
    const wallet = { listActions: jest.fn().mockRejectedValue(new Error('db')) }
    await expect(getProcessedTransactions(wallet as never, 'admin.com', ADDRESS)).resolves.toEqual([])
  })
})

describe('sweepAddress', () => {
  const prefix = derivationPrefixFor('2026-07-28')

  function walletWithNothingImported() {
    return {
      listActions: jest.fn().mockResolvedValue({ actions: [] }),
      internalizeAction: jest.fn().mockResolvedValue({ accepted: true })
    }
  }

  it('imports nothing and reports zero when the address is empty', async () => {
    mockFetchOnce(() => ({ json: { result: [] } }))
    const wallet = walletWithNothingImported()
    await expect(
      sweepAddress({ wallet: wallet as never, adminOriginator: 'admin.com', woc, address: ADDRESS, derivationPrefix: prefix })
    ).resolves.toEqual({ importedSatoshis: 0, failureCount: 0 })
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
  })

  it('internalizes with the legacy remittance, description and labels', async () => {
    // One UTXO, and a BEEF response the SDK can parse: use a real Beef built in
    // the test so this exercises the production merge path.
    const { Beef, Transaction } = require('@bsv/sdk')
    const tx = Transaction.fromHex(
      '0100000001000000000000000000000000000000000000000000000000000000000000000000000000000000000001e8030000000000001976a914' +
        '0000000000000000000000000000000000000000' +
        '88ac00000000'
    )
    const beef = new Beef()
    beef.mergeRawTx(tx.toBinary())
    const txid = tx.id('hex')

    mockFetchOnce(url =>
      url.includes('/unspent/all')
        ? { json: { result: [{ tx_hash: txid, tx_pos: 0, value: 1000, isSpentInMempoolTx: false }] } }
        : { text: Buffer.from(beef.toBinary()).toString('hex') }
    )

    const wallet = walletWithNothingImported()
    const result = await sweepAddress({
      wallet: wallet as never,
      adminOriginator: 'admin.com',
      woc,
      address: ADDRESS,
      derivationPrefix: prefix,
      nowSeconds: 1_700_000_000
    })

    expect(result.importedSatoshis).toBe(1000)
    const [args, originator] = wallet.internalizeAction.mock.calls[0]
    expect(originator).toBe('admin.com')
    expect(args.description).toBe('Legacy Bridge Payment')
    expect(args.labels).toEqual(['legacy', 'inbound', 'bsvbrowser', ADDRESS, 'ts:1700000000'])
    expect(args.outputs[0]).toMatchObject({
      outputIndex: 0,
      protocol: 'wallet payment',
      paymentRemittance: { derivationPrefix: prefix, derivationSuffix: 'bGVnYWN5' }
    })
    // The sender key is a fixed sentinel — PrivateKey(1)'s public key — not a real peer.
    expect(args.outputs[0].paymentRemittance.senderIdentityKey).toBe(
      new (require('@bsv/sdk').PrivateKey)(1).toPublicKey().toString()
    )
  })

  it('counts a rejected internalize as a failure and imports nothing', async () => {
    const { Beef, Transaction, PrivateKey } = require('@bsv/sdk')
    void PrivateKey
    const tx = Transaction.fromHex(
      '0100000001000000000000000000000000000000000000000000000000000000000000000000000000000000000001e8030000000000001976a914' +
        '0000000000000000000000000000000000000000' +
        '88ac00000000'
    )
    const beef = new Beef()
    beef.mergeRawTx(tx.toBinary())
    mockFetchOnce(url =>
      url.includes('/unspent/all')
        ? { json: { result: [{ tx_hash: tx.id('hex'), tx_pos: 0, value: 1000, isSpentInMempoolTx: false }] } }
        : { text: Buffer.from(beef.toBinary()).toString('hex') }
    )
    const wallet = {
      listActions: jest.fn().mockResolvedValue({ actions: [] }),
      internalizeAction: jest.fn().mockResolvedValue({ accepted: false })
    }
    await expect(
      sweepAddress({ wallet: wallet as never, adminOriginator: 'admin.com', woc, address: ADDRESS, derivationPrefix: prefix })
    ).resolves.toEqual({ importedSatoshis: 0, failureCount: 1 })
  })

  it('skips outputs already internalized, so a second sweep is a no-op', async () => {
    mockFetchOnce(() => ({
      json: { result: [{ tx_hash: 'aa', tx_pos: 0, value: 1000, isSpentInMempoolTx: false }] }
    }))
    const wallet = {
      listActions: jest.fn().mockResolvedValue({ actions: [{ txid: 'aa', outputs: [{ outputIndex: 0 }] }] }),
      internalizeAction: jest.fn()
    }
    await expect(
      sweepAddress({ wallet: wallet as never, adminOriginator: 'admin.com', woc, address: ADDRESS, derivationPrefix: prefix })
    ).resolves.toEqual({ importedSatoshis: 0, failureCount: 0 })
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
  })
})

describe('sendToAddress', () => {
  it('locks a P2PKH output for the recipient and labels the action legacy/outbound', async () => {
    const wallet = { createAction: jest.fn().mockResolvedValue({}) }
    await sendToAddress({ wallet: wallet as never, adminOriginator: 'admin.com', address: ADDRESS, satoshis: 1234 })
    const [args, originator] = wallet.createAction.mock.calls[0]
    expect(originator).toBe('admin.com')
    expect(args.description).toBe('Send BSV to address')
    expect(args.labels).toEqual(['legacy', 'outbound'])
    expect(args.outputs).toEqual([
      {
        lockingScript: new (require('@bsv/sdk').P2PKH)().lock(ADDRESS).toHex(),
        satoshis: 1234,
        outputDescription: 'BSV for recipient address'
      }
    ])
  })

  it('refuses a non-positive amount before touching the wallet', async () => {
    const wallet = { createAction: jest.fn() }
    await expect(
      sendToAddress({ wallet: wallet as never, adminOriginator: 'admin.com', address: ADDRESS, satoshis: 0 })
    ).rejects.toThrow(/amount/i)
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('refuses an invalid address before touching the wallet', async () => {
    const wallet = { createAction: jest.fn() }
    await expect(
      sendToAddress({ wallet: wallet as never, adminOriginator: 'admin.com', address: 'nope', satoshis: 10 })
    ).rejects.toThrow(/address/i)
    expect(wallet.createAction).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest __tests__/payAddressRail.test.ts`
Expected: FAIL — the new exports do not exist.

If the two BEEF-based `sweepAddress` cases prove awkward to construct (an SDK version quirk in `mergeRawTx`/`findAtomicTransaction`), replace *only those two* with a seam test: extract the pure `buildInternalizeArgsFor(beefTx, utxos, …)` and assert its output shape directly, keeping the four non-BEEF `sweepAddress` cases. Do not delete coverage of the labels/remittance/description shape — that is the part that must not drift.

- [ ] **Step 3: Write the implementation**

Append to `utils/pay/rails/address.ts`:

```ts
import { Beef, P2PKH, PrivateKey, type InternalizeActionArgs, type InternalizeOutput } from '@bsv/sdk'
import { isValidBsvAddress } from '@/utils/pay/rails'

export interface Utxo {
  txid: string
  vout: number
  satoshis: number
}

export interface ProcessedTx {
  txid: string
  satoshis: number
  status: string
  importedAt: Date | null
}

export interface AddressRailWallet extends AddressDerivingWallet {
  listActions(args: unknown, originator?: string): Promise<{ actions: any[] }>
  internalizeAction(args: unknown, originator?: string): Promise<{ accepted?: boolean } | undefined>
  createAction(args: unknown, originator?: string): Promise<unknown>
}

export async function getUtxosForAddress(woc: WocConfig, address: string): Promise<Utxo[]> {
  const response = await fetch(`${woc.apiBase}/v1/bsv/${woc.segment}/address/${address}/unspent/all`)
  const rp = await response.json()
  return rp.result
    .filter((r: any) => r.isSpentInMempoolTx === false)
    .map((r: any) => ({ txid: r.tx_hash, vout: r.tx_pos, satoshis: r.value }))
}

/**
 * Outputs this wallet has already internalized for `address`, keyed
 * `txid.outputIndex`. The address itself is the action label, which is why the
 * label list in sweepAddress below must keep carrying it.
 *
 * A read failure returns an empty set rather than throwing: the caller's next
 * step is internalizeAction, which is idempotent per output, so the cost of a
 * false "nothing imported" is a rejected duplicate — while a throw here would
 * strand real money behind a transient database error.
 */
export async function getInternalizedUtxos(
  wallet: AddressRailWallet,
  adminOriginator: string,
  address: string
): Promise<Set<string>> {
  try {
    const response = await wallet.listActions(
      { labels: [address], labelQueryMode: 'all', includeOutputs: true, limit: 1000 },
      adminOriginator
    )
    const set = new Set<string>()
    for (const action of response.actions) {
      if (action.outputs) {
        for (const output of action.outputs) {
          if (action.txid) set.add(`${action.txid}.${output.outputIndex}`)
        }
      }
    }
    return set
  } catch {
    return new Set()
  }
}

export function availableUtxos(all: Utxo[], internalized: Set<string>): Utxo[] {
  return all.filter(u => !internalized.has(`${u.txid}.${u.vout}`))
}

export async function fetchBalance(
  wallet: AddressRailWallet,
  adminOriginator: string,
  woc: WocConfig,
  address: string
): Promise<number> {
  const all = await getUtxosForAddress(woc, address)
  const internalized = await getInternalizedUtxos(wallet, adminOriginator, address)
  return availableUtxos(all, internalized).reduce((acc, u) => acc + u.satoshis, 0)
}

export async function getProcessedTransactions(
  wallet: AddressRailWallet,
  adminOriginator: string,
  address: string
): Promise<ProcessedTx[]> {
  try {
    const response = await wallet.listActions(
      { labels: [address], labelQueryMode: 'all', includeLabels: true, includeOutputs: true, limit: 1000 },
      adminOriginator
    )
    return response.actions
      .map((action: any) => {
        const totalSats = action.outputs
          ? action.outputs.reduce((sum: number, o: any) => sum + o.satoshis, 0)
          : action.satoshis
        const tsLabel = action.labels?.find((l: string) => l.startsWith('ts:'))
        const importedAt = tsLabel ? new Date(Number(tsLabel.slice(3)) * 1000) : null
        return { txid: action.txid, satoshis: totalSats, status: action.status, importedAt }
      })
      .sort((a: ProcessedTx, b: ProcessedTx) => {
        if (a.importedAt && b.importedAt) return b.importedAt.getTime() - a.importedAt.getTime()
        if (a.importedAt) return -1
        if (b.importedAt) return 1
        return 0
      })
  } catch {
    return []
  }
}

/**
 * The sweep. Ported from legacy-payments.tsx's handleImportFunds with one
 * change and one only: the trigger. Nothing about what it writes moves.
 *
 * The sentinel sender key (PrivateKey(1)'s public key) and the label list are
 * both load-bearing: the labels are how getInternalizedUtxos recognises what
 * has already been imported, and the address label in particular is what makes
 * a second sweep a no-op instead of a double credit.
 */
export async function sweepAddress(args: {
  wallet: AddressRailWallet
  adminOriginator: string
  woc: WocConfig
  address: string
  derivationPrefix: string
  nowSeconds?: number
}): Promise<{ importedSatoshis: number; failureCount: number }> {
  const { wallet, adminOriginator, woc, address, derivationPrefix } = args
  const nowSeconds = args.nowSeconds ?? Math.floor(Date.now() / 1000)

  const all = await getUtxosForAddress(woc, address)
  const internalized = await getInternalizedUtxos(wallet, adminOriginator, address)
  const utxos = availableUtxos(all, internalized)
  if (utxos.length === 0) return { importedSatoshis: 0, failureCount: 0 }

  const beef = new Beef()
  for (const utxo of utxos) {
    if (!beef.findTxid(utxo.txid)) {
      const resp = await fetch(`${woc.apiBase}/v1/bsv/${woc.segment}/tx/${utxo.txid}/beef`)
      const beefHex = await resp.text()
      beef.mergeBeef(Utils.toArray(beefHex, 'hex'))
    }
  }

  const senderIdentityKey = new PrivateKey(1).toPublicKey().toString()
  const txs = beef.txs
    .map(beefTx => {
      const tx = beef.findAtomicTransaction(beefTx.txid)
      const relevant = utxos.filter(o => o.txid === beefTx.txid)
      if (relevant.length === 0) return null
      const outputs: InternalizeOutput[] = relevant.map(o => ({
        outputIndex: o.vout,
        protocol: 'wallet payment' as const,
        paymentRemittance: {
          senderIdentityKey,
          derivationPrefix,
          derivationSuffix: LEGACY_DERIVATION_SUFFIX
        }
      }))
      const internalizeArgs: InternalizeActionArgs = {
        tx: tx!.toAtomicBEEF(),
        description: 'Legacy Bridge Payment',
        outputs,
        labels: ['legacy', 'inbound', 'bsvbrowser', address, `ts:${nowSeconds}`]
      }
      return { args: internalizeArgs, satoshis: relevant.reduce((sum, o) => sum + o.satoshis, 0) }
    })
    .filter(Boolean) as { args: InternalizeActionArgs; satoshis: number }[]

  let importedSatoshis = 0
  let failureCount = 0
  for (const { args: internalizeArgs, satoshis } of txs) {
    try {
      const response = await wallet.internalizeAction(internalizeArgs, adminOriginator)
      if (response?.accepted) importedSatoshis += satoshis
      else failureCount++
    } catch {
      failureCount++
    }
  }
  return { importedSatoshis, failureCount }
}

/**
 * Pay a conventional wallet. The only route out of this wallet to the rest of
 * the ecosystem, so both guards throw before the wallet is touched: an invalid
 * address here is money burned to an unspendable script.
 */
export async function sendToAddress(args: {
  wallet: AddressRailWallet
  adminOriginator: string
  address: string
  satoshis: number
}): Promise<void> {
  const { wallet, adminOriginator, address, satoshis } = args
  const sats = Math.round(Number(satoshis))
  if (!Number.isFinite(sats) || sats <= 0) throw new Error('Invalid amount')
  if (!isValidBsvAddress(address)) throw new Error('Invalid BSV address')
  const lockingScript = new P2PKH().lock(address).toHex()
  await wallet.createAction(
    {
      description: 'Send BSV to address',
      outputs: [{ lockingScript, satoshis: sats, outputDescription: 'BSV for recipient address' }],
      labels: ['legacy', 'outbound']
    },
    adminOriginator
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest __tests__/payAddressRail.test.ts`
Expected: PASS.

Then: `npx jest` (whole suite) and `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add utils/pay/rails/address.ts __tests__/payAddressRail.test.ts
git commit -m "$(cat <<'EOF'
feat(pay): port the address-rail reads, sweep and send

sweepAddress is handleImportFunds with its trigger removed and nothing else
changed: same sentinel sender key, same 'wallet payment' remittance, same
['legacy','inbound','bsvbrowser',<address>,'ts:<unix>'] labels — the address
label is what makes a repeat sweep a no-op instead of a double credit.
sendToAddress validates the address and amount before the wallet is touched.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XHvqS5dJLcsbBYC2DfHNa5
EOF
)"
```

---

### Task 4: Issued-address watchlist (the sweep's bounds)

The background sweeper must not guess which addresses to poll. It polls exactly the ones the app has shown to a user, and it drops them on a schedule. This is where spec open question 5's bounds live.

**Files:**
- Create: `utils/pay/watchlist.ts`
- Test: `__tests__/payWatchlist.test.ts`
- Pattern to follow: `utils/localpay/pending.ts` (KV storage shape and the `withQueueLock` read-modify-write chain — copy that chain, do not import it; `pending.ts` is read-only).

**Interfaces:**
- Consumes: `KVStorage` shape (`getKeyValue`/`setKeyValue`) — declare a local interface, do not import from `utils/localpay/pending.ts`.
- Produces:
  ```ts
  const WATCHLIST_KEY = 'pay_address_watchlist'
  const MAX_WATCHED = 8
  const WATCH_TTL_MS = 86_400_000        // 24h of no activity
  const MAX_WATCH_DAYS = 7               // an address dated older than this is dropped
  interface WatchedAddress { address: string; date: string; derivationPrefix: string; lastActivityAt: string }
  function pruneWatchlist(list: WatchedAddress[], nowMs: number): WatchedAddress[]
  function watchAddress(storage: KVStorage, entry: Omit<WatchedAddress, 'lastActivityAt'>): Promise<void>
  function getWatchlist(storage: KVStorage): Promise<WatchedAddress[]>
  function touchWatched(storage: KVStorage, address: string): Promise<void>
  function unwatchAddress(storage: KVStorage, address: string): Promise<void>
  ```

- [ ] **Step 1: Write the failing test**

Create `__tests__/payWatchlist.test.ts`:

```ts
import {
  MAX_WATCHED,
  MAX_WATCH_DAYS,
  WATCHLIST_KEY,
  WATCH_TTL_MS,
  getWatchlist,
  pruneWatchlist,
  touchWatched,
  unwatchAddress,
  watchAddress,
  type WatchedAddress
} from '@/utils/pay/watchlist'

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getKeyValue: async (k: string) => map.get(k),
    setKeyValue: async (k: string, v: string) => void map.set(k, v)
  }
}

const NOW = Date.parse('2026-07-28T12:00:00.000Z')

const entry = (over: Partial<WatchedAddress> = {}): WatchedAddress => ({
  address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
  date: '2026-07-28',
  derivationPrefix: 'MjAyNi0wNy0yOA==',
  lastActivityAt: new Date(NOW).toISOString(),
  ...over
})

describe('pruneWatchlist', () => {
  it('keeps a fresh entry', () => {
    expect(pruneWatchlist([entry()], NOW)).toHaveLength(1)
  })

  it('drops an entry with no activity for longer than the TTL', () => {
    const stale = entry({ lastActivityAt: new Date(NOW - WATCH_TTL_MS - 1).toISOString() })
    expect(pruneWatchlist([stale], NOW)).toHaveLength(0)
  })

  it('drops an entry whose date is older than the look-back cap', () => {
    const old = entry({ address: 'old', date: '2026-07-01' })
    expect(pruneWatchlist([old], NOW)).toHaveLength(0)
  })

  it('keeps an entry exactly at the look-back cap', () => {
    const edge = entry({ address: 'edge', date: '2026-07-21' }) // 7 days back
    expect(pruneWatchlist([edge], NOW).map(e => e.address)).toEqual(['edge'])
  })

  it(`caps the list at ${MAX_WATCHED}, keeping the most recently active`, () => {
    const many = Array.from({ length: MAX_WATCHED + 3 }, (_, i) =>
      entry({ address: `addr-${i}`, lastActivityAt: new Date(NOW - i * 1000).toISOString() })
    )
    const kept = pruneWatchlist(many, NOW)
    expect(kept).toHaveLength(MAX_WATCHED)
    expect(kept[0].address).toBe('addr-0')
    expect(kept.some(e => e.address === `addr-${MAX_WATCHED + 2}`)).toBe(false)
  })

  it('pins the bounds so a future edit has to be deliberate', () => {
    expect({ MAX_WATCHED, MAX_WATCH_DAYS, WATCH_TTL_MS }).toEqual({
      MAX_WATCHED: 8,
      MAX_WATCH_DAYS: 7,
      WATCH_TTL_MS: 86_400_000
    })
  })
})

describe('watchAddress', () => {
  it('persists under the watchlist key', async () => {
    const s = fakeStorage()
    await watchAddress(s, { address: 'a', date: '2026-07-28', derivationPrefix: 'p' })
    expect(s.map.has(WATCHLIST_KEY)).toBe(true)
  })

  it('is idempotent per address — showing the same address twice does not duplicate it', async () => {
    const s = fakeStorage()
    await watchAddress(s, { address: 'a', date: '2026-07-28', derivationPrefix: 'p' })
    await watchAddress(s, { address: 'a', date: '2026-07-28', derivationPrefix: 'p' })
    expect(await getWatchlist(s)).toHaveLength(1)
  })

  it('refreshes lastActivityAt when the same address is shown again', async () => {
    const s = fakeStorage()
    await watchAddress(s, { address: 'a', date: '2026-07-28', derivationPrefix: 'p' })
    const first = (await getWatchlist(s))[0].lastActivityAt
    await new Promise(r => setTimeout(r, 5))
    await watchAddress(s, { address: 'a', date: '2026-07-28', derivationPrefix: 'p' })
    expect((await getWatchlist(s))[0].lastActivityAt >= first).toBe(true)
  })

  it('does not lose entries when two writes race', async () => {
    const s = fakeStorage()
    await Promise.all([
      watchAddress(s, { address: 'a', date: '2026-07-28', derivationPrefix: 'p' }),
      watchAddress(s, { address: 'b', date: '2026-07-28', derivationPrefix: 'q' })
    ])
    expect((await getWatchlist(s)).map(e => e.address).sort()).toEqual(['a', 'b'])
  })
})

describe('getWatchlist', () => {
  it('returns [] for a fresh install', async () => {
    await expect(getWatchlist(fakeStorage())).resolves.toEqual([])
  })

  it('treats corrupt storage as empty rather than throwing', async () => {
    const s = fakeStorage()
    s.map.set(WATCHLIST_KEY, 'not json')
    await expect(getWatchlist(s)).resolves.toEqual([])
  })

  it('prunes on read, so a stale entry is never polled', async () => {
    const s = fakeStorage()
    s.map.set(WATCHLIST_KEY, JSON.stringify([entry({ lastActivityAt: '2020-01-01T00:00:00.000Z' })]))
    await expect(getWatchlist(s)).resolves.toEqual([])
  })
})

describe('touchWatched / unwatchAddress', () => {
  it('touch keeps the entry alive past its original TTL', async () => {
    const s = fakeStorage()
    await watchAddress(s, { address: 'a', date: '2026-07-28', derivationPrefix: 'p' })
    const before = (await getWatchlist(s))[0].lastActivityAt
    await new Promise(r => setTimeout(r, 5))
    await touchWatched(s, 'a')
    expect((await getWatchlist(s))[0].lastActivityAt >= before).toBe(true)
  })

  it('touching an unknown address is a no-op', async () => {
    const s = fakeStorage()
    await touchWatched(s, 'missing')
    await expect(getWatchlist(s)).resolves.toEqual([])
  })

  it('unwatch removes exactly one entry', async () => {
    const s = fakeStorage()
    await watchAddress(s, { address: 'a', date: '2026-07-28', derivationPrefix: 'p' })
    await watchAddress(s, { address: 'b', date: '2026-07-28', derivationPrefix: 'q' })
    await unwatchAddress(s, 'a')
    expect((await getWatchlist(s)).map(e => e.address)).toEqual(['b'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest __tests__/payWatchlist.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `utils/pay/watchlist.ts`:

```ts
/**
 * Which addresses the background sweeper is allowed to poll.
 *
 * The sweeper never derives an address on its own initiative: it polls exactly
 * the addresses this app has put in front of a user, because those are the only
 * ones anyone could have been asked to pay. That is what makes the background
 * work bounded — an unbounded look-back would be a WoC request per day per
 * poll, for money that was never requested.
 *
 * Bounds (spec open question 5):
 *   · at most MAX_WATCHED addresses, most-recently-active kept
 *   · dropped after WATCH_TTL_MS with no activity (issue or successful sweep)
 *   · never older than MAX_WATCH_DAYS by its issue date
 *
 * A dropped address is not lost money: the Get paid → conventional wallet view
 * re-registers today's address every time it is opened, and the earlier-day
 * recovery stepper can reach back MAX_RECOVERY_DAYS and sweep by hand.
 */

export const WATCHLIST_KEY = 'pay_address_watchlist'
export const MAX_WATCHED = 8
export const WATCH_TTL_MS = 86_400_000
export const MAX_WATCH_DAYS = 7

export interface WatchedAddress {
  address: string
  /** The YYYY-MM-DD the address was derived for. */
  date: string
  /** base64 of `date` — carried so a sweep needs no re-derivation. */
  derivationPrefix: string
  /** ISO 8601. The later of issue and last successful sweep. */
  lastActivityAt: string
}

export interface KVStorage {
  getKeyValue(k: string): Promise<string | undefined>
  setKeyValue(k: string, v: string): Promise<void>
}

// Same discipline as utils/localpay/pending.ts: every read-modify-write on the
// single storage key runs through one chain, or a write built from a stale read
// silently drops entries.
let queueLock: Promise<unknown> = Promise.resolve()

function withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueLock.then(fn, fn)
  queueLock = run.catch(() => undefined)
  return run
}

export function pruneWatchlist(list: WatchedAddress[], nowMs: number): WatchedAddress[] {
  const oldestAllowed = nowMs - MAX_WATCH_DAYS * 86_400_000
  return list
    .filter(e => {
      const activity = Date.parse(e.lastActivityAt)
      if (!Number.isFinite(activity) || nowMs - activity > WATCH_TTL_MS) return false
      const issued = Date.parse(`${e.date}T00:00:00Z`)
      if (!Number.isFinite(issued) || issued < oldestAllowed) return false
      return true
    })
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))
    .slice(0, MAX_WATCHED)
}

async function readAll(storage: KVStorage): Promise<WatchedAddress[]> {
  const raw = await storage.getKeyValue(WATCHLIST_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as WatchedAddress[]) : []
  } catch {
    return []
  }
}

async function writeAll(storage: KVStorage, list: WatchedAddress[]): Promise<void> {
  await storage.setKeyValue(WATCHLIST_KEY, JSON.stringify(list))
}

/** Register (or refresh) an address the user has just been shown. */
export async function watchAddress(
  storage: KVStorage,
  entry: Omit<WatchedAddress, 'lastActivityAt'>
): Promise<void> {
  return withQueueLock(async () => {
    const now = Date.now()
    const existing = (await readAll(storage)).filter(e => e.address !== entry.address)
    const next = pruneWatchlist([{ ...entry, lastActivityAt: new Date(now).toISOString() }, ...existing], now)
    await writeAll(storage, next)
  })
}

/** The addresses the sweeper may poll right now. Prunes as a side effect of reading. */
export async function getWatchlist(storage: KVStorage): Promise<WatchedAddress[]> {
  return pruneWatchlist(await readAll(storage), Date.now())
}

/** Extend an address's life — called after a successful sweep, so more can arrive. */
export async function touchWatched(storage: KVStorage, address: string): Promise<void> {
  return withQueueLock(async () => {
    const all = await readAll(storage)
    if (!all.some(e => e.address === address)) return
    const now = Date.now()
    const next = all.map(e =>
      e.address === address ? { ...e, lastActivityAt: new Date(now).toISOString() } : e
    )
    await writeAll(storage, pruneWatchlist(next, now))
  })
}

export async function unwatchAddress(storage: KVStorage, address: string): Promise<void> {
  return withQueueLock(async () => {
    const all = await readAll(storage)
    await writeAll(
      storage,
      all.filter(e => e.address !== address)
    )
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest __tests__/payWatchlist.test.ts`
Expected: PASS.

Then: `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add utils/pay/watchlist.ts __tests__/payWatchlist.test.ts
git commit -m "$(cat <<'EOF'
feat(pay): bounded watchlist of issued receive addresses

The background sweeper polls only addresses the app has shown to a user, so
the work is bounded by what was actually requested rather than by a blind
day look-back: at most 8 addresses, dropped after 24h of no activity or once
dated more than 7 days back. Copies pending.ts's queue-lock discipline so a
racing write cannot drop an entry.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XHvqS5dJLcsbBYC2DfHNa5
EOF
)"
```

---

### Task 5: The background sweeper

Turns the watchlist plus the address rail into one callable pass, and states in one pure function when a pass is allowed to run.

**Files:**
- Create: `utils/pay/sweeper.ts`
- Test: `__tests__/paySweeper.test.ts`

**Interfaces:**
- Consumes: `sweepAddress`, `wocConfigFor`, `type AddressRailWallet`, `type WocConfig` from `@/utils/pay/rails/address`; `getWatchlist`, `touchWatched`, `type KVStorage`, `type WatchedAddress` from `@/utils/pay/watchlist`.
- Produces:
  ```ts
  const SWEEP_INTERVAL_MS = 30_000
  interface SweepOutcome { address: string; importedSatoshis: number; failureCount: number }
  function shouldSweepNow(state: { walletBuilt: boolean; appActive: boolean; online: boolean; inFlight: boolean }): boolean
  function runSweep(args: { wallet: AddressRailWallet; storage: KVStorage; adminOriginator: string; woc: WocConfig }): Promise<SweepOutcome[]>
  function sweptTotal(outcomes: SweepOutcome[]): number
  ```

- [ ] **Step 1: Write the failing test**

Create `__tests__/paySweeper.test.ts`:

```ts
import { SWEEP_INTERVAL_MS, runSweep, shouldSweepNow, sweptTotal } from '@/utils/pay/sweeper'
import { wocConfigFor } from '@/utils/pay/rails/address'
import { getWatchlist, watchAddress } from '@/utils/pay/watchlist'

jest.mock('@/utils/pay/rails/address', () => {
  const actual = jest.requireActual('@/utils/pay/rails/address')
  return { ...actual, sweepAddress: jest.fn() }
})
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sweepAddress } = require('@/utils/pay/rails/address') as { sweepAddress: jest.Mock }

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getKeyValue: async (k: string) => map.get(k),
    setKeyValue: async (k: string, v: string) => void map.set(k, v)
  }
}

const woc = wocConfigFor('main')
const wallet = {} as never

beforeEach(() => {
  sweepAddress.mockReset()
})

describe('shouldSweepNow', () => {
  const ok = { walletBuilt: true, appActive: true, online: true, inFlight: false }

  it('allows a pass when the wallet is built, the app is foreground and the device is online', () => {
    expect(shouldSweepNow(ok)).toBe(true)
  })

  it('refuses before the wallet is built', () => {
    expect(shouldSweepNow({ ...ok, walletBuilt: false })).toBe(false)
  })

  it('refuses in the background — no polling while the user is elsewhere', () => {
    expect(shouldSweepNow({ ...ok, appActive: false })).toBe(false)
  })

  it('refuses while offline', () => {
    expect(shouldSweepNow({ ...ok, online: false })).toBe(false)
  })

  it('refuses while a pass is already running', () => {
    expect(shouldSweepNow({ ...ok, inFlight: true })).toBe(false)
  })

  it('pins the interval', () => {
    expect(SWEEP_INTERVAL_MS).toBe(30_000)
  })
})

describe('runSweep', () => {
  it('does nothing when the watchlist is empty', async () => {
    const s = fakeStorage()
    await expect(runSweep({ wallet, storage: s, adminOriginator: 'admin.com', woc })).resolves.toEqual([])
    expect(sweepAddress).not.toHaveBeenCalled()
  })

  it('sweeps each watched address with its stored derivation prefix', async () => {
    const s = fakeStorage()
    await watchAddress(s, { address: 'addr-a', date: '2026-07-28', derivationPrefix: 'prefix-a' })
    sweepAddress.mockResolvedValue({ importedSatoshis: 0, failureCount: 0 })

    await runSweep({ wallet, storage: s, adminOriginator: 'admin.com', woc })

    expect(sweepAddress).toHaveBeenCalledWith(
      expect.objectContaining({ address: 'addr-a', derivationPrefix: 'prefix-a', adminOriginator: 'admin.com' })
    )
  })

  it('reports what it imported', async () => {
    const s = fakeStorage()
    await watchAddress(s, { address: 'addr-a', date: '2026-07-28', derivationPrefix: 'p' })
    sweepAddress.mockResolvedValue({ importedSatoshis: 1500, failureCount: 0 })

    await expect(runSweep({ wallet, storage: s, adminOriginator: 'admin.com', woc })).resolves.toEqual([
      { address: 'addr-a', importedSatoshis: 1500, failureCount: 0 }
    ])
  })

  it('keeps a swept address alive, so a second payment to it is still caught', async () => {
    const s = fakeStorage()
    await watchAddress(s, { address: 'addr-a', date: '2026-07-28', derivationPrefix: 'p' })
    const before = (await getWatchlist(s))[0].lastActivityAt
    await new Promise(r => setTimeout(r, 5))
    sweepAddress.mockResolvedValue({ importedSatoshis: 10, failureCount: 0 })

    await runSweep({ wallet, storage: s, adminOriginator: 'admin.com', woc })

    expect((await getWatchlist(s))[0].lastActivityAt >= before).toBe(true)
  })

  it('does not touch an address that received nothing', async () => {
    const s = fakeStorage()
    await watchAddress(s, { address: 'addr-a', date: '2026-07-28', derivationPrefix: 'p' })
    const before = (await getWatchlist(s))[0].lastActivityAt
    sweepAddress.mockResolvedValue({ importedSatoshis: 0, failureCount: 0 })

    await runSweep({ wallet, storage: s, adminOriginator: 'admin.com', woc })

    expect((await getWatchlist(s))[0].lastActivityAt).toBe(before)
  })

  it('carries on to the next address when one throws', async () => {
    const s = fakeStorage()
    await watchAddress(s, { address: 'addr-a', date: '2026-07-28', derivationPrefix: 'p' })
    await watchAddress(s, { address: 'addr-b', date: '2026-07-28', derivationPrefix: 'q' })
    sweepAddress.mockRejectedValueOnce(new Error('woc down')).mockResolvedValueOnce({
      importedSatoshis: 20,
      failureCount: 0
    })

    const outcomes = await runSweep({ wallet, storage: s, adminOriginator: 'admin.com', woc })
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0].importedSatoshis).toBe(20)
  })
})

describe('sweptTotal', () => {
  it('sums imported satoshis', () => {
    expect(
      sweptTotal([
        { address: 'a', importedSatoshis: 100, failureCount: 0 },
        { address: 'b', importedSatoshis: 50, failureCount: 1 }
      ])
    ).toBe(150)
  })

  it('is zero for an empty pass', () => {
    expect(sweptTotal([])).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest __tests__/paySweeper.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `utils/pay/sweeper.ts`:

```ts
/**
 * The background address sweep.
 *
 * "Get paid → a conventional wallet" is: show the address, and money appears.
 * That means the sweep cannot live in a screen — the screen is exactly what the
 * user no longer has to visit — so this module is the callable pass and
 * WalletContext owns its lifecycle, beside the localpay retry loop that already
 * runs there.
 *
 * Every bound is deliberate and tested: see shouldSweepNow for when a pass may
 * run at all, and utils/pay/watchlist.ts for which addresses it may touch.
 */
import { sweepAddress, type AddressRailWallet, type WocConfig } from '@/utils/pay/rails/address'
import { getWatchlist, touchWatched, type KVStorage } from '@/utils/pay/watchlist'

/** One poll every 30s — an order of magnitude cheaper than the 3s screen poll it replaces. */
export const SWEEP_INTERVAL_MS = 30_000

export interface SweepOutcome {
  address: string
  importedSatoshis: number
  failureCount: number
}

/**
 * Whether a pass may run right now.
 *
 * Pure so the four conditions are stated in one place and tested: no polling
 * before the wallet exists, none in the background, none offline, and never two
 * at once (each pass writes to the wallet).
 */
export function shouldSweepNow(state: {
  walletBuilt: boolean
  appActive: boolean
  online: boolean
  inFlight: boolean
}): boolean {
  return state.walletBuilt && state.appActive && state.online && !state.inFlight
}

export async function runSweep(args: {
  wallet: AddressRailWallet
  storage: KVStorage
  adminOriginator: string
  woc: WocConfig
}): Promise<SweepOutcome[]> {
  const { wallet, storage, adminOriginator, woc } = args
  const outcomes: SweepOutcome[] = []

  for (const watched of await getWatchlist(storage)) {
    try {
      const { importedSatoshis, failureCount } = await sweepAddress({
        wallet,
        adminOriginator,
        woc,
        address: watched.address,
        derivationPrefix: watched.derivationPrefix
      })
      outcomes.push({ address: watched.address, importedSatoshis, failureCount })
      // Money arrived here once, so it may again: keep this address alive
      // rather than retiring it the moment it pays out.
      if (importedSatoshis > 0) await touchWatched(storage, watched.address)
    } catch {
      // A dead WoC host or a locked wallet must not stop the rest of the pass.
      // The entry stays watched and the next pass retries it.
    }
  }

  return outcomes
}

export function sweptTotal(outcomes: SweepOutcome[]): number {
  return outcomes.reduce((sum, o) => sum + o.importedSatoshis, 0)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest __tests__/paySweeper.test.ts`
Expected: PASS.

Then: `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add utils/pay/sweeper.ts __tests__/paySweeper.test.ts
git commit -m "$(cat <<'EOF'
feat(pay): background sweep pass with explicit run conditions

runSweep walks the watchlist and internalizes whatever arrived; shouldSweepNow
states the four conditions in one tested place — wallet built, app foreground,
online, not already running. A failing address never stops the pass, and an
address that paid out stays watched so a second payment is still caught.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XHvqS5dJLcsbBYC2DfHNa5
EOF
)"
```

---

### Task 6: Mount the sweeper in WalletContext

The lifecycle: an interval that only ticks when `shouldSweepNow` says so, an in-flight guard, and a toast when money lands. It sits directly beside the existing localpay retry loop so the two background sweeps read as one pattern.

**Files:**
- Modify: `context/WalletContext.tsx` (new effect immediately after the localpay block at `:1225-1269`; new ref beside `localPayProcessingRef` at `:331`)
- Test: none automated — this is a React effect over `AppState`/`NetInfo`/`setInterval`, and its logic is already covered by Task 5's `shouldSweepNow`/`runSweep` tests. Verified in Task 16's device test.

**Interfaces:**
- Consumes: `runSweep`, `shouldSweepNow`, `sweptTotal`, `SWEEP_INTERVAL_MS` from `@/utils/pay/sweeper`; `wocConfigFor` from `@/utils/pay/rails/address`; existing `selectedNetwork`, `managers.permissionsManager`, `storage`, `walletBuilt`, `adminOriginator`, `setLocalPayNotification`, `t`.
- Produces: no new context surface. Sweep results reach the UI through the existing `localPayNotification` channel, which `LocalPayNotificationBridge` (`app/_layout.tsx:83-93`) already turns into a global toast.

- [ ] **Step 1: Add the in-flight guard ref**

In `context/WalletContext.tsx`, immediately after the `localPayProcessingRef` declaration (`:331`), add:

```tsx
  // Guards overlapping address-sweep passes. Same reason as the localpay guard
  // above: a pass writes to the wallet, so two at once can race an internalize.
  const addressSweepingRef = useRef<boolean>(false)
```

- [ ] **Step 2: Add the imports**

Beside the existing `import { processPending } from '@/utils/localpay/pending'` (`:76`):

```tsx
import { wocConfigFor } from '@/utils/pay/rails/address'
import { SWEEP_INTERVAL_MS, runSweep, shouldSweepNow, sweptTotal } from '@/utils/pay/sweeper'
import { formatAmount } from '@/utils/amountFormatHelpers'
```

- [ ] **Step 3: Add the effect**

Immediately after the localpay pending-queue effect (after the closing `}, [walletBuilt, managers.permissionsManager, storage, adminOriginator, t])` at `:1269`), add:

```tsx
  // ── Background legacy-address sweep ──
  // "Get paid → a conventional wallet" is: show the address, and money appears.
  // The user never has to return to a screen, so the poll cannot live in one.
  // Bounds live in utils/pay/watchlist.ts (which addresses) and
  // utils/pay/sweeper.ts (when a pass may run at all).
  useEffect(() => {
    const wallet = managers.permissionsManager
    if (!walletBuilt || !wallet || !storage) return

    let cancelled = false
    let online = true
    const woc = wocConfigFor(selectedNetwork)

    const tick = async () => {
      if (cancelled) return
      if (
        !shouldSweepNow({
          walletBuilt: true,
          appActive: AppState.currentState === 'active',
          online,
          inFlight: addressSweepingRef.current
        })
      ) {
        return
      }
      addressSweepingRef.current = true
      try {
        const outcomes = await runSweep({
          wallet: wallet as any,
          storage,
          adminOriginator,
          woc
        })
        const total = sweptTotal(outcomes)
        if (total > 0 && !cancelled) {
          // The internalizeAction inside the sweep IS the inbound history entry
          // (labels: legacy, inbound, …), so the toast is all that is left to do.
          setLocalPayNotification({
            message: t('pay_address_swept', { amount: formatAmount(total, settings?.currency || 'BSV') }),
            type: 'success'
          })
        }
      } catch {
        // Best-effort. Every address stays watched and the next tick retries.
      } finally {
        addressSweepingRef.current = false
      }
    }

    const netUnsubscribe = NetInfo.addEventListener(state => {
      online = !!state.isConnected && state.isInternetReachable !== false
      // Coming back online is worth a pass immediately rather than at the next tick.
      if (online) void tick()
    })
    const appSubscription = AppState.addEventListener('change', next => {
      if (next === 'active') void tick()
    })
    const interval = setInterval(() => void tick(), SWEEP_INTERVAL_MS)
    void tick()

    return () => {
      cancelled = true
      clearInterval(interval)
      netUnsubscribe()
      appSubscription.remove()
    }
  }, [walletBuilt, managers.permissionsManager, storage, adminOriginator, selectedNetwork, settings?.currency, t])
```

Check `formatAmount`'s signature before wiring the message — `grep -n "export function formatAmount" -A6 utils/amountFormatHelpers.ts`. In `app/payments.tsx:1170` it is called as `formatAmount(sats, currency, satoshisPerUSD)`; `satoshisPerUSD` is not available in `WalletContext`, so either pass the two-argument form (if the third is optional) or fall back to `t('pay_address_swept_plain')` with no amount. Do not add an ExchangeRate dependency to `WalletContext` for this.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit` — expected: clean.
Run: `npx jest` — expected: the full suite still passes (no test targets this effect).
Run: `npm run lint` — expected: no new warnings (the effect's dependency array is complete).

- [ ] **Step 5: Commit**

```bash
git add context/WalletContext.tsx
git commit -m "$(cat <<'EOF'
feat(pay): run the address sweep in the background, not in a screen

Legacy receive no longer needs the user to return to a screen: WalletContext
polls the watchlist every 30s while foreground and online, internalizes what
arrived, and raises the existing localPayNotification toast. Sits beside the
localpay retry loop so both background sweeps share one shape, with the same
in-flight guard.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XHvqS5dJLcsbBYC2DfHNa5
EOF
)"
```

---

### Task 7: Handle rail (PeerPay)

**Files:**
- Create: `utils/pay/rails/handle.ts`
- Test: `__tests__/payHandleRail.test.ts`
- Reference to port from: `app/payments.tsx:211-226` (`acceptWithRetry`), `:1050-1076` (`internalizePayment`), `:1136-1198` (`handleSend`'s four steps), `:1203-1226` (retry).

**Interfaces:**
- Consumes: `OutboxEntry`, `saveOutboxEntry`, `markOutboxSent`, `updateOutboxEntry` from `@/utils/peerpay/outbox`; `IncomingPayment`, `PaymentToken`, `PeerPayClient` types from `@bsv/message-box-client`.
- Produces:
  ```ts
  const MESSAGE_BOX_URL_KEY = 'message_box_url'
  const DEFAULT_MESSAGE_BOX_URL = 'https://messagebox.babbage.systems'
  const NO_MESSAGE_BOX = 'noMessageBox'
  function peerPayLinkFor(identityKey: string, sats?: number): string
  function internalizeIncoming(wallet, adminOriginator, payment, description): Promise<void>
  function acceptWithRetry(client, messageBoxUrl, payment, description, internalize): Promise<void>
  function sendViaHandle(args: { client; storage; recipient: string; satoshis: number; messageBoxUrl: string }): Promise<{ outboxId: string }>
  function retryDelivery(args: { client; storage; entry: OutboxEntry }): Promise<void>
  ```

- [ ] **Step 1: Write the failing test**

Create `__tests__/payHandleRail.test.ts`:

```ts
import {
  DEFAULT_MESSAGE_BOX_URL,
  MESSAGE_BOX_URL_KEY,
  NO_MESSAGE_BOX,
  acceptWithRetry,
  internalizeIncoming,
  peerPayLinkFor,
  retryDelivery,
  sendViaHandle
} from '@/utils/pay/rails/handle'
import { getOutboxEntries } from '@/utils/peerpay/outbox'
import { validatePeerPayURI } from '@/utils/parsePeerPayURI'

const KEY = '0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798'

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getKeyValue: async (k: string) => map.get(k),
    setKeyValue: async (k: string, v: string) => void map.set(k, v)
  }
}

describe('peerPayLinkFor', () => {
  it('round-trips through the app’s own URI validator', () => {
    const result = validatePeerPayURI(peerPayLinkFor(KEY))
    expect(result.isPeerPay).toBe(true)
    expect(result.identityKey).toBe(KEY)
    expect(result.errors).toEqual({})
  })

  it('carries an amount when one is named', () => {
    const result = validatePeerPayURI(peerPayLinkFor(KEY, 5000))
    expect(result.sats).toBe(5000)
    expect(result.errors).toEqual({})
  })

  it('omits the query entirely for an open request', () => {
    expect(peerPayLinkFor(KEY)).toBe(`peerpay:${KEY}`)
  })

  it('omits a non-positive amount rather than emitting sats=0', () => {
    expect(peerPayLinkFor(KEY, 0)).toBe(`peerpay:${KEY}`)
  })
})

describe('message box constants', () => {
  it('keeps the storage key and default host the old screen used', () => {
    expect(MESSAGE_BOX_URL_KEY).toBe('message_box_url')
    expect(DEFAULT_MESSAGE_BOX_URL).toBe('https://messagebox.babbage.systems')
    expect(NO_MESSAGE_BOX).toBe('noMessageBox')
  })
})

describe('internalizeIncoming', () => {
  const payment = {
    messageId: 'm1',
    sender: KEY,
    token: {
      transaction: [1, 2, 3],
      outputIndex: 2,
      customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' },
      amount: 500
    }
  } as never

  it('internalizes as a wallet payment with the peerpay label, then acknowledges', async () => {
    const wallet = { internalizeAction: jest.fn().mockResolvedValue({ accepted: true }) }
    const client = { acknowledgeMessage: jest.fn().mockResolvedValue(undefined) }

    await internalizeIncoming(wallet as never, client as never, 'admin.com', payment, 'Dinner')

    const [args, originator] = wallet.internalizeAction.mock.calls[0]
    expect(originator).toBe('admin.com')
    expect(args.description).toBe('Dinner')
    expect(args.labels).toEqual(['peerpay'])
    expect(args.tx).toEqual([1, 2, 3])
    expect(args.outputs[0]).toEqual({
      outputIndex: 2,
      protocol: 'wallet payment',
      paymentRemittance: { derivationPrefix: 'p', derivationSuffix: 's', senderIdentityKey: KEY }
    })
    expect(client.acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['m1'] })
  })

  it('defaults outputIndex to 0 when the token omits it', async () => {
    const wallet = { internalizeAction: jest.fn().mockResolvedValue({}) }
    const client = { acknowledgeMessage: jest.fn().mockResolvedValue(undefined) }
    const noIndex = { ...(payment as any), token: { ...(payment as any).token, outputIndex: undefined } }
    await internalizeIncoming(wallet as never, client as never, 'admin.com', noIndex, 'x')
    expect(wallet.internalizeAction.mock.calls[0][0].outputs[0].outputIndex).toBe(0)
  })

  it('does not acknowledge when the internalize fails', async () => {
    const wallet = { internalizeAction: jest.fn().mockRejectedValue(new Error('nope')) }
    const client = { acknowledgeMessage: jest.fn() }
    await expect(internalizeIncoming(wallet as never, client as never, 'admin.com', payment, 'x')).rejects.toThrow()
    expect(client.acknowledgeMessage).not.toHaveBeenCalled()
  })
})

describe('acceptWithRetry', () => {
  const payment = { messageId: 'm1' } as never

  it('accepts on the first attempt', async () => {
    const internalize = jest.fn().mockResolvedValue(undefined)
    const client = { listIncomingPayments: jest.fn() }
    await acceptWithRetry(client as never, 'https://mb', payment, 'note', internalize)
    expect(internalize).toHaveBeenCalledTimes(1)
    expect(client.listIncomingPayments).not.toHaveBeenCalled()
  })

  it('re-lists and retries with the fresh payment when the first attempt fails', async () => {
    const fresh = { messageId: 'm1', fresh: true }
    const internalize = jest.fn().mockRejectedValueOnce(new Error('stale')).mockResolvedValueOnce(undefined)
    const client = { listIncomingPayments: jest.fn().mockResolvedValue([fresh]) }
    await acceptWithRetry(client as never, 'https://mb', payment, 'note', internalize)
    expect(internalize).toHaveBeenNthCalledWith(2, fresh, 'note')
  })

  it('throws when the payment is gone on refresh', async () => {
    const internalize = jest.fn().mockRejectedValue(new Error('stale'))
    const client = { listIncomingPayments: jest.fn().mockResolvedValue([]) }
    await expect(acceptWithRetry(client as never, 'https://mb', payment, 'n', internalize)).rejects.toThrow(
      /not found/i
    )
  })
})

describe('sendViaHandle', () => {
  const token = {
    customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' },
    transaction: [1, 2, 3],
    amount: 700
  }

  it('persists to the outbox BEFORE delivery is attempted', async () => {
    const s = fakeStorage()
    const order: string[] = []
    const client = {
      createPaymentToken: jest.fn(async () => {
        order.push('create')
        return token
      }),
      sendMessage: jest.fn(async () => {
        order.push('send')
        // The outbox entry must already exist at this point, or a crash here
        // loses the derivation data and the money with it.
        expect(await getOutboxEntries(s)).toHaveLength(1)
      })
    }

    await sendViaHandle({
      client: client as never,
      storage: s,
      recipient: KEY,
      satoshis: 700,
      messageBoxUrl: 'https://mb'
    })

    expect(order).toEqual(['create', 'send'])
  })

  it('marks the entry sent once delivery succeeds', async () => {
    const s = fakeStorage()
    const client = {
      createPaymentToken: jest.fn().mockResolvedValue(token),
      sendMessage: jest.fn().mockResolvedValue(undefined)
    }
    await sendViaHandle({ client: client as never, storage: s, recipient: KEY, satoshis: 700, messageBoxUrl: 'https://mb' })
    expect((await getOutboxEntries(s))[0].status).toBe('sent')
  })

  it('leaves the entry unsent — and rethrows — when delivery fails', async () => {
    const s = fakeStorage()
    const client = {
      createPaymentToken: jest.fn().mockResolvedValue(token),
      sendMessage: jest.fn().mockRejectedValue(new Error('offline'))
    }
    await expect(
      sendViaHandle({ client: client as never, storage: s, recipient: KEY, satoshis: 700, messageBoxUrl: 'https://mb' })
    ).rejects.toThrow('offline')
    const entries = await getOutboxEntries(s)
    expect(entries).toHaveLength(1)
    expect(entries[0].status).toBe('unsent')
  })

  it('sends to the payment_inbox message box as JSON', async () => {
    const s = fakeStorage()
    const client = {
      createPaymentToken: jest.fn().mockResolvedValue(token),
      sendMessage: jest.fn().mockResolvedValue(undefined)
    }
    await sendViaHandle({ client: client as never, storage: s, recipient: KEY, satoshis: 700, messageBoxUrl: 'https://mb' })
    expect(client.sendMessage).toHaveBeenCalledWith({
      recipient: KEY,
      messageBox: 'payment_inbox',
      body: JSON.stringify(token)
    })
  })

  it('refuses a non-positive amount before minting a token', async () => {
    const s = fakeStorage()
    const client = { createPaymentToken: jest.fn(), sendMessage: jest.fn() }
    await expect(
      sendViaHandle({ client: client as never, storage: s, recipient: KEY, satoshis: 0, messageBoxUrl: 'https://mb' })
    ).rejects.toThrow(/amount/i)
    expect(client.createPaymentToken).not.toHaveBeenCalled()
  })
})

describe('retryDelivery', () => {
  it('marks sent on success', async () => {
    const s = fakeStorage()
    const client = {
      createPaymentToken: jest.fn().mockResolvedValue({
        customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' },
        transaction: [1],
        amount: 5
      }),
      sendMessage: jest.fn().mockRejectedValueOnce(new Error('offline'))
    }
    await expect(
      sendViaHandle({ client: client as never, storage: s, recipient: KEY, satoshis: 5, messageBoxUrl: 'https://mb' })
    ).rejects.toThrow()

    const entry = (await getOutboxEntries(s))[0]
    client.sendMessage = jest.fn().mockResolvedValue(undefined)
    await retryDelivery({ client: client as never, storage: s, entry })
    expect((await getOutboxEntries(s))[0].status).toBe('sent')
  })

  it('records the error and rethrows on a failed retry', async () => {
    const s = fakeStorage()
    const client = {
      createPaymentToken: jest.fn().mockResolvedValue({
        customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' },
        transaction: [1],
        amount: 5
      }),
      sendMessage: jest.fn().mockRejectedValue(new Error('still offline'))
    }
    await expect(
      sendViaHandle({ client: client as never, storage: s, recipient: KEY, satoshis: 5, messageBoxUrl: 'https://mb' })
    ).rejects.toThrow()
    const entry = (await getOutboxEntries(s))[0]

    await expect(retryDelivery({ client: client as never, storage: s, entry })).rejects.toThrow('still offline')
    const after = (await getOutboxEntries(s))[0]
    expect(after.status).toBe('unsent')
    expect(after.lastError).toBe('still offline')
    expect(after.lastAttemptAt).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest __tests__/payHandleRail.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `utils/pay/rails/handle.ts`:

```ts
/**
 * The handle rail — remote, asynchronous payments addressed by identity key and
 * delivered through a MessageBox (PeerPay).
 *
 * Ported from app/payments.tsx. The one invariant worth restating: the outbox
 * write happens BEFORE delivery is attempted. The payment token holds the
 * derivation data for a transaction that has already been broadcast, so losing
 * it between broadcast and delivery loses the money — persisting first is what
 * makes a crash recoverable.
 */
import type { IncomingPayment, PaymentToken, PeerPayClient } from '@bsv/message-box-client'
import {
  markOutboxSent,
  saveOutboxEntry,
  updateOutboxEntry,
  type OutboxEntry
} from '@/utils/peerpay/outbox'

export const MESSAGE_BOX_URL_KEY = 'message_box_url'
export const DEFAULT_MESSAGE_BOX_URL = 'https://messagebox.babbage.systems'
/** The sentinel the config panel writes when the user opts out of a server. */
export const NO_MESSAGE_BOX = 'noMessageBox'

/** The message box outbound payments are delivered into. */
const PAYMENT_INBOX = 'payment_inbox'

interface StorageLike {
  getKeyValue: (key: string) => Promise<string | undefined>
  setKeyValue: (key: string, value: string) => Promise<void>
}

interface InternalizingWallet {
  internalizeAction(args: unknown, originator?: string): Promise<unknown>
}

/**
 * A shareable payment link for a handle.
 *
 * Deliberately the same `peerpay:` form the app already parses
 * (utils/parsePeerPayURI.ts) and already routes (app/+native-intent.ts), so a
 * tapped link lands on /pay with the recipient filled in. A non-positive amount
 * emits no query at all — `sats=0` would be an invalid link, and an open
 * request is exactly the absence of a figure.
 */
export function peerPayLinkFor(identityKey: string, sats?: number): string {
  const amount = sats !== undefined ? Math.round(Number(sats)) : NaN
  return Number.isFinite(amount) && amount > 0
    ? `peerpay:${identityKey}?sats=${amount}`
    : `peerpay:${identityKey}`
}

/** Credit an incoming payment, then acknowledge it. Never acknowledge first. */
export async function internalizeIncoming(
  wallet: InternalizingWallet,
  client: Pick<PeerPayClient, 'acknowledgeMessage'>,
  adminOriginator: string,
  payment: IncomingPayment,
  description: string
): Promise<void> {
  await wallet.internalizeAction(
    {
      tx: payment.token.transaction,
      outputs: [
        {
          paymentRemittance: {
            derivationPrefix: payment.token.customInstructions.derivationPrefix,
            derivationSuffix: payment.token.customInstructions.derivationSuffix,
            senderIdentityKey: payment.sender
          },
          outputIndex: payment.token.outputIndex ?? 0,
          protocol: 'wallet payment'
        }
      ],
      labels: ['peerpay'],
      description
    },
    adminOriginator
  )
  await client.acknowledgeMessage({ messageIds: [payment.messageId] })
}

/**
 * One retry against a re-listed payment. A token can go stale between listing
 * and accepting (the sender re-sent, the box re-issued the message id), and the
 * fresh copy usually internalizes cleanly.
 */
export async function acceptWithRetry(
  client: Pick<PeerPayClient, 'listIncomingPayments'>,
  messageBoxUrl: string,
  payment: IncomingPayment,
  description: string,
  internalize: (p: IncomingPayment, d: string) => Promise<void>
): Promise<void> {
  try {
    await internalize(payment, description)
  } catch {
    const list = await client.listIncomingPayments(messageBoxUrl)
    const fresh = list.find(x => String(x.messageId) === String(payment.messageId))
    if (!fresh) throw new Error('Payment not found on refresh')
    await internalize(fresh, description)
  }
}

/**
 * Pay a handle. Four steps, in this order, for the reason in the file header:
 *   1 mint + broadcast the token   2 persist it   3 deliver it   4 mark sent
 * A throw from step 3 leaves an `unsent` entry, which the Outgoing list offers
 * for manual retry.
 */
export async function sendViaHandle(args: {
  client: Pick<PeerPayClient, 'createPaymentToken' | 'sendMessage'>
  storage: StorageLike
  recipient: string
  satoshis: number
  messageBoxUrl: string
}): Promise<{ outboxId: string }> {
  const { client, storage, recipient, messageBoxUrl } = args
  const sats = Math.round(Number(args.satoshis))
  if (!Number.isFinite(sats) || sats <= 0) throw new Error('Invalid amount')

  const token = await client.createPaymentToken({ recipient, amount: sats })
  const outboxId = await saveOutboxEntry(storage, {
    recipient,
    token: token as PaymentToken & { transaction: number[] },
    messageBoxUrl
  })
  await client.sendMessage({
    recipient,
    messageBox: PAYMENT_INBOX,
    body: JSON.stringify(token)
  })
  await markOutboxSent(storage, outboxId)
  return { outboxId }
}

/** Re-deliver a persisted token. The transaction is already broadcast; only delivery is retried. */
export async function retryDelivery(args: {
  client: Pick<PeerPayClient, 'sendMessage'>
  storage: StorageLike
  entry: OutboxEntry
}): Promise<void> {
  const { client, storage, entry } = args
  await updateOutboxEntry(storage, entry.id, { lastAttemptAt: new Date().toISOString() })
  try {
    await client.sendMessage({
      recipient: entry.recipient,
      messageBox: PAYMENT_INBOX,
      body: JSON.stringify(entry.token)
    })
    await markOutboxSent(storage, entry.id)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await updateOutboxEntry(storage, entry.id, { lastError: message })
    throw e
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest __tests__/payHandleRail.test.ts`
Expected: PASS.

If `internalizeIncoming`'s signature in the test (which takes `client` as the second argument) disagrees with what you implement, fix the *implementation* to match the test — the acknowledge must live inside the same function as the internalize so it cannot be forgotten at a call site.

Then: `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add utils/pay/rails/handle.ts __tests__/payHandleRail.test.ts
git commit -m "$(cat <<'EOF'
feat(pay): extract the PeerPay handle rail

Send (four steps, outbox persisted before delivery), incoming accept with one
re-list retry, internalize-then-acknowledge, and peerPayLinkFor for the
shareable handle link — which round-trips through the app's own URI validator
and the existing +native-intent route. Behaviour is unchanged from
app/payments.tsx; only the file it lives in.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XHvqS5dJLcsbBYC2DfHNa5
EOF
)"
```

---

### Task 8: Nearby rail adapter

Deliberately trivial. Its job is to be the one import site for nearby, so no UI file ever reaches into `utils/localpay/*` and no logic accretes between the two.

**Files:**
- Create: `utils/pay/rails/nearby.ts`
- Test: `__tests__/payNearbyRail.test.ts`

**Interfaces:**
- Consumes: `utils/localpay/{session,codec,pending,build}` and `utils/localpay/transport/{awdl,select,types}` — read-only.
- Produces: re-exports only. No new behaviour, no wrappers.

- [ ] **Step 1: Write the failing test**

Create `__tests__/payNearbyRail.test.ts`:

```ts
import * as nearby from '@/utils/pay/rails/nearby'
import * as session from '@/utils/localpay/session'
import * as codec from '@/utils/localpay/codec'
import * as pending from '@/utils/localpay/pending'
import * as build from '@/utils/localpay/build'
import { awdlTransport } from '@/utils/localpay/transport/awdl'
import { localSupportsAwdl, selectTransport } from '@/utils/localpay/transport/select'

describe('nearby rail adapter', () => {
  it('re-exports the localpay functions by identity, so nothing is reimplemented', () => {
    expect(nearby.mintSession).toBe(session.mintSession)
    expect(nearby.encodeSession).toBe(session.encodeSession)
    expect(nearby.decodeSession).toBe(session.decodeSession)
    expect(nearby.frameToQr).toBe(codec.frameToQr)
    expect(nearby.frameFromQr).toBe(codec.frameFromQr)
    expect(nearby.MAX_FRAME_QR_CHARS).toBe(codec.MAX_FRAME_QR_CHARS)
    expect(nearby.savePending).toBe(pending.savePending)
    expect(nearby.processPending).toBe(pending.processPending)
    expect(nearby.isSessionSpent).toBe(pending.isSessionSpent)
    expect(nearby.markSessionSpent).toBe(pending.markSessionSpent)
    expect(nearby.buildPaymentFrame).toBe(build.buildPaymentFrame)
    expect(nearby.finalizeDelivery).toBe(build.finalizeDelivery)
    expect(nearby.awdlTransport).toBe(awdlTransport)
    expect(nearby.selectTransport).toBe(selectTransport)
    expect(nearby.localSupportsAwdl).toBe(localSupportsAwdl)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest __tests__/payNearbyRail.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `utils/pay/rails/nearby.ts`:

```ts
/**
 * The nearby rail — in-person, device-to-device over AWDL or QR.
 *
 * A pass-through, on purpose. utils/localpay/* is device-proven with 210 tests
 * behind it and its money-safety invariants were verified line by line, so this
 * rail adds NOTHING: no wrappers, no defaults, no convenience. Its only job is
 * to be the single import site for nearby, so a future change cannot quietly
 * grow a second implementation between the screen and the transport.
 *
 * If you find yourself wanting to add a function here, add it to the caller
 * instead.
 */
export { decodeSession, encodeSession, mintSession, type Session } from '@/utils/localpay/session'
export { MAX_FRAME_QR_CHARS, frameFromQr, frameToQr, type PaymentFrame } from '@/utils/localpay/codec'
export {
  isSessionSpent,
  markSessionSpent,
  processPending,
  savePending,
  type PendingPayment
} from '@/utils/localpay/pending'
export { buildPaymentFrame, finalizeDelivery } from '@/utils/localpay/build'
export { awdlTransport } from '@/utils/localpay/transport/awdl'
export { localSupportsAwdl, selectTransport } from '@/utils/localpay/transport/select'
export {
  isDeclineReason,
  type Ack,
  type ConfirmDelivery,
  type DeclineReason
} from '@/utils/localpay/transport/types'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest __tests__/payNearbyRail.test.ts`
Expected: PASS.

Then: `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add utils/pay/rails/nearby.ts __tests__/payNearbyRail.test.ts
git commit -m "$(cat <<'EOF'
feat(pay): nearby rail as a pass-through over utils/localpay

One import site for nearby, no logic of its own. The identity test exists to
fail loudly if a future change reimplements a localpay primitive here instead
of re-exporting it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XHvqS5dJLcsbBYC2DfHNa5
EOF
)"
```

---

### Task 9: NearbyFlow component (move `local-payments.tsx` verbatim)

The spec's survival requirement 6: *everything in `local-payments.tsx`, unchanged in behaviour*. So this is a **move with a named list of edits**, not a rewrite. Do not restructure the phase machine, do not reorder the settle path, do not touch a comment.

**Files:**
- Create: `components/pay/NearbyFlow.tsx` (from `app/local-payments.tsx`, all 1930 lines)
- Test: `__tests__/payScreen.test.tsx` covers it via the screen in Task 13; no separate test here.

**Interfaces:**
- Consumes: `utils/pay/rails/nearby` (replacing the direct `utils/localpay/*` imports), `useWallet`, theme, `QRScanner`, `AmountInput`, `AmountDisplay`, `Celebration`, `PressableScale`, `PresenceRow`, `sounds`, identity helpers.
- Produces:
  ```ts
  interface NearbyFlowProps {
    /** Which side of the exchange this device is on. Set by the cell that mounted it. */
    role: 'payer' | 'payee'
    /** Leave the flow — the Pay screen takes the user back to the grid. */
    onExit: () => void
  }
  export default function NearbyFlow(props: NearbyFlowProps): JSX.Element
  ```

- [ ] **Step 1: Copy the file**

```bash
git mv app/local-payments.tsx components/pay/NearbyFlow.tsx
```

Using `git mv` keeps the history attached to the 1930 lines, which is worth more than a clean-looking diff.

- [ ] **Step 2: Apply exactly these edits**

1. **Imports** — replace the six `@/utils/localpay/*` import lines (`:118-124` in the original) with one:

```tsx
import {
  MAX_FRAME_QR_CHARS,
  awdlTransport,
  buildPaymentFrame,
  decodeSession,
  encodeSession,
  finalizeDelivery,
  frameFromQr,
  frameToQr,
  isDeclineReason,
  isSessionSpent,
  localSupportsAwdl,
  markSessionSpent,
  mintSession,
  processPending,
  savePending,
  selectTransport,
  type Ack,
  type ConfirmDelivery,
  type DeclineReason,
  type PaymentFrame,
  type Session
} from '@/utils/pay/rails/nearby'
```

2. **Props and signature** — replace `export default function LocalPaymentsScreen() {` with:

```tsx
export interface NearbyFlowProps {
  /** Which side of the exchange this device is on. Set by the cell that mounted it. */
  role: 'payer' | 'payee'
  /** Leave the flow. The Pay screen decides what that means (back to the grid). */
  onExit: () => void
}

export default function NearbyFlow({ role: initialRole, onExit }: NearbyFlowProps) {
```

3. **Phase type** — replace `'role'` with `'entry'` in the `Phase` union. Keep every other member.

4. **Initial state** — `useState<Phase>('role')` becomes `useState<Phase>('entry')`, and `useState<'payee' | 'payer' | null>(null)` becomes `useState<'payee' | 'payer' | null>(initialRole)`.

5. **Entry effect** — add immediately after the `useFocusEffect` block (original `:390-398`):

```tsx
  // The grid already asked which side the user is on, so the old role screen is
  // gone. A payee goes straight to naming an amount; a payer straight to the
  // camera. Runs once per mount.
  const enteredRef = useRef(false)
  useEffect(() => {
    if (enteredRef.current) return
    enteredRef.current = true
    if (initialRole === 'payee') setPhase('receive_amount')
    else openScanner('send_scan')
  }, [initialRole, openScanner])
```

`openScanner` is declared below this point in the file; move its `useCallback` (original `:1098-1101`) up to just above this effect so the reference is defined at render time. Nothing else moves.

6. **`reset()`** — `setPhase('role')` becomes `setPhase(initialRole === 'payee' ? 'receive_amount' : 'entry')`, and `setRole(null)` becomes `setRole(initialRole)`. Add `initialRole` to its dependency array.

7. **`goBack`** — replace the body's `router.back()` with `onExit()`; drop the `router` import if nothing else uses it (check `grep -n "router\." components/pay/NearbyFlow.tsx`). Add `onExit` to the dependency array.

8. **`closeScanner`** — the `'role'` branch becomes `'entry'`:

```tsx
  const closeScanner = useCallback(() => {
    scanLatchRef.current = false
    setPhase(current => (current === 'receive_scan' ? 'receive_wait' : 'entry'))
  }, [])
```

9. **Header** — delete the whole `<View style={[styles.header, …]}>` block (original `:1198-1218`) and the `insets.top` padding on the container; `app/pay.tsx` owns the chrome. Keep `insets.bottom` on the ScrollView's `contentContainerStyle`. Leave `styles.header*` definitions in place (harmless) or delete them if lint flags them as unused.

10. **The `role` phase block** (original `:1230-1291`) becomes the payer's `entry` view. Replace its condition with `phase === 'entry' && initialRole === 'payer'` and its body's two role buttons with a single re-scan action, keeping the `__DEV__` block exactly as it is:

```tsx
        {phase === 'entry' && initialRole === 'payer' && (
          <Animated.View entering={settleIn} style={styles.stage}>
            <View style={[styles.heroCircle, { backgroundColor: colors.fillTertiary }]}>
              <Ionicons name="qr-code-outline" size={44} color={colors.textSecondary} />
            </View>
            <View style={styles.gapLg} />
            {phaseTitle(t('local_pay_scan_qr'))}
            {supportText(t('pay_pre_nearby'))}
            <View style={styles.gapXl} />
            <PrimaryButton
              styles={styles}
              colors={colors}
              icon="scan-outline"
              label={t('local_pay_scan_qr')}
              onPress={() => openScanner('send_scan')}
            />

            {/* TEMPORARY simulator affordance — __DEV__ only, never ships. */}
            {__DEV__ && (
              /* …the existing block, verbatim… */
            )}
          </Animated.View>
        )}
```

11. **Nothing else.** In particular: `settleReceived`, `startRequest`, `executeSend`, `abortBuild`, the AWDL listener effect, the celebration staging, `retrySettle`, both QR error handlers, `presence`, and every comment in them stay byte-identical.

- [ ] **Step 3: Verify the move did not change behaviour**

```bash
git diff --cached -M --stat            # after `git add -A`: should report a rename with a small delta
npx tsc --noEmit
npx jest                                # 210 existing tests must still pass
npm run lint
```

Then read the diff for the moved file and confirm every hunk is one of the eleven edits above:

```bash
git diff --cached -M components/pay/NearbyFlow.tsx | grep '^[-+]' | grep -v '^[-+][-+]' | head -80
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(pay): move the nearby flow into a component, unchanged

git mv of app/local-payments.tsx so the 1930 lines keep their history. Eleven
mechanical edits and nothing else: localpay imports go through the nearby
rail, the role screen becomes an entry phase driven by the caller's role prop,
the header moves to the Pay screen, and router.back becomes onExit. Every
money path — settleReceived, executeSend, abortBuild, the AWDL listener — is
byte-identical.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XHvqS5dJLcsbBYC2DfHNa5
EOF
)"
```

---

### Task 10: HandleSend component

Pay → someone with this app: search or scan a handle, name an amount, see the consequence, send. Plus the outgoing (outbox) list.

**Files:**
- Create: `components/pay/HandleSend.tsx`
- Reference to port from: `app/payments.tsx:68-209` (`useIdentitySearch`), `:228-301` (`useMessageBoxConfig`), `:303-320` (`ResultBanner`), `:324-414` (`OutgoingSection`), `:528-611` (`ConfigPanel`), `:613-752` (`RecipientField`), `:1136-1236` (send/retry/dismiss handlers).

**Interfaces:**
- Consumes: `sendViaHandle`, `retryDelivery`, `MESSAGE_BOX_URL_KEY`, `DEFAULT_MESSAGE_BOX_URL`, `NO_MESSAGE_BOX` from `@/utils/pay/rails/handle`; `CONSEQUENCE_KEYS` from `@/utils/pay/rails`; `useWallet`, `PeerPayClient`, identity helpers, `AmountInput`, `showToast`, `Celebration`.
- Produces:
  ```ts
  interface HandleSendProps {
    /** Prefilled recipient from a deep link or a scan (identity key hex). */
    initialIdentityKey?: string
    /** Prefilled amount in satoshis from a peerpay link. */
    initialSats?: number
    /** Error text from a malformed peerpay link, shown as a banner. */
    initialNotice?: string | null
  }
  export default function HandleSend(props: HandleSendProps): JSX.Element
  ```

- [ ] **Step 1: Move the shared pieces**

These four are used by both HandleSend and HandleReceive, so they go in `components/pay/` as their own files, copied verbatim from `app/payments.tsx`:

- `components/pay/useIdentitySearch.ts` ← `app/payments.tsx:62-209` (`peerPayValidationMessage` + `useIdentitySearch`)
- `components/pay/MessageBoxConfig.tsx` ← `:228-301` (`useMessageBoxConfig`) + `:528-611` (`ConfigPanel`), with the three constants now imported from `@/utils/pay/rails/handle` rather than redeclared
- `components/pay/ResultBanner.tsx` ← `:303-320`
- `components/pay/RecipientField.tsx` ← `:613-752`

Copy the styles each one needs out of `app/payments.tsx:1433-…` into a `StyleSheet.create` in its own file. Do not invent new visual values.

- [ ] **Step 2: Write HandleSend**

```tsx
/**
 * Pay → someone with this app.
 *
 * The recipient is a handle (an identity key, reached by search, scan or deep
 * link) and delivery is asynchronous: the token is dropped in their MessageBox
 * and lands when their wallet next checks. That is exactly what the consequence
 * line under the button says, and why it says it before the send rather than
 * after.
 */
import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { StatusBar } from 'expo-status-bar'
import { useTranslation } from 'react-i18next'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { PeerPayClient } from '@bsv/message-box-client'

import QRScanner from '@/components/QRScanner'
import { AmountInput } from '@/components/wallet/AmountInput'
import Celebration from '@/components/ui/Celebration'
import PressableScale from '@/components/ui/PressableScale'
import { showToast } from '@/components/ui/Toast'
import ResultBanner from '@/components/pay/ResultBanner'
import RecipientField from '@/components/pay/RecipientField'
import { ConfigPanel, useMessageBoxConfig } from '@/components/pay/MessageBoxConfig'
import { useIdentitySearch } from '@/components/pay/useIdentitySearch'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, typography, radii } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import { ExchangeRateContext } from '@/context/ExchangeRateContext'
import { formatAmount } from '@/utils/amountFormatHelpers'
import { CONSEQUENCE_KEYS } from '@/utils/pay/rails'
import { NO_MESSAGE_BOX, retryDelivery, sendViaHandle } from '@/utils/pay/rails/handle'
import {
  getOutboxEntries,
  removeOutboxEntry,
  type OutboxEntry
} from '@/utils/peerpay/outbox'
import { haptics } from '@/hooks/useHaptics'

const FIRST_PAYMENT_KEY = 'hasSentFirstPayment'

export interface HandleSendProps {
  initialIdentityKey?: string
  initialSats?: number
  initialNotice?: string | null
}

export default function HandleSend({ initialIdentityKey, initialSats, initialNotice }: HandleSendProps) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const { managers, adminOriginator, settings, storage } = useWallet()
  const wallet = managers?.permissionsManager || null
  const { satoshisPerUSD } = useContext(ExchangeRateContext)
  const currency = settings?.currency || 'BSV'

  const config = useMessageBoxConfig(t)
  const { messageBoxUrl } = config
  const isConfigured = !!messageBoxUrl && messageBoxUrl !== NO_MESSAGE_BOX

  const [sendAmount, setSendAmount] = useState(initialSats && initialSats > 0 ? String(initialSats) : '')
  const [notice, setNotice] = useState<{ type: 'error'; message: string } | null>(
    initialNotice ? { type: 'error', message: initialNotice } : null
  )
  const [isSending, setIsSending] = useState(false)
  const [sendResult, setSendResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [celebrating, setCelebrating] = useState(false)
  const [celebrationMessage, setCelebrationMessage] = useState('')
  const [outbox, setOutbox] = useState<OutboxEntry[]>([])
  const [retryingId, setRetryingId] = useState<string | null>(null)

  const search = useIdentitySearch(
    wallet as any,
    adminOriginator,
    initialIdentityKey,
    sats => setSendAmount(String(sats)),
    message => setNotice({ type: 'error', message })
  )

  const peerPayClient = useMemo<PeerPayClient | null>(() => {
    if (!isConfigured || !messageBoxUrl || !wallet) return null
    try {
      return new PeerPayClient({
        messageBoxHost: messageBoxUrl,
        walletClient: wallet as any,
        originator: adminOriginator
      })
    } catch {
      return null
    }
    // Intentionally no eager init: the library anoints lazily on first use, and
    // anointing needs a funded wallet — an init() on mount would fail silently
    // with no balance, latch initialized=true, and prevent any later retry.
  }, [isConfigured, messageBoxUrl, wallet, adminOriginator])

  const loadOutbox = useCallback(async () => {
    if (!storage) return
    setOutbox(await getOutboxEntries(storage))
  }, [storage])

  useEffect(() => {
    void loadOutbox()
  }, [loadOutbox])

  const handleSend = useCallback(async () => {
    const client = peerPayClient
    if (!client || !search.recipientKey || !storage) return
    const sats = Math.round(Number(sendAmount))
    if (!Number.isFinite(sats) || sats <= 0) {
      setSendResult({ type: 'error', message: t('enter_valid_amount') })
      setTimeout(() => setSendResult(null), 5000)
      return
    }
    haptics.confirm()
    setIsSending(true)
    try {
      await sendViaHandle({
        client,
        storage,
        recipient: search.recipientKey,
        satoshis: sats,
        messageBoxUrl
      })
      await loadOutbox()
      const amount = formatAmount(sats, currency, satoshisPerUSD)
      const isFirst = !(await AsyncStorage.getItem(FIRST_PAYMENT_KEY))
      if (isFirst) {
        await AsyncStorage.setItem(FIRST_PAYMENT_KEY, '1')
        setCelebrationMessage(`${t('paid')} ${amount}`)
        setCelebrating(true)
      } else {
        haptics.success()
        setSendResult({ type: 'success', message: `${t('paid')} ${amount}` })
      }
      setSendAmount('')
      search.clearRecipient()
    } catch (error: any) {
      const message = error instanceof RangeError ? t('enter_valid_amount') : error?.message || t('unknown_error')
      setSendResult({ type: 'error', message })
      // The outbox entry stays 'unsent' and is offered for retry below.
      await loadOutbox()
    } finally {
      setIsSending(false)
      setTimeout(() => setSendResult(null), 5000)
    }
  }, [peerPayClient, search, sendAmount, storage, messageBoxUrl, loadOutbox, currency, satoshisPerUSD, t])

  const handleRetry = useCallback(
    async (entry: OutboxEntry) => {
      const client = peerPayClient
      if (!client || !storage) return
      setRetryingId(entry.id)
      try {
        await retryDelivery({ client, storage, entry })
        showToast(t('payment_delivered'), { type: 'success' })
      } catch (e: any) {
        showToast(`${t('retry_failed')}: ${e?.message || t('unknown_error')}`, { type: 'error' })
      } finally {
        setRetryingId(null)
        await loadOutbox()
      }
    },
    [peerPayClient, storage, loadOutbox, t]
  )

  const handleDismiss = useCallback(
    async (id: string) => {
      if (!storage) return
      await removeOutboxEntry(storage, id)
      await loadOutbox()
    },
    [storage, loadOutbox]
  )

  const canSend = search.recipientKey.length > 0 && Number(sendAmount) > 0 && !isSending && isConfigured

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {/* Config lives behind the same gear the old screen used, not on the main path. */}
      {config.showConfig && <ConfigPanel {...config} colors={colors} t={t} />}
      {notice && <ResultBanner result={notice} onDismiss={() => setNotice(null)} colors={colors} />}

      <View style={styles.fieldGroup}>
        <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{t('recipient')}</Text>
        <RecipientField {...search} colors={colors} t={t} />
      </View>

      <View style={styles.fieldGroup}>
        <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{t('amount')}</Text>
        <AmountInput value={sendAmount} onChangeText={setSendAmount} />
      </View>

      {/* The consequence, before the button — not after. */}
      <Text style={[styles.consequence, { color: colors.textSecondary }]}>{t(CONSEQUENCE_KEYS.handle)}</Text>

      <PressableScale
        onPress={handleSend}
        disabled={!canSend}
        style={[styles.cta, { backgroundColor: canSend ? colors.accent : colors.fill, opacity: canSend ? 1 : 0.5 }]}
        accessibilityRole="button"
        accessibilityLabel={t('pay')}
        accessibilityState={{ disabled: !canSend }}
      >
        {isSending ? (
          <ActivityIndicator size="small" color={canSend ? colors.background : colors.textSecondary} />
        ) : (
          <>
            <Ionicons name="arrow-up" size={20} color={canSend ? colors.textOnAccent : colors.textTertiary} />
            <Text style={[styles.ctaText, { color: canSend ? colors.textOnAccent : colors.textTertiary }]}>
              {t('pay')}
            </Text>
          </>
        )}
      </PressableScale>

      {sendResult && <ResultBanner result={sendResult} onDismiss={() => setSendResult(null)} colors={colors} />}

      {/* Outgoing: unsent tokens offered for manual retry, exactly as before. */}
      {outbox.length > 0 && (
        <OutgoingSection
          entries={outbox}
          retryingId={retryingId}
          colors={colors}
          t={t}
          onRetry={handleRetry}
          onDismiss={handleDismiss}
        />
      )}

      <Modal
        visible={search.scannerVisible}
        animationType="slide"
        onRequestClose={() => search.setScannerVisible(false)}
        statusBarTranslucent
      >
        <StatusBar style="light" />
        <QRScanner
          multiScan
          onScan={search.handleQRScanned}
          onClose={() => search.setScannerVisible(false)}
          hintText={t('scan_identity_key_hint')}
        />
      </Modal>

      {celebrating && (
        <View style={styles.celebrationOverlay} pointerEvents="none">
          <Celebration
            onDone={() => {
              setCelebrating(false)
              setSendResult({ type: 'success', message: celebrationMessage })
            }}
          />
        </View>
      )}
    </ScrollView>
  )
}
```

`OutgoingSection` is `app/payments.tsx:334-414` copied verbatim into this file (drop its `loadingOutbox` prop and the spinner branch — the list now loads with the cell). Styles: copy `content`, `fieldGroup`, `fieldLabel`, `outgoing*`, `celebrationOverlay` from `app/payments.tsx`'s StyleSheet, and add:

```tsx
  consequence: {
    ...typography.footnote,
    marginBottom: spacing.md
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md + 2,
    borderRadius: radii.md
  },
  ctaText: {
    ...typography.subhead,
    fontWeight: '600'
  }
```

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit
npm run lint
```

There is no unit test for this component; it is exercised by Task 13's render test and Task 16's device pass. The logic it depends on is already tested in Task 7.

- [ ] **Step 4: Commit**

```bash
git add components/pay
git commit -m "$(cat <<'EOF'
feat(pay): Pay to a handle, with the consequence stated up front

Search/scan/deep-link a handle, name an amount, send through the tested
handle rail. The outgoing list keeps manual retry for unsent tokens.
Recipient field, identity search, message-box config and the result banner are
copied out of app/payments.tsx unchanged so both handle cells can share them.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XHvqS5dJLcsbBYC2DfHNa5
EOF
)"
```

---

### Task 11: HandleReceive component

Get paid → someone with this app: your handle (QR, copy, share link) and the inbox of payments waiting to be accepted. This is where the Identity-Key modal from `settings.tsx` lands.

**Files:**
- Create: `components/pay/HandleReceive.tsx`
- Reference to port from: `app/payments.tsx:418-526` (`IncomingPaymentsSection`), `:754-858` (`PaymentRow`), `:1007-1133` (fetch/accept/accept-all), `app/settings.tsx:183-208` (the QR presentation) and `:41-46` (copy).

**Interfaces:**
- Consumes: `internalizeIncoming`, `acceptWithRetry`, `peerPayLinkFor`, `NO_MESSAGE_BOX` from `@/utils/pay/rails/handle`; `resolveIdentity`, `makeIdentityClient` from `@/utils/identity/resolveIdentity`; `Share` from `react-native`; `Clipboard`; `QRCode`.
- Produces: `export default function HandleReceive(): JSX.Element` — no props.

- [ ] **Step 1: Write the component**

```tsx
/**
 * Get paid → someone with this app.
 *
 * Your handle in three forms, because the counterparty's situation decides
 * which one works: a QR to scan across a table, a copyable key to paste, and a
 * peerpay: link to send through any messaging app. All three carry the same
 * identity key — the link is the one the app can route itself, via
 * +native-intent, straight back into Pay → handle.
 *
 * Below it: the inbox. Incoming PeerPay payments are not automatic — accepting
 * one internalizes it — so the list, the per-payment note and Accept all are
 * carried over from the old Payments screen unchanged.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Share, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import Clipboard from '@react-native-clipboard/clipboard'
import QRCode from 'react-native-qrcode-svg'
import { useTranslation } from 'react-i18next'
import { PeerPayClient, type IncomingPayment } from '@bsv/message-box-client'
import type { DisplayableIdentity } from '@bsv/sdk'

import AmountDisplay from '@/components/wallet/AmountDisplay'
import ResultBanner from '@/components/pay/ResultBanner'
import { ConfigPanel, useMessageBoxConfig } from '@/components/pay/MessageBoxConfig'
import { useTheme } from '@/context/theme/ThemeContext'
import { radii, spacing, typography } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import { makeIdentityClient, resolveIdentity } from '@/utils/identity/resolveIdentity'
import { NO_MESSAGE_BOX, acceptWithRetry, internalizeIncoming, peerPayLinkFor } from '@/utils/pay/rails/handle'
import { showToast } from '@/components/ui/Toast'

export default function HandleReceive() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const { managers, adminOriginator } = useWallet()
  const wallet = managers?.permissionsManager || null

  const [identityKey, setIdentityKey] = useState('')
  const [copied, setCopied] = useState(false)
  const config = useMessageBoxConfig(t)
  const { messageBoxUrl } = config
  const isConfigured = !!messageBoxUrl && messageBoxUrl !== NO_MESSAGE_BOX

  const [payments, setPayments] = useState<IncomingPayment[]>([])
  const [loading, setLoading] = useState(false)
  const [acceptingId, setAcceptingId] = useState<string | null>(null)
  const [acceptingAll, setAcceptingAll] = useState(false)
  const [senderIdentities, setSenderIdentities] = useState<Record<string, DisplayableIdentity | null>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [result, setResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  useEffect(() => {
    wallet?.getPublicKey({ identityKey: true }, adminOriginator).then(r => r && setIdentityKey(r.publicKey))
  }, [wallet, adminOriginator])

  const peerPayClient = useMemo<PeerPayClient | null>(() => {
    if (!isConfigured || !messageBoxUrl || !wallet) return null
    try {
      return new PeerPayClient({
        messageBoxHost: messageBoxUrl,
        walletClient: wallet as any,
        originator: adminOriginator
      })
    } catch {
      return null
    }
  }, [isConfigured, messageBoxUrl, wallet, adminOriginator])

  const link = identityKey ? peerPayLinkFor(identityKey) : ''

  const handleCopy = useCallback(() => {
    if (!identityKey) return
    Clipboard.setString(identityKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [identityKey])

  const handleShare = useCallback(() => {
    if (!link) return
    // Share.share rejects when the sheet is dismissed on some platforms; a
    // dismissed share sheet is not an error worth a toast.
    void Share.share({ message: link }).catch(() => {})
  }, [link])

  const fetchPayments = useCallback(async () => {
    const client = peerPayClient
    if (!client || !messageBoxUrl || messageBoxUrl === NO_MESSAGE_BOX) return
    setLoading(true)
    try {
      const list = await client.listIncomingPayments(messageBoxUrl)
      setPayments(list)
      const idClient = makeIdentityClient(wallet as any, adminOriginator)
      if (idClient) {
        const senders = [...new Set(list.map(p => p.sender).filter(Boolean))] as string[]
        const entries = await Promise.all(senders.map(s => resolveIdentity(idClient, s)))
        setSenderIdentities(Object.fromEntries(entries))
      }
    } catch (error: any) {
      showToast(`${t('connection_failed')}: ${error?.message || t('unknown_error')}`, { type: 'error' })
    } finally {
      setLoading(false)
    }
  }, [peerPayClient, messageBoxUrl, wallet, adminOriginator, t])

  useEffect(() => {
    void fetchPayments()
  }, [fetchPayments])

  const internalize = useCallback(
    async (payment: IncomingPayment, description: string) => {
      const client = peerPayClient
      if (!client || !wallet) throw new Error(t('wallet_not_ready'))
      await internalizeIncoming(wallet as any, client, adminOriginator, payment, description)
    },
    [peerPayClient, wallet, adminOriginator, t]
  )

  const handleAccept = useCallback(
    async (payment: IncomingPayment) => {
      const client = peerPayClient
      if (!client) return
      const id = String(payment.messageId)
      const description = notes[id]?.trim() || 'Identity Payment'
      setAcceptingId(id)
      setEditingNoteId(null)
      try {
        await acceptWithRetry(client, messageBoxUrl, payment, description, internalize)
        setResult({ type: 'success', message: t('local_pay_added') })
        void fetchPayments()
      } catch (e: any) {
        setResult({ type: 'error', message: e?.message || t('unknown_error') })
      } finally {
        setAcceptingId(null)
        setTimeout(() => setResult(null), 5000)
      }
    },
    [peerPayClient, notes, messageBoxUrl, internalize, fetchPayments, t]
  )

  const handleAcceptAll = useCallback(async () => {
    const client = peerPayClient
    if (!client || payments.length === 0) return
    setAcceptingAll(true)
    setEditingNoteId(null)
    let successCount = 0
    let lastError: string | null = null
    for (const payment of payments) {
      const id = String(payment.messageId)
      const description = notes[id]?.trim() || 'Identity Payment'
      try {
        await acceptWithRetry(client, messageBoxUrl, payment, description, internalize)
        successCount++
      } catch (e: any) {
        lastError = e?.message || t('unknown_error')
      }
    }
    if (successCount > 0) {
      setResult({
        type: lastError ? 'error' : 'success',
        message: lastError
          ? `${t('local_pay_added_multiple', { count: successCount })} (${lastError})`
          : t('local_pay_added_multiple', { count: successCount })
      })
      void fetchPayments()
    } else if (lastError) {
      setResult({ type: 'error', message: lastError })
    }
    setAcceptingAll(false)
    setTimeout(() => setResult(null), 5000)
  }, [peerPayClient, payments, notes, messageBoxUrl, internalize, fetchPayments, t])

  return (
    <View style={styles.container}>
      {config.showConfig && <ConfigPanel {...config} colors={colors} t={t} />}

      {/* Your handle. The QR is the focal element — it is the thing physically
          held up to another device. */}
      <View style={styles.qrHero}>
        {identityKey ? (
          <View style={styles.qrPlate}>
            <QRCode value={identityKey} size={240} color="#000" backgroundColor="#fff" />
          </View>
        ) : (
          <ActivityIndicator size="large" color={colors.textSecondary} />
        )}
      </View>

      <Text style={[styles.keyText, { color: colors.textSecondary }]} numberOfLines={1} ellipsizeMode="middle">
        {identityKey}
      </Text>

      <View style={styles.actionRow}>
        <TouchableOpacity onPress={handleCopy} style={[styles.action, { backgroundColor: colors.fillTertiary }]}>
          <Ionicons
            name={copied ? 'checkmark' : 'copy-outline'}
            size={18}
            color={copied ? colors.success : colors.textSecondary}
          />
          <Text style={[styles.actionText, { color: copied ? colors.success : colors.textSecondary }]}>
            {copied ? t('copied') : t('pay_copy')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={handleShare}
          disabled={!link}
          style={[styles.action, { backgroundColor: colors.fillTertiary, opacity: link ? 1 : 0.5 }]}
        >
          <Ionicons name="share-outline" size={18} color={colors.textSecondary} />
          <Text style={[styles.actionText, { color: colors.textSecondary }]}>{t('pay_share_link')}</Text>
        </TouchableOpacity>
      </View>

      {/* The inbox. Accepting is what internalizes, so this stays explicit. */}
      <IncomingPaymentsSection
        isConfigured={isConfigured}
        loadingPayments={loading}
        payments={payments}
        senderIdentities={senderIdentities}
        acceptingId={acceptingId}
        acceptingAll={acceptingAll}
        editingNoteId={editingNoteId}
        paymentNotes={notes}
        acceptResult={null}
        colors={colors}
        t={t}
        onRefresh={fetchPayments}
        onAccept={handleAccept}
        onAcceptAll={handleAcceptAll}
        onEditNote={setEditingNoteId}
        onChangeNote={(id, text) => setNotes(prev => ({ ...prev, [id]: text }))}
        onSubmitNote={() => setEditingNoteId(null)}
        onDismissResult={() => setResult(null)}
      />
      {result && <ResultBanner result={result} onDismiss={() => setResult(null)} colors={colors} />}
    </View>
  )
}
```

`IncomingPaymentsSection` and `PaymentRow` are `app/payments.tsx:418-526` and `:754-858`, copied verbatim into this file. Copy the styles they use (`incomingSectionHeader`, `headerActions`, `acceptAllButton*`, `paymentsList`, `payment*`, `note*`, `centeredSmall`, `emptyText`, `sectionTitle`) from `app/payments.tsx`, and add:

```tsx
  container: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  qrHero: { alignItems: 'center', marginBottom: spacing.lg },
  qrPlate: { padding: spacing.lg, borderRadius: radii.xl, backgroundColor: '#fff' },
  keyText: { ...typography.caption1, fontFamily: 'monospace', textAlign: 'center', marginBottom: spacing.md },
  actionRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.xl },
  action: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.md
  },
  actionText: { ...typography.subhead, fontWeight: '500' }
```

- [ ] **Step 2: Verify**

```bash
npx tsc --noEmit
npm run lint
```

- [ ] **Step 3: Commit**

```bash
git add components/pay/HandleReceive.tsx
git commit -m "$(cat <<'EOF'
feat(pay): Get paid by handle — QR, copy, shareable peerpay link, inbox

Your handle in the three forms a counterparty might need, and the PeerPay
inbox (list, per-payment note, accept, accept all) carried over unchanged.
Absorbs the Identity Key QR that used to be its own row and modal in settings.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XHvqS5dJLcsbBYC2DfHNa5
EOF
)"
```

---

### Task 12: AddressSend and AddressReceive components

**Files:**
- Create: `components/pay/AddressSend.tsx`, `components/pay/AddressReceive.tsx`
- Reference to port from: `app/legacy-payments.tsx:611-714` (send form), `:486-608` (receive view), `:402-446` (validation + scan).

**Interfaces:**
- Consumes: from `@/utils/pay/rails/address` — `MAX_RECOVERY_DAYS`, `derivationPrefixFor`, `getCurrentDate`, `getPaymentAddress`, `getProcessedTransactions`, `sendToAddress`, `wocConfigFor`; from `@/utils/pay/rails` — `CONSEQUENCE_KEYS`, `isValidBsvAddress`, `normalizeAddressInput`; from `@/utils/pay/watchlist` — `watchAddress`.
- Produces:
  ```ts
  export default function AddressSend(props: { initialAddress?: string }): JSX.Element
  export default function AddressReceive(): JSX.Element
  ```

- [ ] **Step 1: Write AddressSend**

```tsx
/**
 * Pay → a conventional wallet.
 *
 * The one cell whose consequence line is load-bearing: this rail has no
 * notification mechanism at all, so a user who pastes an address expecting
 * messaging-style delivery has effectively posted cash. The line says so, in
 * the same place every time — under the amount, above the button.
 */
import React, { useCallback, useContext, useState } from 'react'
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { StatusBar } from 'expo-status-bar'
import { useTranslation } from 'react-i18next'

import QRScanner from '@/components/QRScanner'
import { AmountInput } from '@/components/wallet/AmountInput'
import PressableScale from '@/components/ui/PressableScale'
import { showToast } from '@/components/ui/Toast'
import { useTheme } from '@/context/theme/ThemeContext'
import { radii, spacing, typography } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import { ExchangeRateContext } from '@/context/ExchangeRateContext'
import { formatAmount } from '@/utils/amountFormatHelpers'
import { CONSEQUENCE_KEYS, isValidBsvAddress, normalizeAddressInput } from '@/utils/pay/rails'
import { sendToAddress } from '@/utils/pay/rails/address'

export default function AddressSend({ initialAddress }: { initialAddress?: string }) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const { managers, adminOriginator, settings } = useWallet()
  const wallet = managers?.permissionsManager || null
  const { satoshisPerUSD } = useContext(ExchangeRateContext)
  const currency = settings?.currency || 'BSV'

  const [address, setAddress] = useState(initialAddress ?? '')
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [scannerVisible, setScannerVisible] = useState(false)

  const onChangeAddress = useCallback(
    (text: string) => {
      setAddress(text)
      setError(text.length === 0 || isValidBsvAddress(text) ? null : t('invalid_bsv_address'))
    },
    [t]
  )

  const onScan = useCallback((data: string) => {
    const raw = normalizeAddressInput(data)
    if (!isValidBsvAddress(raw)) return // QRScanner auto-retries
    setAddress(raw)
    setError(null)
    setScannerVisible(false)
  }, [])

  const canSend = !!address && !!amount && !error && !isSending && Number(amount) > 0

  const handleSend = useCallback(async () => {
    if (!wallet) return
    const sats = Math.round(Number(amount))
    setIsSending(true)
    try {
      await sendToAddress({ wallet: wallet as any, adminOriginator, address, satoshis: sats })
      showToast(`${t('paid')} ${formatAmount(sats, currency, satoshisPerUSD)}`, { type: 'success' })
      setAddress('')
      setAmount('')
      setError(null)
    } catch (e: any) {
      showToast(e?.message || t('unknown_error'), { type: 'error' })
    } finally {
      setIsSending(false)
    }
  }, [wallet, adminOriginator, address, amount, currency, satoshisPerUSD, t])

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
      <View style={styles.fieldGroup}>
        <Text style={[styles.fieldLabel, { color: colors.textTertiary }]}>{t('recipient_address').toUpperCase()}</Text>
        <View
          style={[
            styles.inputRow,
            { backgroundColor: colors.backgroundSecondary, borderColor: error ? colors.error : colors.separator }
          ]}
        >
          <TextInput
            value={address}
            onChangeText={onChangeAddress}
            placeholder={t('enter_bsv_address')}
            placeholderTextColor={colors.textQuaternary}
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.input, { color: colors.textPrimary }]}
          />
          <TouchableOpacity onPress={() => setScannerVisible(true)} style={styles.inputAction} accessibilityLabel={t('scan_qr_code')}>
            <Ionicons name="qr-code-outline" size={20} color={colors.accent} />
          </TouchableOpacity>
        </View>
        {error ? <Text style={[styles.fieldError, { color: colors.error }]}>{error}</Text> : null}
      </View>

      <View style={styles.fieldGroup}>
        <Text style={[styles.fieldLabel, { color: colors.textTertiary }]}>{t('amount').toUpperCase()}</Text>
        <AmountInput value={amount} onChangeText={setAmount} />
      </View>

      {/* Never implicit. This rail cannot notify the payee. */}
      <View style={[styles.consequence, { backgroundColor: colors.fillTertiary, borderColor: colors.separator }]}>
        <Ionicons name="information-circle-outline" size={16} color={colors.textSecondary} />
        <Text style={[styles.consequenceText, { color: colors.textSecondary }]}>{t(CONSEQUENCE_KEYS.address)}</Text>
      </View>

      <PressableScale
        onPress={handleSend}
        disabled={!canSend}
        haptic="confirm"
        style={[styles.cta, { backgroundColor: canSend ? colors.accent : colors.fill }]}
        accessibilityRole="button"
        accessibilityLabel={t('pay')}
        accessibilityState={{ disabled: !canSend }}
      >
        {isSending ? (
          <ActivityIndicator size="small" color={canSend ? colors.background : colors.textTertiary} />
        ) : (
          <>
            <Ionicons name="arrow-up" size={20} color={canSend ? colors.textOnAccent : colors.textTertiary} />
            <Text style={[styles.ctaText, { color: canSend ? colors.textOnAccent : colors.textTertiary }]}>
              {t('pay')}
            </Text>
          </>
        )}
      </PressableScale>

      <Modal visible={scannerVisible} animationType="slide" onRequestClose={() => setScannerVisible(false)} statusBarTranslucent>
        <StatusBar style="light" />
        <QRScanner multiScan onScan={onScan} onClose={() => setScannerVisible(false)} hintText={t('scan_bsv_address_hint')} />
      </Modal>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  fieldGroup: { marginBottom: spacing.xl },
  fieldLabel: { ...typography.caption2, fontWeight: '600', letterSpacing: 0.8, marginBottom: spacing.sm },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden'
  },
  input: { ...typography.body, flex: 1, paddingHorizontal: spacing.md, paddingVertical: spacing.md },
  inputAction: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  fieldError: { ...typography.caption1, marginTop: spacing.xs },
  consequence: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.lg
  },
  consequenceText: { ...typography.footnote, flex: 1 },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md + 2,
    borderRadius: radii.md
  },
  ctaText: { ...typography.subhead, fontWeight: '600' }
})
```

- [ ] **Step 2: Write AddressReceive**

```tsx
/**
 * Get paid → a conventional wallet.
 *
 * Show the address, and money appears: the sweep runs in WalletContext, not
 * here, so this view registers today's address on the watchlist and then
 * stays out of the way. The day-offset stepper survives as a recovery
 * affordance only — a previously-issued address whose funds cannot be swept is
 * lost money — which is why it is behind a disclosure rather than on the main
 * view.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import Clipboard from '@react-native-clipboard/clipboard'
import QRCode from 'react-native-qrcode-svg'
import { useTranslation } from 'react-i18next'
import { formatDistanceToNow } from 'date-fns'

import AmountDisplay from '@/components/wallet/AmountDisplay'
import { useTheme } from '@/context/theme/ThemeContext'
import { radii, spacing, typography } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import { showToast } from '@/components/ui/Toast'
import {
  MAX_RECOVERY_DAYS,
  derivationPrefixFor,
  getCurrentDate,
  getPaymentAddress,
  getProcessedTransactions,
  sweepAddress,
  wocConfigFor,
  type ProcessedTx
} from '@/utils/pay/rails/address'
import { watchAddress } from '@/utils/pay/watchlist'

export default function AddressReceive() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const { managers, adminOriginator, selectedNetwork, storage } = useWallet()
  const wallet = managers?.permissionsManager || null
  const woc = wocConfigFor(selectedNetwork)

  const [daysOffset, setDaysOffset] = useState(0)
  const [address, setAddress] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [processed, setProcessed] = useState<ProcessedTx[]>([])
  const [showRecovery, setShowRecovery] = useState(false)
  const [sweeping, setSweeping] = useState(false)

  const load = useCallback(
    async (offset: number) => {
      if (!wallet) return
      setLoading(true)
      try {
        const date = getCurrentDate(offset)
        const derivationPrefix = derivationPrefixFor(date)
        const next = await getPaymentAddress(wallet as any, adminOriginator, derivationPrefix, woc.network)
        setDaysOffset(offset)
        setAddress(next)
        // Registering is what makes the background sweeper poll it. Every
        // address the user is shown gets watched — including a recovered one.
        if (storage) await watchAddress(storage as any, { address: next, date, derivationPrefix })
        setProcessed(await getProcessedTransactions(wallet as any, adminOriginator, next))
      } catch (e: any) {
        showToast(e?.message || t('unable_to_generate_address'), { type: 'error' })
      } finally {
        setLoading(false)
      }
    },
    [wallet, adminOriginator, woc.network, storage, t]
  )

  useEffect(() => {
    if (wallet) void load(0)
  }, [wallet]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleCopy = useCallback(() => {
    if (!address) return
    Clipboard.setString(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [address])

  /**
   * Sweep this address now. The background pass covers the common case; this
   * exists for a recovered day, where the user is standing in front of the
   * screen precisely because they want an answer immediately.
   */
  const handleSweepNow = useCallback(async () => {
    if (!wallet || !address) return
    setSweeping(true)
    try {
      const { importedSatoshis } = await sweepAddress({
        wallet: wallet as any,
        adminOriginator,
        woc,
        address,
        derivationPrefix: derivationPrefixFor(getCurrentDate(daysOffset))
      })
      showToast(
        importedSatoshis > 0 ? t('local_pay_added') : t('no_pending_payments'),
        { type: importedSatoshis > 0 ? 'success' : 'info' }
      )
      setProcessed(await getProcessedTransactions(wallet as any, adminOriginator, address))
    } catch (e: any) {
      showToast(e?.message || t('unknown_error'), { type: 'error' })
    } finally {
      setSweeping(false)
    }
  }, [wallet, address, adminOriginator, woc, daysOffset, t])

  return (
    <ScrollView contentContainerStyle={styles.content}>
      {loading && !address ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={[styles.support, { color: colors.textSecondary }]}>{t('generating_address')}</Text>
        </View>
      ) : !address ? (
        <View style={styles.centered}>
          <Text style={[styles.support, { color: colors.textSecondary }]}>{t('unable_to_generate_address')}</Text>
        </View>
      ) : (
        <>
          <View style={styles.qrHero}>
            <View style={styles.qrPlate}>
              <QRCode value={address} size={240} color="#000" backgroundColor="#fff" />
            </View>
          </View>

          <TouchableOpacity onPress={handleCopy} style={[styles.addressChip, { backgroundColor: colors.fillTertiary }]}>
            <Text style={[styles.addressText, { color: colors.textSecondary }]} numberOfLines={1} ellipsizeMode="middle">
              {address}
            </Text>
            <View style={[styles.copyPill, { backgroundColor: copied ? colors.success + '20' : colors.fill }]}>
              <Ionicons
                name={copied ? 'checkmark' : 'copy-outline'}
                size={16}
                color={copied ? colors.success : colors.textSecondary}
              />
              <Text style={[styles.copyText, { color: copied ? colors.success : colors.textSecondary }]}>
                {copied ? t('copied') : t('pay_copy')}
              </Text>
            </View>
          </TouchableOpacity>

          {/* No Check balance, no Import funds: the sweep is automatic now. */}
          <Text style={[styles.watching, { color: colors.textTertiary }]}>{t('pay_address_watching')}</Text>

          {processed.length > 0 && (
            <>
              <View style={[styles.totalRow, { borderTopColor: colors.separator }]}>
                <Text style={[styles.totalLabel, { color: colors.textSecondary }]}>{t('imported')}</Text>
                <Text style={[styles.totalValue, { color: colors.success }]}>
                  <AmountDisplay>{processed.reduce((sum, tx) => sum + tx.satoshis, 0)}</AmountDisplay>
                </Text>
              </View>
              <View style={[styles.log, { borderColor: colors.separator }]}>
                {processed.map((tx, i) => (
                  <View
                    key={tx.txid}
                    style={[
                      styles.logRow,
                      i < processed.length - 1 && {
                        borderBottomWidth: StyleSheet.hairlineWidth,
                        borderBottomColor: colors.separator
                      }
                    ]}
                  >
                    <Ionicons name="checkmark-circle" size={14} color={colors.success} />
                    <Text style={[styles.logSats, { color: colors.success }]}>
                      +<AmountDisplay>{tx.satoshis}</AmountDisplay>
                    </Text>
                    {tx.importedAt ? (
                      <Text style={[styles.logTime, { color: colors.textTertiary }]}>
                        {formatDistanceToNow(tx.importedAt, { addSuffix: true })}
                      </Text>
                    ) : (
                      <Text style={[styles.logTxid, { color: colors.textTertiary }]} numberOfLines={1} ellipsizeMode="middle">
                        {tx.txid}
                      </Text>
                    )}
                  </View>
                ))}
              </View>
            </>
          )}

          {/* ── Recovery. Secondary by design: reaching an earlier day is the
                 uncommon case of a payer who sat on an address. It must exist —
                 unswept funds on an unreachable address are lost — but it is not
                 a primary control. */}
          <TouchableOpacity onPress={() => setShowRecovery(v => !v)} style={styles.disclosure} hitSlop={8}>
            <Ionicons name={showRecovery ? 'chevron-down' : 'chevron-forward'} size={16} color={colors.textTertiary} />
            <Text style={[styles.disclosureText, { color: colors.textTertiary }]}>{t('pay_address_earlier_day')}</Text>
          </TouchableOpacity>

          {showRecovery && (
            <View style={styles.recovery}>
              <View style={styles.dateRow}>
                <TouchableOpacity
                  onPress={() => void load(Math.min(MAX_RECOVERY_DAYS, daysOffset + 1))}
                  disabled={daysOffset >= MAX_RECOVERY_DAYS}
                  hitSlop={8}
                  style={styles.dateArrow}
                >
                  <Ionicons
                    name="chevron-back"
                    size={20}
                    color={daysOffset >= MAX_RECOVERY_DAYS ? colors.textQuaternary : colors.accent}
                  />
                </TouchableOpacity>
                <Text style={[styles.dateText, { color: colors.textSecondary }]}>{getCurrentDate(daysOffset)}</Text>
                <TouchableOpacity
                  onPress={() => void load(Math.max(0, daysOffset - 1))}
                  disabled={daysOffset === 0}
                  hitSlop={8}
                  style={styles.dateArrow}
                >
                  <Ionicons
                    name="chevron-forward"
                    size={20}
                    color={daysOffset === 0 ? colors.textQuaternary : colors.accent}
                  />
                </TouchableOpacity>
              </View>
              <TouchableOpacity
                onPress={handleSweepNow}
                disabled={sweeping}
                style={[styles.sweepButton, { borderColor: colors.separator }]}
              >
                {sweeping ? (
                  <ActivityIndicator size="small" color={colors.accent} />
                ) : (
                  <Text style={[styles.sweepText, { color: colors.accent }]}>{t('pay_address_sweep_now')}</Text>
                )}
              </TouchableOpacity>
            </View>
          )}
        </>
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  centered: { alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.xxxl, gap: spacing.md },
  support: { ...typography.subhead, textAlign: 'center' },
  qrHero: { alignItems: 'center', marginBottom: spacing.lg },
  qrPlate: { padding: spacing.lg, borderRadius: radii.xl, backgroundColor: '#fff' },
  addressChip: { borderRadius: radii.lg, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.sm },
  addressText: { ...typography.footnote, fontFamily: 'monospace', textAlign: 'center' },
  copyPill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg
  },
  copyText: { ...typography.subhead, fontWeight: '500' },
  watching: { ...typography.footnote, textAlign: 'center', marginTop: spacing.md },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.lg,
    marginTop: spacing.lg,
    marginBottom: spacing.md
  },
  totalLabel: { ...typography.subhead },
  totalValue: { ...typography.headline, fontWeight: '700' },
  log: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.md, overflow: 'hidden' },
  logRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm, paddingHorizontal: spacing.md },
  logSats: { ...typography.subhead, fontWeight: '600' },
  logTxid: { ...typography.caption1, fontFamily: 'monospace', flex: 1 },
  logTime: { ...typography.caption1, fontFamily: 'monospace' },
  disclosure: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.xl },
  disclosureText: { ...typography.footnote },
  recovery: { marginTop: spacing.md, gap: spacing.md },
  dateRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  dateArrow: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  dateText: {
    ...typography.footnote,
    fontFamily: 'monospace',
    fontWeight: '500',
    minWidth: 100,
    textAlign: 'center',
    letterSpacing: 0.3
  },
  sweepButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth
  },
  sweepText: { ...typography.subhead, fontWeight: '500' }
})
```

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit
npm run lint
```

- [ ] **Step 4: Commit**

```bash
git add components/pay/AddressSend.tsx components/pay/AddressReceive.tsx
git commit -m "$(cat <<'EOF'
feat(pay): address cells — send with a stated consequence, receive that sweeps itself

Send keeps the address validation and P2PKH path from legacy-payments and adds
the one line that must never be implicit: sent, they are not notified. Receive
registers each shown address on the watchlist and lets the background sweeper
do the work; the day-offset stepper survives behind a disclosure as a recovery
path, with an explicit sweep-now for the day you just recovered.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XHvqS5dJLcsbBYC2DfHNa5
EOF
)"
```

---

### Task 13: The `/pay` screen

Six cells, one screen, one route. The user picks a row; the transport is inferred.

**Files:**
- Create: `app/pay.tsx`, `components/pay/PayCellRow.tsx`
- Modify: `app/_layout.tsx` (add `<Stack.Screen name="pay" />`)
- Test: `__tests__/payScreen.test.tsx`

**Interfaces:**
- Consumes: `PayCell`, `isPayCell`, `PRECONDITION_KEYS` from `@/utils/pay/rails`; `validatePeerPayURI`; all six cell components.
- Produces: the route. Params it accepts: `cell` (a `PayCell`), `identityKey`, `sats`, `peerpay`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/payScreen.test.tsx`:

```tsx
/**
 * Render-level coverage for the Pay screen. The point is not the pixels: it is
 * that the grid renders both directions, that a cell opens, and that a deep
 * link preselects one — the three things a broken route would silently lose.
 */
import React from 'react'
import { render } from '@testing-library/react-native'

const mockParams: Record<string, string> = {}
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => mockParams,
  useFocusEffect: () => {}
}))
jest.mock('@/components/pay/NearbyFlow', () => 'NearbyFlow')
jest.mock('@/components/pay/HandleSend', () => 'HandleSend')
jest.mock('@/components/pay/HandleReceive', () => 'HandleReceive')
jest.mock('@/components/pay/AddressSend', () => 'AddressSend')
jest.mock('@/components/pay/AddressReceive', () => 'AddressReceive')

import PayScreen from '@/app/pay'

// The screen reads wallet + theme + i18n from context. Wrap in whatever the
// existing render-sanity test uses — see __tests__/render-sanity.test.tsx — and
// mirror its provider stack here.

describe('PayScreen', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockParams)) delete mockParams[k]
  })

  it('renders the three counterparty rows for the Pay direction', () => {
    const { getByText } = render(<PayScreen />)
    expect(getByText('pay_cell_nearby_pay')).toBeTruthy()
    expect(getByText('pay_cell_handle_pay')).toBeTruthy()
    expect(getByText('pay_cell_address_pay')).toBeTruthy()
  })

  it('opens the handle cell when a deep link names it', () => {
    mockParams.cell = 'pay-handle'
    const { UNSAFE_getByType } = render(<PayScreen />)
    expect(UNSAFE_getByType('HandleSend' as never)).toBeTruthy()
  })

  it('opens the handle cell for a peerpay link and forwards the key', () => {
    mockParams.peerpay = 'peerpay:0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798?sats=1000'
    const { UNSAFE_getByType } = render(<PayScreen />)
    const cell = UNSAFE_getByType('HandleSend' as never)
    expect(cell.props.initialIdentityKey).toBe('0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798')
    expect(cell.props.initialSats).toBe(1000)
  })

  it('opens the nearby payee cell for the get-nearby link', () => {
    mockParams.cell = 'get-nearby'
    const { UNSAFE_getByType } = render(<PayScreen />)
    expect(UNSAFE_getByType('NearbyFlow' as never).props.role).toBe('payee')
  })

  it('ignores an unknown cell param and shows the grid', () => {
    mockParams.cell = 'nonsense'
    const { getByText } = render(<PayScreen />)
    expect(getByText('pay_cell_nearby_pay')).toBeTruthy()
  })
})
```

Before writing the implementation, read `__tests__/render-sanity.test.tsx` and copy its provider wrapper and its i18n handling (translations may resolve to the key itself under test, which is what the assertions above assume). If that file shows a different convention — e.g. `renderWithProviders` — use it and adjust the assertions to match real English strings.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest __tests__/payScreen.test.tsx`
Expected: FAIL — `Cannot find module '@/app/pay'`.

- [ ] **Step 3: Write PayCellRow**

```tsx
/**
 * One row of the counterparty picker. A row, not a grid tile: six tiles on one
 * screen is a worse maze than three menu rows, and the row form keeps one
 * focal element per line — the title — with the transport hint demoted to a
 * subtitle where transport names are allowed to live.
 */
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import PressableScale from '@/components/ui/PressableScale'
import { useTheme } from '@/context/theme/ThemeContext'
import { radii, spacing, typography } from '@/context/theme/tokens'

export interface PayCellRowProps {
  title: string
  subtitle: string
  icon: keyof typeof Ionicons.glyphMap
  onPress: () => void
}

export default function PayCellRow({ title, subtitle, icon, onPress }: PayCellRowProps) {
  const { colors } = useTheme()
  return (
    <PressableScale
      onPress={onPress}
      haptic="tap"
      scaleTo={0.98}
      style={[styles.row, { backgroundColor: colors.backgroundElevated, borderColor: colors.separator }]}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${subtitle}`}
    >
      <View style={[styles.iconWrap, { backgroundColor: colors.fillTertiary }]}>
        <Ionicons name={icon} size={20} color={colors.textSecondary} />
      </View>
      <View style={styles.text}>
        <Text style={[styles.title, { color: colors.textPrimary }]} numberOfLines={1}>
          {title}
        </Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]} numberOfLines={2}>
          {subtitle}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textQuaternary} />
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth
  },
  iconWrap: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1 },
  title: { ...typography.headline, fontWeight: '600' },
  subtitle: { ...typography.footnote }
})
```

- [ ] **Step 4: Write app/pay.tsx**

```tsx
/**
 * Pay — one screen, six cells.
 *
 * Direction is the primary axis because it is the first thing a user knows
 * about their own situation; who the counterparty is comes second, and IT is
 * what determines the rail. The user never picks a transport: see
 * utils/pay/rails/index.ts, where the rail is inferred from how the
 * counterparty was identified.
 *
 * Replaces /payments, /legacy-payments, /local-payments and the Identity Key
 * modal in settings.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { I18nManager, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { router, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'

import PressableScale from '@/components/ui/PressableScale'
import PayCellRow from '@/components/pay/PayCellRow'
import NearbyFlow from '@/components/pay/NearbyFlow'
import HandleSend from '@/components/pay/HandleSend'
import HandleReceive from '@/components/pay/HandleReceive'
import AddressSend from '@/components/pay/AddressSend'
import AddressReceive from '@/components/pay/AddressReceive'
import { useTheme } from '@/context/theme/ThemeContext'
import { radii, spacing, typography } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import { validatePeerPayURI } from '@/utils/parsePeerPayURI'
import { isPayCell, type PayCell } from '@/utils/pay/rails'

type Direction = 'pay' | 'get'

const firstParam = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

interface CellSpec {
  cell: PayCell
  titleKey: string
  subtitleKey: string
  icon: keyof typeof Ionicons.glyphMap
}

const CELLS: Record<Direction, CellSpec[]> = {
  pay: [
    { cell: 'pay-nearby', titleKey: 'pay_cell_nearby_pay', subtitleKey: 'pay_cell_nearby_pay_sub', icon: 'scan-outline' },
    { cell: 'pay-handle', titleKey: 'pay_cell_handle_pay', subtitleKey: 'pay_cell_handle_pay_sub', icon: 'person-outline' },
    { cell: 'pay-address', titleKey: 'pay_cell_address_pay', subtitleKey: 'pay_cell_address_pay_sub', icon: 'wallet-outline' }
  ],
  get: [
    { cell: 'get-nearby', titleKey: 'pay_cell_nearby_get', subtitleKey: 'pay_cell_nearby_get_sub', icon: 'qr-code-outline' },
    { cell: 'get-handle', titleKey: 'pay_cell_handle_get', subtitleKey: 'pay_cell_handle_get_sub', icon: 'person-outline' },
    { cell: 'get-address', titleKey: 'pay_cell_address_get', subtitleKey: 'pay_cell_address_get_sub', icon: 'wallet-outline' }
  ]
}

const CELL_TITLE_KEYS: Record<PayCell, string> = {
  'pay-nearby': 'pay_cell_nearby_pay',
  'pay-handle': 'pay_cell_handle_pay',
  'pay-address': 'pay_cell_address_pay',
  'get-nearby': 'pay_cell_nearby_get',
  'get-handle': 'pay_cell_handle_get',
  'get-address': 'pay_cell_address_get'
}

export default function PayScreen() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { walletBuilding, walletBuilt } = useWallet()

  const params = useLocalSearchParams<{
    cell?: string | string[]
    identityKey?: string | string[]
    sats?: string | string[]
    peerpay?: string | string[]
  }>()

  const peerpay = firstParam(params.peerpay)
  const peerPayValidation = useMemo(() => (peerpay ? validatePeerPayURI(peerpay) : null), [peerpay])
  const peerPayNotice = useMemo(() => {
    if (!peerPayValidation) return null
    const messages = [peerPayValidation.errors.identityKey, peerPayValidation.errors.sats].filter(Boolean)
    return messages.length ? messages.join('. ') : null
  }, [peerPayValidation])

  const initialIdentityKey = peerPayValidation?.identityKey ?? firstParam(params.identityKey)
  const satsParam = peerPayValidation?.sats ?? Number(firstParam(params.sats))
  const initialSats = Number.isFinite(satsParam) && satsParam > 0 ? Number(satsParam) : undefined

  const paramCell = firstParam(params.cell)
  // A peerpay link is a request to pay a handle, whatever cell was named.
  const openingCell: PayCell | null = peerpay ? 'pay-handle' : isPayCell(paramCell) ? paramCell : null

  const [direction, setDirection] = useState<Direction>(openingCell?.startsWith('get') ? 'get' : 'pay')
  const [cell, setCell] = useState<PayCell | null>(openingCell)

  // Auth failed while this screen was open (the wallet finished building and
  // there is no wallet) — same guard the old payments screen carried.
  const prevBuilding = React.useRef(walletBuilding)
  useEffect(() => {
    const wasBuilding = prevBuilding.current
    prevBuilding.current = walletBuilding
    if (wasBuilding && !walletBuilding && !walletBuilt) {
      if (router.canGoBack()) router.back()
      else router.replace('/')
    }
  }, [walletBuilding, walletBuilt])

  const goBack = useCallback(() => {
    if (cell) setCell(null)
    else if (router.canGoBack()) router.back()
    else router.replace('/')
  }, [cell])

  const body = () => {
    switch (cell) {
      case 'pay-nearby':
        return <NearbyFlow role="payer" onExit={() => setCell(null)} />
      case 'get-nearby':
        return <NearbyFlow role="payee" onExit={() => setCell(null)} />
      case 'pay-handle':
        return (
          <HandleSend
            initialIdentityKey={initialIdentityKey}
            initialSats={initialSats}
            initialNotice={peerPayNotice}
          />
        )
      case 'get-handle':
        return <HandleReceive />
      case 'pay-address':
        return <AddressSend />
      case 'get-address':
        return <AddressReceive />
      default:
        return grid()
    }
  }

  const grid = () => (
    <View style={styles.grid}>
      {/* Direction first: it is what the user already knows. */}
      <View style={[styles.segment, { backgroundColor: colors.fillTertiary }]}>
        {(['pay', 'get'] as const).map(d => {
          const active = direction === d
          return (
            <PressableScale
              key={d}
              onPress={() => setDirection(d)}
              haptic="tap"
              scaleTo={0.98}
              style={[styles.segmentBtn, active && { backgroundColor: colors.background }]}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={t(d === 'pay' ? 'pay_direction_pay' : 'pay_direction_receive')}
            >
              <Text
                style={[styles.segmentLabel, { color: active ? colors.textPrimary : colors.textTertiary }]}
              >
                {t(d === 'pay' ? 'pay_direction_pay' : 'pay_direction_receive')}
              </Text>
            </PressableScale>
          )
        })}
      </View>

      <View style={styles.rows}>
        {CELLS[direction].map(spec => (
          <PayCellRow
            key={spec.cell}
            title={t(spec.titleKey)}
            subtitle={t(spec.subtitleKey)}
            icon={spec.icon}
            onPress={() => setCell(spec.cell)}
          />
        ))}
      </View>
    </View>
  )

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: colors.separator }]}>
        <PressableScale onPress={goBack} haptic="tap" style={styles.headerBtn} accessibilityRole="button" accessibilityLabel={t('back')}>
          <Ionicons name={I18nManager.isRTL ? 'chevron-forward' : 'chevron-back'} size={24} color={colors.accent} />
        </PressableScale>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]} numberOfLines={1}>
          {cell ? t(CELL_TITLE_KEYS[cell]) : t('pay')}
        </Text>
        <View style={styles.headerBtn} />
      </View>
      <View style={{ flex: 1, backgroundColor: colors.background }}>{body()}</View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  headerBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { ...typography.headline, fontWeight: '600', flex: 1, textAlign: 'center' },
  grid: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  segment: { flexDirection: 'row', borderRadius: radii.xl, padding: 2, marginBottom: spacing.xl },
  segmentBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.sm + 2, borderRadius: radii.xl - 2 },
  segmentLabel: { ...typography.subhead, fontWeight: '500' },
  rows: { gap: spacing.md }
})
```

- [ ] **Step 5: Register the route**

In `app/_layout.tsx`, inside the `<Stack>` (beside `:149-151`), add `<Stack.Screen name="pay" />`. Leave the three legacy entries in place — Task 14 turns their files into redirects, and a registered-but-redirecting screen is what makes an old link resolve instead of hitting `+not-found`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx jest __tests__/payScreen.test.tsx`
Expected: PASS. If the provider wrapper fights you, reduce the test to the three assertions that matter (grid renders, `cell` param opens a cell, `peerpay` param forwards the key and amount) rather than deleting the file.

Then: `npx jest`, `npx tsc --noEmit`, `npm run lint`.

- [ ] **Step 7: Commit**

```bash
git add app/pay.tsx components/pay/PayCellRow.tsx app/_layout.tsx __tests__/payScreen.test.tsx
git commit -m "$(cat <<'EOF'
feat(pay): one Pay screen, six cells, transport inferred

Direction (Pay / Get paid) as the primary axis, counterparty as the secondary
one, and the rail derived from the counterparty rather than chosen. Rows not
tiles, so each line keeps one focal element and the transport name stays in the
subtitle where it belongs. Deep-link params — cell, identityKey, sats, peerpay
— preselect a cell; a peerpay link always opens Pay to a handle.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XHvqS5dJLcsbBYC2DfHNa5
EOF
)"
```

---

### Task 14: Migration — menu, redirects, deep links

**Files:**
- Modify: `app/settings.tsx` (four rows + QR modal → one), `app/+native-intent.ts:5`, `hooks/useDeepLinking.ts:94-96`
- Replace: `app/payments.tsx`, `app/legacy-payments.tsx`, `app/local-payments.tsx` with redirect stubs (`local-payments.tsx` was already moved in Task 9, so it must be recreated as a stub)
- Test: extend `__tests__/payRails.test.ts` — `legacyRedirectTarget` is already covered by Task 1; add nothing new unless a stub needs a behaviour the function does not express.

- [ ] **Step 1: Write the three stubs**

`app/payments.tsx`:

```tsx
/**
 * Retired route. Everything this screen did now lives in /pay → Pay → a handle.
 *
 * The file stays as a redirect because `peerpay:` deep links from before this
 * change — and anything a user has bookmarked — still target it. The target is
 * computed by legacyRedirectTarget so the mapping is tested in one place.
 */
import { Redirect, useLocalSearchParams } from 'expo-router'
import { legacyRedirectTarget } from '@/utils/pay/rails'

export default function RetiredPaymentsRoute() {
  const params = useLocalSearchParams<Record<string, string | string[]>>()
  const flat = Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])
  ) as Record<string, string | undefined>
  return <Redirect href={legacyRedirectTarget('payments', flat) as never} />
}
```

`app/legacy-payments.tsx` and `app/local-payments.tsx`: the same, with `'legacy-payments'` / `'local-payments'` and a matching component name and comment (`… now lives in /pay → Get paid → a conventional wallet` / `… → Get paid → someone nearby`).

Check `Redirect`'s accepted `href` shape for this expo-router version — `grep -rn "Redirect" node_modules/expo-router/build/link/Redirect.d.ts` — and drop the `as never` if the object form types cleanly.

- [ ] **Step 2: Rewrite the settings rows**

In `app/settings.tsx`, replace the three `ListRow`s at `:122-139` **and** the `identityKey` row at `:140-167` with one:

```tsx
          <ListRow
            label={t('pay')}
            icon="swap-horizontal-outline"
            iconColor={colors.success}
            onPress={() => router.push('/pay' as any)}
            isLast
          />
```

Then delete, in the same file: the `showQr` state (`:30`), the `copiedKey` state and `handleCopyKey` (`:29`, `:41-46`), the whole Identity-Key QR `<Modal>` (`:182-208`), the `qrBackdrop`/`qrPopover*`/`qrCard`/`qrKeyLabel` styles (`:233-287`), and the now-unused `QRCode`, `Clipboard` and `Ionicons` imports (check each with grep before removing — `Ionicons` may still be used elsewhere in the file).

Keep the `identityKey` fetch effect only if something else in the file uses it; if not, delete it and the `identityKey` state too. The identity key now lives in Get paid → handle, which is the accepted regression the spec names.

- [ ] **Step 3: Repoint the deep links**

`app/+native-intent.ts:5`:

```ts
    if (path?.toLowerCase().startsWith('peerpay:')) {
      return `/pay?cell=pay-handle&peerpay=${encodeURIComponent(path)}`
    }
```

`hooks/useDeepLinking.ts:94-96`:

```ts
  const handlePeerPayLink = useCallback((url: string) => {
    router.replace({ pathname: '/pay', params: { cell: 'pay-handle', peerpay: url } })
  }, [])
```

- [ ] **Step 4: Verify nothing still points at the old routes**

```bash
grep -rn "'/payments'\|'/legacy-payments'\|'/local-payments'" app components hooks utils context stores services --include="*.ts" --include="*.tsx"
```

Expected: no matches outside the three stub files' own comments.

```bash
npx jest
npx tsc --noEmit
npm run lint
```

- [ ] **Step 5: Commit**

```bash
git add app/settings.tsx app/payments.tsx app/legacy-payments.tsx app/local-payments.tsx app/+native-intent.ts hooks/useDeepLinking.ts
git commit -m "$(cat <<'EOF'
feat(pay): four wallet-menu rows become one, old routes redirect

Payments, Legacy Bridge, Local Payments and the Identity Key modal collapse
into a single Pay row. The three old paths stay as tested redirect stubs
because peerpay: deep links from earlier builds still target /payments;
+native-intent and useDeepLinking now send them to /pay with the handle cell
preselected. The identity-key QR moves to Get paid → handle, the accepted
regression the design names.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XHvqS5dJLcsbBYC2DfHNa5
EOF
)"
```

---

### Task 15: i18n — new keys in 12 locales, orphans removed

**Files:**
- Modify: `context/i18n/translations.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: the keys every component above already calls. Locale block start lines (they shift as you edit — re-grep rather than trusting these): `en:100`, `zh:397`, `hi:677`, `es:960`, `fr:1245`, `ar:1524`, `pt:1799`, `bn:2078`, `ru:2355`, `id:2634`, `ja:2911`, `pl:3205`.

- [ ] **Step 1: Add the English keys**

In the `en` block, replacing the `payments:` / `legacy_bridge:` pair around `:178-179` and adding a new section beside the Local payments one:

```ts
      // Pay screen
      pay: 'Pay',
      pay_direction_pay: 'Pay',
      pay_direction_receive: 'Get paid',
      pay_cell_nearby_pay: 'Someone nearby',
      pay_cell_nearby_pay_sub: 'Scan their code',
      pay_cell_handle_pay: 'Someone with this app',
      pay_cell_handle_pay_sub: 'Pick or search a handle',
      pay_cell_address_pay: 'A conventional wallet',
      pay_cell_address_pay_sub: 'Paste or scan an address',
      pay_cell_nearby_get: 'Someone nearby',
      pay_cell_nearby_get_sub: 'Show your payment code',
      pay_cell_handle_get: 'Someone with this app',
      pay_cell_handle_get_sub: 'Share your handle',
      pay_cell_address_get: 'A conventional wallet',
      pay_cell_address_get_sub: 'Show an address',
      pay_pre_nearby: 'You are both here.',
      pay_pre_handle: 'They use this app.',
      pay_pre_address: 'You have their address.',
      pay_conseq_nearby: 'Settles in seconds.',
      pay_conseq_handle: 'Lands when their wallet next checks.',
      pay_conseq_address: 'Sent — they are not notified.',
      paid: 'Paid',
      pay_copy: 'Copy',
      pay_share_link: 'Share link',
      pay_address_watching: 'Money sent here is added to your wallet automatically.',
      pay_address_earlier_day: 'Reach an earlier day',
      pay_address_sweep_now: 'Check this address now',
      pay_address_swept: 'Received {{amount}}',
```

Keep `payments:` only if something outside the payment screens still uses it — `grep -rn "t('payments')" app components` after Task 14 should return nothing, in which case remove it.

- [ ] **Step 2: Translate into the other 11 locales**

For each of `zh, hi, es, fr, ar, pt, bn, ru, id, ja, pl`, add the same 27 keys with real translations. Constraints:

- **"Nearby" must use the locale's established nearby-sharing word**, not a transliteration of "local". The existing `local_payments` values already made this choice per locale (`zh: 附近支付`, `es: Pagos cercanos`, `ja/pl/…`) — reuse their vocabulary for the `*_nearby_*` keys.
- `paid` is the past-tense receipt word, not the noun "payment".
- `pay_conseq_address` must preserve the warning: sent, and the recipient is **not** notified. Do not soften it in translation.
- `{{amount}}` stays verbatim in `pay_address_swept`.
- `ar` is RTL — no directional characters or leading punctuation that fights the layout.

- [ ] **Step 3: Remove the orphaned keys, in all 12 locales**

These are dead after this change (verified by grep at plan time: zero non-i18n usages, or their only usage was in a deleted screen):

```
local_pay_amount_specific
local_pay_open_request
local_pay_enter_amount
local_pay_waiting
local_pay_via_nearby
local_pay_via_qr
check_balance
import_funds
available_balance
not_checked
legacy_info
legacy_bridge
local_payments
local_payments_subtitle
```

- [ ] **Step 4: Verify**

For every key added, confirm 12 occurrences; for every key removed, confirm 0:

```bash
for k in pay pay_direction_pay pay_direction_receive pay_cell_nearby_pay pay_cell_nearby_pay_sub \
         pay_cell_handle_pay pay_cell_handle_pay_sub pay_cell_address_pay pay_cell_address_pay_sub \
         pay_cell_nearby_get pay_cell_nearby_get_sub pay_cell_handle_get pay_cell_handle_get_sub \
         pay_cell_address_get pay_cell_address_get_sub pay_pre_nearby pay_pre_handle pay_pre_address \
         pay_conseq_nearby pay_conseq_handle pay_conseq_address paid pay_copy pay_share_link \
         pay_address_watching pay_address_earlier_day pay_address_sweep_now pay_address_swept; do
  n=$(grep -c "^      $k:" context/i18n/translations.tsx)
  [ "$n" = "12" ] || echo "MISSING $k ($n/12)"
done

for k in local_pay_amount_specific local_pay_open_request local_pay_enter_amount local_pay_waiting \
         local_pay_via_nearby local_pay_via_qr check_balance import_funds available_balance \
         not_checked legacy_info legacy_bridge local_payments local_payments_subtitle; do
  n=$(grep -c "$k" context/i18n/translations.tsx)
  [ "$n" = "0" ] || echo "STILL PRESENT $k ($n)"
done
```

Expected: no output from either loop. Note the first loop's pattern assumes six-space indentation inside each `translation` block — check one key by hand first and adjust if the file uses a different depth.

Then confirm no component references a key that no longer exists:

```bash
grep -rhoE "t\('([a-z0-9_]+)'" app components hooks context utils | sed "s/t('//;s/'//" | sort -u > /tmp/used.txt
while read -r k; do grep -q "^      $k:" context/i18n/translations.tsx || echo "UNDEFINED KEY: $k"; done < /tmp/used.txt
```

Expected: no output (some keys come from interpolated calls and may false-positive; check any hit by hand).

Then: `npx jest`, `npx tsc --noEmit`, `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add context/i18n/translations.tsx
git commit -m "$(cat <<'EOF'
i18n(pay): Pay screen copy in 12 locales, orphaned keys removed

Nearby reuses each locale's established nearby-sharing vocabulary rather than
a transliterated "local", success reads as the past-tense receipt, and the
address consequence keeps its warning intact in every language: sent, and the
recipient is not notified. Fourteen keys orphaned by the consolidation are
deleted from all twelve blocks.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XHvqS5dJLcsbBYC2DfHNa5
EOF
)"
```

---

### Task 16: Verification and device test

The spec's high-severity risks are all "money path regressed silently", and no unit test catches those. This task is the gate.

**Files:** none changed unless a check fails.

- [ ] **Step 1: Full static verification**

```bash
npx jest 2>&1 | tail -20          # expect: all suites pass, ≥210 + the new tests
npx tsc --noEmit                  # expect: clean
npm run lint                      # expect: no new errors
npm run format:check              # if it fails, run `npm run format` and commit the result
```

- [ ] **Step 2: Confirm the untouchables are untouched**

```bash
git diff master --stat -- utils/localpay      # expect: NO output
git diff master --stat -- __tests__/localpay* # expect: NO output
```

If either prints anything, revert those files — the spec's non-goal 1 is absolute.

- [ ] **Step 3: Device test — the five things that strand money**

Build and run on a real device (`npm run ios` against a dev build, or the EAS dev profile). Tick each:

- [ ] **Legacy send to a real external address.** Pay → a conventional wallet, paste an address from another wallet, send a small amount, confirm it arrives there. (Risk 1: this is the only bridge out.)
- [ ] **Legacy receive, same day, hands off.** Get paid → a conventional wallet, copy the address, pay it from an external wallet, then **leave the screen**. Within ~30 s a toast appears and the amount shows in Transactions with the `legacy`/`inbound` labels. (The whole point of the auto-sweep.)
- [ ] **Legacy receive, earlier day.** Open the recovery disclosure, step back one day, tap "Check this address now" on a day-address that holds funds, confirm they import. (Risk 2: previously-issued addresses must stay reachable.)
- [ ] **Nearby, both directions, both transports.** Two devices: AWDL path (iOS↔iOS) and QR path. Confirm the amount, the celebration, and "Added to your wallet". (Requirement 6: unchanged behaviour.)
- [ ] **Handle round trip.** Get paid → handle on device A, Share link, open the link on device B → it lands on Pay → handle with A's key filled in; send; accept on A. (Requirement 5 + open question 3.)

- [ ] **Step 4: Confirm the old paths still resolve**

- [ ] Cold-start the app from a `peerpay:` link (share the link to yourself and tap it) — lands on Pay → handle, not `+not-found`.
- [ ] From a JS console or a test build, `router.push('/payments')` — lands on Pay → handle.

- [ ] **Step 5: Update the design doc's status and commit**

In `docs/superpowers/specs/2026-07-28-payments-consolidation-design.md`, change `**Status:** Proposed` to `**Status:** Implemented — <today's date>`, and replace the Open questions block's remaining items 3–5 with their decided answers (share link: yes; nothing external links to `/legacy-payments`; the sweep bounds as implemented).

```bash
git add docs/superpowers/specs/2026-07-28-payments-consolidation-design.md
git commit -m "$(cat <<'EOF'
docs: mark the payments consolidation implemented and close its open questions

Share link shipped as a peerpay: URI through the native share sheet; nothing
outside the app deep-linked to /legacy-payments; sweep bounds are 30s interval,
foreground and online only, at most 8 watched addresses, dropped after 24h idle
or 7 days.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XHvqS5dJLcsbBYC2DfHNa5
EOF
)"
```

---

## Self-Review

**Spec coverage**

| Spec requirement | Task |
|---|---|
| One route, six cells, transport inferred | 1, 13 |
| `utils/pay/rails/{index,nearby,handle,address}.ts` | 1, 3, 7, 8 |
| `inferRail` / `PayTarget` discriminated union | 1 |
| Survival 1 — legacy send | 3 (`sendToAddress`), 12, 16 |
| Survival 2 — date-keyed receive + earlier days | 2, 12 (recovery disclosure), 16 |
| Survival 3 — the sweep mechanism verbatim, trigger changed | 3 (`sweepAddress`), 5, 6 |
| Survival 4 — PeerPay incoming list/accept/internalize | 7, 11 |
| Survival 5 — identity search + `validatePeerPayURI` | 1 (`classifyScan`), 10 (`useIdentitySearch`) |
| Survival 6 — everything in `local-payments.tsx` | 9 |
| Survival 7 — identity QR relocated, settings modal removed | 11, 14 |
| Legacy receive becomes automatic (owner, lifecycle, bounds) | 4, 5, 6 |
| Day-offset demoted to secondary recovery | 12 |
| Naming: Nearby / no Legacy Bridge / "Paid" / payment code | 15 (+ every component's copy) |
| Precondition + consequence at choose and confirm | 1 (keys), 10, 12, 13 |
| Migration: routes, menu, deep links, i18n orphans | 14, 15 |
| Non-goal: `utils/localpay/*` untouched | 8, 9, 16 (enforced by a diff check) |
| Risk: 5,000-line merge regresses a money path | task-per-module with review gates; 16 |
| Risk: deep links break silently | 1 (tested mapping), 14, 16 |
| Open Q3 / Q4 / Q5 | Global Constraints, 4, 5, 11 |

**Placeholder scan:** no TBD/TODO, no "add error handling", no "similar to Task N". Every code step carries the code. Two deliberate *conditional* instructions exist — the BEEF-test fallback in Task 3 Step 2 and the provider-wrapper fallback in Task 13 Step 1 — and both name the exact reduced form to use, rather than leaving it open.

**Type consistency:** `KVStorage` is declared in `utils/pay/watchlist.ts` and structurally matches `utils/localpay/pending.ts`'s (`getKeyValue`/`setKeyValue`) without importing it. `AddressRailWallet extends AddressDerivingWallet` — Task 3 extends the interface Task 2 defines. `WocConfig` is produced by Task 2 and consumed by Tasks 3, 5, 6, 12. `SweepOutcome`/`sweptTotal` are defined in Task 5 and used in Task 6. `PayCell`/`isPayCell` are defined in Task 1 and used in Tasks 1 (`legacyRedirectTarget`), 13, 14. `NearbyFlowProps.role` is `'payer' | 'payee'` in Task 9 and passed as `role="payer"`/`role="payee"` in Task 13. `HandleSendProps` fields (`initialIdentityKey`, `initialSats`, `initialNotice`) match Task 13's call site and Task 13's test assertions.
