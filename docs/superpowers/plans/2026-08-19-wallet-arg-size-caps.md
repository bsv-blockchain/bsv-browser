# WalletInterface Size Caps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refuse transaction payloads that would OOM-kill the app — from a web page, from a paired desktop, and from the wallet's own vault withdrawal — before anything allocates.

**Architecture:** A pure limit-checking module, wrapped in a Proxy composed at each external call site exactly like `guardVaultAccess`. The vault is exempt by call site rather than by originator string, and gets its own input cap instead. Nothing is enforced below the app layer, because a cap in `guardVaultAccess`, `SimpleWalletManager`, `WalletPermissionsManager` or the toolbox would break the vault outright.

**Tech Stack:** TypeScript, React Native (Hermes), `@bsv/sdk` wallet interface, Jest.

**Spec:** [docs/superpowers/specs/2026-08-19-tx-size-limits-and-blob-compression-design.md](../specs/2026-08-19-tx-size-limits-and-blob-compression-design.md) Part 2 (§5).

## Global Constraints

- Peak RSS ≈ **20× N** central, **30× N** planning, for an N-byte payload crossing the CWI bridge. Measured on shipped Hermes v0.14.1.
- **100 MB is the network ceiling, never the memory cap.** At 20-30× it implies 2-3 GB and an uncatchable `LLVM ERROR: OOM`.
- Page-facing aggregate: **4 MB** per call, **2 MB** on `low` tier (`getDeviceTier()` in [utils/deviceTier.ts](../../../utils/deviceTier.ts), `low` is < 3.5 GB RAM).
- Refusals return code **6** (`WERR_INVALID_PARAMETER`) via `sendErrorToWebView`; a bare `throw` is flattened to code 1 by the dispatcher's catch.
- **Exempt the vault by call site, not by originator string.** The vault calls `managers.permissionsManager` directly and never enters the dispatcher.
- Vault withdrawal input cap: **6**, hard ceiling **8**, refused before `signAction`.
- Vault transfers are refused entirely while offline (`getOnline()` from [utils/net/online.ts](../../../utils/net/online.ts)).
- Commit after every task.

---

### Task 1: The limit table and the pure size check

**Files:**
- Create: `services/walletArgLimits.ts`
- Create: `__tests__/walletArgLimits.test.ts`

**Interfaces:**
- Produces: `WalletArgLimits` — the numeric limits.
- Produces: `limitsForTier(tier: DeviceTier): WalletArgLimits`
- Produces: `type ArgRefusal = { field: string; limit: number; actual: number; message: string }`
- Produces: `checkWalletArgs(call: string, args: unknown, limits: WalletArgLimits): ArgRefusal | null`

Every limit is a hard refusal. Sizes are computed by summing already-materialised lengths — never by serialising — so the check is O(#inputs + #outputs) integer reads.

Hex fields count as `length / 2` bytes. `inputBEEF` and `args.tx` are `number[]`, so their `length` **is** the byte count.

- [ ] **Step 1: Write the failing test**

```ts
import { checkWalletArgs, limitsForTier } from '@/services/walletArgLimits'

const L = limitsForTier('mid')
const hex = (bytes: number) => 'ab'.repeat(bytes)

describe('checkWalletArgs', () => {
  it('passes the payloads pages actually send', () => {
    // The largest legitimate page payload in this app: a localpay AtomicBEEF
    // (65,536 bytes) and a ~25-byte P2PKH script.
    expect(checkWalletArgs('createAction', {
      outputs: [{ lockingScript: hex(25) }]
    }, L)).toBeNull()
    expect(checkWalletArgs('internalizeAction', { tx: new Array(65_536).fill(0) }, L)).toBeNull()
  })

  it('refuses a single oversize locking script', () => {
    const r = checkWalletArgs('createAction', { outputs: [{ lockingScript: hex(959_632) }] }, L)
    expect(r?.field).toBe('outputs[0].lockingScript')
    expect(r?.actual).toBe(959_632)
  })

  it('refuses a declared unlockingScriptLength no byte cap would catch', () => {
    // The SDK only cross-checks this against a supplied script and never bounds
    // it, so a page can declare 959,871 per input with an empty payload and make
    // the wallet fund a ~1 MB-per-input transaction.
    const r = checkWalletArgs('createAction', {
      inputs: [{ outpoint: 'x', unlockingScriptLength: 959_871 }]
    }, L)
    expect(r?.field).toBe('inputs[0].unlockingScriptLength')
  })

  it('refuses a 0xff-leading locking script outright', () => {
    // Provably unspendable, so nothing legitimate wants it, and it closes the
    // decoder-poisoning path in spec §5.1.
    const r = checkWalletArgs('createAction', { outputs: [{ lockingScript: 'ff00' }] }, L)
    expect(r?.field).toBe('outputs[0].lockingScript')
    expect(r?.message).toMatch(/unspendable/i)
  })

  it('refuses on the aggregate even when every field is individually fine', () => {
    const outputs = Array.from({ length: 60 }, () => ({ lockingScript: hex(90_000) }))
    const r = checkWalletArgs('createAction', { outputs }, L)
    expect(r?.field).toBe('outputs')
  })

  it('caps inputBEEF and internalizeAction tx separately', () => {
    expect(checkWalletArgs('createAction', { inputBEEF: new Array(3_000_000).fill(0) }, L)?.field)
      .toBe('inputBEEF')
    expect(checkWalletArgs('internalizeAction', { tx: new Array(2_000_000).fill(0) }, L)?.field)
      .toBe('tx')
  })

  it('caps array lengths and customInstructions', () => {
    expect(checkWalletArgs('createAction', {
      outputs: Array.from({ length: 1001 }, () => ({ lockingScript: '00' }))
    }, L)?.field).toBe('outputs.length')
    expect(checkWalletArgs('createAction', {
      outputs: [{ lockingScript: '00', customInstructions: 'x'.repeat(5000) }]
    }, L)?.field).toBe('outputs[0].customInstructions')
  })

  it('caps signAction spends', () => {
    expect(checkWalletArgs('signAction', {
      spends: { 0: { unlockingScript: hex(200_000) } }
    }, L)?.field).toBe('spends[0].unlockingScript')
  })

  it('halves the aggregate on a low-tier device', () => {
    expect(limitsForTier('low').aggregate).toBe(limitsForTier('mid').aggregate / 2)
  })

  it('ignores calls that carry no transaction bytes', () => {
    expect(checkWalletArgs('getPublicKey', { identityKey: true }, L)).toBeNull()
    expect(checkWalletArgs('listOutputs', { basket: 'x' }, L)).toBeNull()
  })

  it('survives malformed args without throwing', () => {
    for (const args of [null, undefined, 'string', 42, { outputs: 'nope' }, { outputs: [null] }]) {
      expect(() => checkWalletArgs('createAction', args, L)).not.toThrow()
    }
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest __tests__/walletArgLimits.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Limits (spec §5.2): aggregate 4 MB (2 MB low); single `lockingScript` 100 KB; summed output scripts 500 KB; `outputs`/`inputs` length 1,000; declared `unlockingScriptLength` 100,000 each and 500,000 summed; `signAction` spend `unlockingScript` 100 KB; `inputBEEF` 2 MB; `internalizeAction` `tx` 1 MB; `customInstructions` 4 KB per output.

- [ ] **Step 4: Run to verify it passes, then commit**

```bash
npx jest __tests__/walletArgLimits.test.ts && npx tsc --noEmit
git add services/walletArgLimits.ts __tests__/walletArgLimits.test.ts
git commit -m "feat(wallet): size limits for wallet-interface arguments"
```

---

### Task 2: `capWalletArgs` Proxy, composed at every external call site

**Files:**
- Create: `services/capWalletArgs.ts`
- Create: `__tests__/capWalletArgs.test.ts`
- Modify: `app/index.tsx:729`, `app/pair.tsx:92`, `app/connections.tsx:123,137,175`

**Interfaces:**
- Consumes: `checkWalletArgs`, `limitsForTier` from Task 1.
- Produces: `capWalletArgs<T extends WalletInterface>(wallet: T, limits?: WalletArgLimits): T`
- Produces: `class WalletArgTooLarge extends Error { code = 6; field: string }`

Shaped exactly like [guardVaultAccess](../../../services/vault/guard.ts): a Proxy that intercepts only the calls that can carry bytes and passes everything else straight through.

- [ ] **Step 1: Write the failing test**

```ts
import { capWalletArgs } from '@/services/capWalletArgs'

const wallet = () => ({
  createAction: jest.fn(async () => ({ txid: 'x' })),
  internalizeAction: jest.fn(async () => ({ accepted: true })),
  signAction: jest.fn(async () => ({ txid: 'x' })),
  getPublicKey: jest.fn(async () => ({ publicKey: 'k' }))
})

describe('capWalletArgs', () => {
  it('passes an ordinary payment straight through', async () => {
    const w = wallet()
    await capWalletArgs(w as any).createAction({ outputs: [{ lockingScript: 'ab'.repeat(25) }] }, 'page.com')
    expect(w.createAction).toHaveBeenCalled()
  })

  it('refuses an oversize payload with code 6 and never calls the wallet', async () => {
    const w = wallet()
    await expect(
      capWalletArgs(w as any).createAction({ outputs: [{ lockingScript: 'ab'.repeat(959_632) }] }, 'page.com')
    ).rejects.toMatchObject({ code: 6 })
    expect(w.createAction).not.toHaveBeenCalled()
  })

  it('refuses vault-shaped args from a page but leaves non-byte calls alone', async () => {
    const w = wallet()
    const capped = capWalletArgs(w as any)
    await expect(capped.internalizeAction({ tx: new Array(2_000_000).fill(0) }, 'page.com')).rejects.toMatchObject({
      code: 6
    })
    await capped.getPublicKey({ identityKey: true }, 'page.com')
    expect(w.getPublicKey).toHaveBeenCalled()
  })

  it('names the offending field in the message, matching WERR_INVALID_PARAMETER style', async () => {
    const w = wallet()
    await expect(
      capWalletArgs(w as any).createAction({ inputBEEF: new Array(3_000_000).fill(0) }, 'page.com')
    ).rejects.toThrow(/inputBEEF/)
  })
})
```

- [ ] **Step 2: Run to verify it fails, implement, verify it passes**

- [ ] **Step 3: Compose at the five external call sites**

Wrap outside the vault guard so the size check runs first: `capWalletArgs(guardVaultAccess(manager, ADMIN_ORIGINATOR))`. The vault's own code path (`services/vault/transfers.ts`, `app/vault-transfer.tsx`) calls `managers.permissionsManager` directly and is untouched — that is the exemption, and it cannot be spoofed.

- [ ] **Step 4: Add the regression test that the vault still works**

```ts
it('does not cap the vault, which calls the manager directly', () => {
  // The exemption is structural: the vault never receives a capped wallet.
  // Deposit sends a 1,919,264-char hex lockingScript and withdrawal sends
  // ~1.83 MB of inputBEEF per input, so a cap on its path breaks it outright.
  const manager = wallet()
  const capped = capWalletArgs(manager as any)
  expect(capped).not.toBe(manager)
  // app/vault-transfer.tsx passes managers.permissionsManager, not this wrapper.
})
```

- [ ] **Step 5: Full verification and commit**

```bash
npx tsc --noEmit && npx jest
git add services/capWalletArgs.ts __tests__/capWalletArgs.test.ts app/index.tsx app/pair.tsx app/connections.tsx
git commit -m "feat(wallet): cap argument sizes on every external wallet surface"
```

---

### Task 3: Pre-parse ceiling on the WebView message

**Files:**
- Modify: `app/index.tsx` (immediately before `JSON.parse(eventData)`)
- Create: `__tests__/messageSizeCeiling.test.ts`

**Interfaces:**
- Produces: `MESSAGE_CHARS_MAX = 8_000_000`, `DOWNLOAD_BLOB_CHARS_MAX = 32_000_000`, `messageTooLarge(data: string): boolean` — exported from `utils/webview/messageSizeCeiling.ts` so it is testable.

`FILE_DOWNLOAD_BLOB` posts an entire file as base64 and has no size limit today, so the ceiling is tiered on a prefix sniff. The app writes that message itself with `type` first, which is what makes the sniff reliable.

This tier is a **damage limiter, not a fix**, and the code comment must say so: by the time `data.length` is readable, Android has already built a Java String, a `folly::dynamic` and a Hermes string — roughly 4 bytes per JSON char. Only a `react-native-webview` patch rejecting by length inside `didReceiveScriptMessage` / the `@JavascriptInterface` method would close it, and that is a forked-dependency commitment.

- [ ] **Step 1: Write the failing test**

```ts
import {
  DOWNLOAD_BLOB_CHARS_MAX,
  MESSAGE_CHARS_MAX,
  messageTooLarge
} from '@/utils/webview/messageSizeCeiling'

describe('messageTooLarge', () => {
  it('allows an ordinary CWI message', () => {
    expect(messageTooLarge('{"type":"CWI","call":"getPublicKey"}')).toBe(false)
  })

  it('refuses a huge non-download message', () => {
    expect(messageTooLarge('{"type":"CWI",' + 'x'.repeat(MESSAGE_CHARS_MAX))).toBe(true)
  })

  it('allows a large download blob up to its own ceiling', () => {
    const head = '{"type":"FILE_DOWNLOAD_BLOB","data":"'
    expect(messageTooLarge(head + 'A'.repeat(MESSAGE_CHARS_MAX))).toBe(false)
    expect(messageTooLarge(head + 'A'.repeat(DOWNLOAD_BLOB_CHARS_MAX))).toBe(true)
  })

  it('is O(1) on the string, not a parse', () => {
    // A 30 MB string must not be parsed to be judged.
    const t0 = Date.now()
    messageTooLarge('{"type":"CWI",' + 'y'.repeat(30_000_000))
    expect(Date.now() - t0).toBeLessThan(50)
  })
})
```

- [ ] **Step 2: Run to verify it fails, implement, verify it passes**

- [ ] **Step 3: Wire into the handler and commit**

Return early (dropping the message, with a `devLog`) when `messageTooLarge(eventData)`.

```bash
npx tsc --noEmit && npx jest
git add utils/webview/messageSizeCeiling.ts __tests__/messageSizeCeiling.test.ts app/index.tsx
git commit -m "feat(webview): drop oversize messages before parsing them"
```

---

### Task 4: Vault withdrawal input cap

**Files:**
- Modify: `services/vault/transfers.ts` (`spendVaultOutputs` selection, currently "spend EVERY output")
- Modify: `services/vault/types.ts` (new `VaultErrorCode` member)
- Modify: `__tests__/vault/transfers.test.ts`

**Interfaces:**
- Produces: `VAULT_MAX_INPUTS = 6`, `VAULT_HARD_MAX_INPUTS = 8` exported from `services/vault/transfers.ts`.
- Produces: new `VaultErrorCode` value `'too-many-inputs'`.

The current code says "Spend EVERY output — there is no input cap". At ~1.83 MB of `inputBEEF` per input that is a measured 146 MB Hermes array at 20 inputs, and `toEF()` re-embeds each input's source locking script, so the wire payload is ~188 MB regardless of how the bytes are stored. The cap sits inside all three independent constraints: measured memory (~110-150 MB at 6 vs ~350 MB at 20), Arcade's 10 MB `MaxTxSizePolicy` (~10 inputs) and its 32 MiB single-tx endpoint (~18 inputs).

Selection takes the largest outputs first (already sorted), caps at `VAULT_MAX_INPUTS`, and re-vaults the remainder — the existing remainder path already handles this. A withdrawal that cannot be satisfied within the cap is refused **before** `signAction` with `too-many-inputs`, because the failure would otherwise land after the point-of-no-abort comment where nothing releases the allocated inputs.

- [ ] **Step 1: Write the failing tests**

```ts
test('spends at most VAULT_MAX_INPUTS and re-vaults the rest', async () => {
  const fx = await seedVaultOutputs(10)
  const { txid } = await withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw all')
  expect(txid).toBeDefined()
  const args = wallet.createAction.mock.calls.at(-1)![0]
  expect(args.inputs.length).toBeLessThanOrEqual(VAULT_MAX_INPUTS)
  // The untouched vault outputs stay spendable for a follow-up withdrawal.
  expect(args.outputs.some((o: any) => o.basket === VAULT_BASKET)).toBe(true)
})

test('refuses before signing when the amount needs more than the hard cap', async () => {
  await seedVaultOutputs(20)
  await expect(withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw all')).rejects.toMatchObject({
    code: 'too-many-inputs'
  })
  expect(wallet.signAction).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run to verify they fail, implement, verify they pass**

- [ ] **Step 3: Add the user-facing copy**

`vault_err_too_many_inputs` in all 12 locales: the message must tell the user to withdraw a smaller amount first, because consolidating happens automatically as a side effect of the re-vaulted remainder.

- [ ] **Step 4: Full verification and commit**

```bash
npx tsc --noEmit && npx jest
git add services/vault/transfers.ts services/vault/types.ts context/i18n/translations.tsx __tests__/vault/transfers.test.ts
git commit -m "feat(vault): cap withdrawal inputs so a large vault cannot OOM the app"
```

---

### Task 5: Refuse vault transfers while offline

**Files:**
- Modify: `services/vault/transfers.ts` (`depositToVault`, `withdrawFromVault`)
- Modify: `services/vault/types.ts` (new `VaultErrorCode` member `'requires-online'`)
- Modify: `context/i18n/translations.tsx` (12 locales)
- Modify: `__tests__/vault/transfers.test.ts`

**Interfaces:**
- Consumes: `getOnline()` from `@/utils/net/online`, injected as an optional dependency so the tests do not need the native module.
- Produces: new `VaultErrorCode` value `'requires-online'`.

The offline queue exists for small casual default-basket payments. A vault transfer must never enter it: `processOfflineActions` holds every held request's full rawTx and inputBEEF in one in-memory `Beef`, and a held row has no attempt cap, no expiry and no local terminal state that releases its reservation. Refusing up front is what makes "a compressed blob reaching the offline drain is a bug" a testable invariant later.

- [ ] **Step 1: Write the failing tests**

```ts
test('refuses a deposit while offline', async () => {
  await expect(depositToVault(wallet, ADMIN, 300_000, { isOnline: async () => false }))
    .rejects.toMatchObject({ code: 'requires-online' })
  expect(wallet.createAction).not.toHaveBeenCalled()
})

test('refuses a withdrawal while offline, before arming the key', async () => {
  await seedVaultOutputs(1)
  await expect(withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw all', undefined, {
    isOnline: async () => false
  })).rejects.toMatchObject({ code: 'requires-online' })
  // No ceremony: the user is not asked to present a YubiKey for a transfer that
  // cannot proceed.
  expect(requestVaultSigner).not.toHaveBeenCalled()
})

test('proceeds when online', async () => {
  await seedVaultOutputs(1)
  await expect(
    withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw all', undefined, { isOnline: async () => true })
  ).resolves.toMatchObject({ txid: expect.any(String) })
})
```

- [ ] **Step 2: Run to verify they fail, implement, verify they pass**

The check runs before `requestVaultSigner`, so an offline user is never prompted for a key.

- [ ] **Step 3: Wire the real signal at the call sites**

`app/vault-transfer.tsx` and `app/vault-recover.tsx` pass `{ isOnline: getOnline }`.

- [ ] **Step 4: Add copy in 12 locales, verify, commit**

```bash
npx tsc --noEmit && npx jest
git add services/vault/transfers.ts services/vault/types.ts context/i18n/translations.tsx app/vault-transfer.tsx __tests__/vault/transfers.test.ts
git commit -m "feat(vault): refuse transfers while offline"
```

---

## Self-review

**Spec coverage (Part 2):** limit table and per-field caps → Task 1; placement at external surfaces with the vault exempt by call site → Task 2; pre-parse ceiling → Task 3; vault input cap and pre-signing refusal → Task 4; offline gate → Task 5.

**Deferred from §5 with reason:** the in-flight/rate guard (`one mutating call per origin`), the response-side cap on `buildWalletResponseScript`, the localpay radio-send gate and its quadratic base64 encoder, and the 402-header/peerpay boundaries are all named in spec §5.3 and §7.5 as adjacent holes. They are separate concerns from argument size — a cap does not address repetition or responses — and each needs its own test surface. They belong in a follow-up plan, and shipping this one without them must not be described as "memory is handled".

**Type consistency:** `checkWalletArgs`, `limitsForTier`, `WalletArgLimits`, `ArgRefusal` in `services/walletArgLimits.ts`; `capWalletArgs`, `WalletArgTooLarge` in `services/capWalletArgs.ts`; `messageTooLarge`, `MESSAGE_CHARS_MAX`, `DOWNLOAD_BLOB_CHARS_MAX` in `utils/webview/messageSizeCeiling.ts`; `VAULT_MAX_INPUTS`, `VAULT_HARD_MAX_INPUTS` in `services/vault/transfers.ts`; `'too-many-inputs'` and `'requires-online'` added to `VaultErrorCode` in `services/vault/types.ts`.
