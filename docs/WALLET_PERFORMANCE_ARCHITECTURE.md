# Wallet Performance Architecture Review

**Date:** 2026-07-21  
**Branch context:** `feat/native-ecdsa-speedup` (and current mainline wallet paths)  
**Scope:** Paying, status updates, receiving funds, and BRC-100 / CWI method processing  
**Goal:** Blazing-fast wallet operations on mobile (iOS/Android React Native + Expo)

This document captures an architecture-grounded performance review of BSV Browser’s wallet stack. It is intentionally recommendation-focused (not an implementation plan). For implementation, turn selected items into OpenSpec changes with measurable latency budgets.

---

## Executive summary

The app already has strong foundations for a mobile Web3 wallet:

- Early `react-native-quick-crypto` + fast ECDSA (Metro alias + optional native ufsecp)
- SQLite `StorageProvider` (`StorageExpoSQLite`) with SQL-native list paths
- Auto-approve micropayments, 402 coalescing/cache, delayed-vs-undelayed broadcast awareness
- ARC SSE monitor with carefully patched tasks and deferred cold-start start
- `WalletManagersContext` to stop browser re-renders on every SSE tick

**Remaining bottlenecks are mostly architectural latency on the hot path**, not “make ECDSA 10% faster.” Crypto is necessary but no longer sufficient. Bridge, permissions, two-phase sign, exclusive SQLite, monitor contention, and network mode dominate user-perceived pay/status latency.

---

## Current architecture

### Stack overview

| Layer | Location / package | Role |
| ----- | ------------------ | ---- |
| WebView CWI | `utils/webview/cwiProvider.ts`, `app/index.tsx` | BRC-100 provider over `postMessage` / `injectJavaScript` |
| 402 payments | `utils/webview/bsvPaymentHandler.ts` | Merchant micropay: derive keys → `createAction` → undelayed broadcast → paid GET |
| PeerPay | `app/payments.tsx`, `utils/peerpay/outbox.ts` | MessageBox send/receive + durable outbox |
| Pairing RPC | `context/WalletConnectionContext.tsx` | Encrypted WS relay of BRC-100 methods |
| Permissions | `@bsv/wallet-toolbox-mobile` `WalletPermissionsManager` | Originator gating, spending auth, metadata encrypt |
| Wallet core | toolbox `Wallet` / `WalletSigner` / `SimpleWalletManager` | Action build, sign, process |
| Storage | `storage/StorageExpoSQLite.ts` | expo-sqlite backend extending `StorageProvider` |
| Services | `services/walletServiceConfig.ts`, arcade broadcast providers | ARC, WoC, Chaintracks, multi-broadcaster |
| Monitor | `context/WalletContext.tsx` + toolbox `Monitor` | SSE status, send-waiting, proofs, header poll |
| Crypto | `index.js`, `utils/crypto/*`, `modules/native-secp256k1` | Hashes/AES + secp256k1 sign/verify |

### Boot and provider tree

```
index.js
  → quick-crypto install
  → installFastEcdsa()   # native preferred, noble fallback
  → Expo Router

app/_layout.tsx providers (simplified)
  LocalStorage → User → ExchangeRate → Wallet → BrowserMode → Theme …
```

Wallet construction lives primarily in `context/WalletContext.tsx` (`buildWallet` / mnemonic recover / SQLite migrate / permissions / monitor).

### Payment / BRC-100 hot path

```
┌──────────────┐   postMessage    ┌────────────────────┐
│ WebView CWI  │ ───────────────► │ app/index handleMsg│
│ / 402 / Pay  │                  │ + InteractionManager│
└──────────────┘                  └─────────┬──────────┘
                                            │
                                            ▼
                              ┌─────────────────────────────┐
                              │ WalletPermissionsManager    │
                              │ • basket/label checks       │
                              │ • encryptActionMetadata     │
                              │ • always signAndProcess=false│
                              │ • spending auth / auto-grant│
                              │ • then underlying.signAction│
                              └─────────────┬───────────────┘
                                            │
                    ┌───────────────────────┼───────────────────────┐
                    ▼                       ▼                       ▼
           ┌────────────────┐     ┌──────────────────┐     ┌────────────────┐
           │ Wallet/Signer  │     │ StorageExpoSQLite│     │ Services/ARC   │
           │ ECDSA (native) │     │ exclusive txn    │     │ + WoC/CT       │
           │ KeyDeriver     │     │ multi round-trips│     │ broadcast wait │
           └────────────────┘     └──────────────────┘     └───────┬────────┘
                                                                    │
                                            ┌───────────────────────┘
                                            ▼
                                   ┌────────────────┐
                                   │ Monitor (SSE)  │
                                   │ serial runOnce │
                                   │ ~every few sec │
                                   └────────────────┘
```

### End-to-end cost of a typical BRC-100 `createAction`

1. Bridge serialize/parse (`postMessage`)
2. Optional animation yield (`InteractionManager.runAfterInteractions`)
3. PermissionsManager metadata encrypt + permission lookups
4. Storage `createAction` (UTXO select + exclusive SQLite transaction)
5. Sign — manager forces `signAndProcess: false`, then a second `signAction` pass
6. Auto-approve path currently re-reads AsyncStorage on **every** spend request
7. Broadcast RTT when `acceptDelayedBroadcast: false` (required for 402 correctness)
8. Bridge inject result (`injectJavaScript`)
9. Later: SSE/monitor promotes status → `txStatusVersion++` → UI refresh

---

## Strengths to preserve

| Area | Why it matters |
| ---- | -------------- |
| Early `quick-crypto` + fast ECDSA Metro alias | Hash/AES/ECDSA off pure-JS for sign-heavy paths |
| Auto-approve + 402 in-flight coalesce + payment cache | Correct “instant micro” UX primitives |
| `acceptDelayedBroadcast: false` only for 402 | Correctness for merchants; do not apply globally |
| SQL-native `listOutputs` / `listActions` | Better than IDB-style cursor filtering |
| Monitor patches (NewHeader cadence, ReviewProvenTxs removed, QuietEventSource) | Avoids JS-thread death by logging/polling |
| Deferred `monitor.startTasks()` | Protects cold start |
| `WalletManagersContext` | Stops browser tree thrashing on SSE ticks |
| Dev perf tooling (`utils/perf.ts`, monitor task timers, JS stall watchdog) | Enables phase-level diagnosis |

---

## Recommendations (priority order)

### P0 — Biggest wins for “feels instant”

#### 1. Tier BRC-100 methods (scheduling + permissions policy)

Today **every** CWI call takes the same path: yield → `permissionsManager[method]` → inject.

Split methods into latency classes:

| Tier | Methods | Policy |
| ---- | ------- | ------ |
| **L0 — free** | `getVersion`, `getNetwork`, `isAuthenticated`, `waitForAuthentication` | No yield, no storage, fixed answers from memory |
| **L1 — crypto** | `getPublicKey`, `createHmac`/`verifyHmac`, `createSignature`/`verifySignature`, `encrypt`/`decrypt` | No `InteractionManager`; no SQLite; keep on JS thread only if native crypto is warm |
| **L2 — read** | `listOutputs`, `listActions`, `listCertificates`, `getHeight` | Short yield only if UI animating; prefer cached UTXO/balance |
| **L3 — mutate** | `createAction`, `signAction`, `internalizeAction`, cert acquire | Full path + permission + exclusive txn |

**Why:** dApps often call `getPublicKey` / `getNetwork` / `listOutputs` in a storm before paying. Those should not pay the same tax as `createAction`.

#### 2. Kill the auto-approve AsyncStorage read on every spend

In `spendingAuthorizationCallback` (`WalletContext.tsx`), **every** request does:

```ts
const stored = await AsyncStorage.getItem(AUTO_APPROVE_STORAGE_KEY)
```

That is a disk/bridge hop **before** grant. `autoApproveThresholdRef` already exists — make it **write-through** from settings UI and trust the ref at request time. Optionally revalidate in background on app resume.

This alone shaves real milliseconds off every auto-approved micro.

#### 3. Collapse two-phase create+sign for trusted / auto-approved spends

`WalletPermissionsManager.createAction` always forces `signAndProcess: false`, builds a signable tx, gates spend, then `signAction`. That is intentional for auth UX, but it **doubles storage/signing orchestration** for the auto-approve path.

Options (increasing aggressiveness):

- After ephemeral grant, call `signAction` immediately without re-entering extra encrypt/permission layers (ensure no third pass).
- For admin/auto-approved originators under threshold, short-circuit to underlying wallet with `signAndProcess: true` (admin-only API already exists in the manager).
- App-level “micropayment engine” that, once originator+amount is pre-authorized, builds against storage with fewer manager steps (still audit permissions carefully).

This is the largest structural cut on pay latency after crypto.

#### 4. In-memory UTXO / balance cache in front of SQLite

`listOutputs` (balance, change selection, many dApps) hits SQL every time. On mobile:

- Maintain a **spendable change cache** (basket `default` / change) invalidated on `createAction` / `internalizeAction` / SSE status that spends or confirms.
- Serve balance + common `listOutputs` from cache; refresh async.
- Keep cache process-local (not secret; SecureStore not required).

This speeds **pay preparation**, **status UI**, and chatty BRC-100 reads.

---

### P1 — Storage and concurrency

#### 5. SQLite PRAGMAs on open

No WAL / busy timeout was found in app storage. On `migrate()` / first open, set:

```sql
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;
PRAGMA temp_store=MEMORY;
PRAGMA cache_size=-8000;  -- ~8MB, tune by device tier
```

`withExclusiveTransactionAsync` already serializes writes; WAL helps concurrent **reads** from monitor vs UI, and reduces fsync cost on commit.

#### 6. Reduce exclusive-txn surface and N+1

`transaction()` swaps `this.db` onto the exclusive connection for the whole scope — good for correctness, bad if `createAction` holds it while the monitor tries to write events.

- Keep exclusive scopes **tight** (only multi-statement atomic units).
- Avoid per-row script validation when `noScript: true` (list paths already skip; extend to other finders used in selection).
- Add composite indexes aligned to hot filters, for example:
  - `outputs(userId, spendable, basketId)`
  - `transactions(userId, status, created_at)`
  - `proven_tx_reqs(status, attempts)`

#### 7. Don’t SQLite-log every monitor task

`Monitor.logEvent` inserts a row for many task runs. Under SSE chatter that is pure write amplification on the same DB as payments.

- Sample or drop `MonitorCallHistory`-style noise (details already truncated in places).
- Persist only failures + status transitions the UI cares about.
- Debounce `setTxStatusVersion` (e.g. 100–250 ms coalesce) so SSE bursts don’t thrash React.

#### 8. Yield between monitor tasks (or pause during L3)

`runOnce()` runs due tasks **back-to-back** on the JS thread. Dev instrumentation already flags >50 ms tasks. Next steps:

- Between tasks: `await new Promise(r => setTimeout(r, 0))` (or InteractionManager) so a payment `createAction` can interleave.
- Or pause the monitor while an L3 op is in flight (simple mutex).

---

### P1 — Pay / receive product paths

#### 9. Dual broadcast modes by UX class

| Flow | Broadcast | Why |
| ---- | --------- | --- |
| 402 / merchant must see tx now | `acceptDelayedBroadcast: false` | Correctness |
| PeerPay send, in-app transfer, non-critical | delayed + outbox/SSE | Returns to user sooner |
| Status UI | trust SSE first, poll only on resume | Battery + CPU |

Keep undelayed for 402. Ensure PeerPay/UI payments do not accidentally inherit undelayed semantics.

#### 10. Parallelize 402 pre-work

`_doPayment` does sequential `getPublicKey` (derived) then `getPublicKey` (identity). Those can run **in parallel**. Same for any “derive + identity + rate” setup before `createAction`.

Once auto-approve is guaranteed for an origin, pre-warm little more than a session-cached identity key.

#### 11. PeerPay outbox storage model

Outbox is one JSON blob in `key_value_store` rewritten on every save/retry (`utils/peerpay/outbox.ts`). Fine for a few entries; not for active users.

- Table `peerpay_outbox` with indexed status, or one key per entry.
- On send success: update row, don’t rewrite whole array.
- Background retry when NetInfo flips online instead of only manual retry.

#### 12. Receive path: optimistic internalize + background reconcile

Receiving is network-bound (MessageBox list → internalize → storage). To feel instant:

- Show pending inbox from last poll immediately.
- Internalize in background with progress toast.
- Don’t block the list UI on full `listIncomingPayments` every focus — SWR-style cache with last-seen message id if the service supports it.

---

### P2 — Crypto and key lifecycle (after ECDSA)

#### 13. Finish the native ECDSA story and measure real-device path

Ensure **release builds always report `backend: native`**, and measure full `createAction` (not just sign ops). Pure-JS can still dominate: BIP39 PBKDF2, BigInt-heavy BEEF merge, script assembly.

#### 14. Mnemonic unlock is a cold-start tax

`recoverMnemonicWallet` does PBKDF2 + BIP32 on the JS thread (already perf-logged). Options:

- Cache **primary key material** in SecureStore after first successful unlock so daily open skips PBKDF2.
- Use native PBKDF2 (quick-crypto) if not already on that path.
- Lazy: open DB + answer L0 CWI methods before full `SimpleWalletManager` auth completes (harder; large UX win for dApps that only call `getVersion` on load).

#### 15. Key derivation caching

`getPublicKey` for the same `(protocolID, keyID, counterparty)` is common in 402/BRC-29. Session LRU (bounded, cleared on logout) removes repeated EC work even with native secp.

---

### P2 — Bridge and architecture shape

#### 16. Slim the CWI response path for large payloads

`listActions` / BEEF-heavy results → `JSON.stringify` → `injectJavaScript` is expensive. Mitigations:

- Encourage dApps to use pagination + `returnTXIDOnly` where possible (docs / sample apps).
- Cap default list sizes in the provider when args omit limits.
- For huge results, multi-message stream or temp-file handle (only if both sides are controlled).

#### 17. Serialize L3, parallelize L0–L2

If two `createAction`s run concurrently, exclusive SQLite + change selection races. Introduce a small **wallet operation scheduler**:

- L0–L2: concurrent
- L3: single-flight queue (FIFO, or priority for user-initiated UI pay over background)

#### 18. Permissions grant cache

First protocol/spend grant is human-latency bound (OK). Subsequent grants should be pure memory:

- `Map<originator, Set<protocol|basket|spend cap>>` loaded once from storage at wallet build
- Avoid re-querying permission tables on every `getPublicKey` / small action if the manager does that today

Many `seek*` flags are already disabled — good. Audit remaining DB hits inside `ensureSpendingAuthorization` / protocol checks.

#### 19. Split WalletContext further (status plane)

Managers are already split via `WalletManagersContext`. Next: a **TxStatusContext** that only exposes `txStatusVersion` / last statuses so payments screens don’t couple to permission queues. Reduces JS work during SSE storms while paying.

---

## Target latency budgets

Use these as product bars when instrumenting on device (native ECDSA build).

| Operation | Feels fast | Stretch |
| --------- | ---------- | ------- |
| L0 CWI | &lt; 5 ms | &lt; 2 ms |
| Auto-approved micro `createAction` (local sign, delayed broadcast) | &lt; 80–120 ms | &lt; 50 ms |
| Same with undelayed broadcast | RTT + 50–100 ms local | RTT + 30 ms |
| `listOutputs` balance (warm cache) | &lt; 10 ms | &lt; 5 ms |
| Status flip after SSE | &lt; 100 ms UI | frame-aligned debounce |
| Receive list (warm) | &lt; 50 ms paint | optimistic |

### Instrumentation guidance

Extend existing `perf.track` / `mark('cwi.*')` with **phase labels**:

- `perm`
- `storage.create`
- `sign`
- `broadcast`
- `bridge.out`

Without phase timing, optimizations will chase the wrong layer.

---

## Suggested attack order

If formalizing work (OpenSpec or plans):

1. **Instrument** `createAction` phases + CWI p50/p95 on device (native ECDSA build).
2. **L0/L1 fast path** + auto-approve ref-only + parallel 402 key derives.
3. **UTXO cache** + SQLite PRAGMAs/indexes.
4. **Auto-approved single-pass sign** (collapse PermissionsManager two-phase).
5. **Monitor yield/mutex + logEvent diet + txStatus debounce**.
6. **PeerPay outbox table + online retry**.
7. **Mnemonic unlock cache** for cold start.

---

## What not to do first

- Rewrite storage off SQLite (not the core issue).
- Move the full toolbox into a native module (huge cost; only if phase timings prove JS orchestration irreducible).
- Turn off permissions for all dApps (security regression).
- Make every payment undelayed broadcast (feels slower; more fragile offline).

---

## Key files reference

| File | Role |
| ---- | ---- |
| `context/WalletContext.tsx` | Wallet build, permissions callbacks, monitor, auto-approve, status version |
| `app/index.tsx` | CWI message router, InteractionManager yield, 402 entry |
| `utils/webview/cwiProvider.ts` | Injected `window.CWI` BRC-100 surface |
| `utils/webview/bsvPaymentHandler.ts` | 402 payment orchestration |
| `utils/peerpay/outbox.ts` | Durable outbound PeerPay tokens |
| `storage/StorageExpoSQLite.ts` | SQLite provider, exclusive transactions |
| `storage/methods/listOutputsSql.ts` | SQL listOutputs |
| `storage/methods/listActionsSql.ts` | SQL listActions |
| `services/walletServiceConfig.ts` | ARC / Chaintracks / WoC options |
| `utils/walletMonitor.ts` | NewHeader poll cadence / backoff |
| `utils/crypto/*` | Fast ECDSA install + backends |
| `utils/perf.ts` | Dev JS-thread span instrumentation |
| `context/WalletConnectionContext.tsx` | Paired desktop/session BRC-100 RPC |
| `app/payments.tsx` | PeerPay UI send/receive |
| `docs/NOWAB_IMPLEMENTATION.md` | Self-custodial wallet overview |

Related prior notes:

- `GROK_REVIEW.md` — broader “super fast browser” audit (chrome, tabs, re-renders, bridge)
- `scripts/perf/results-diff.md` — earlier browser-perf harness deltas
- `docs/superpowers/plans/2026-07-21-native-ecdsa-speedup.md` — native ECDSA implementation plan

---

## Bottom line

The architecture is a solid **WebView substrate → PermissionsManager → toolbox Wallet → SQLite → ARC/SSE** pipeline.

“Blazing” wallet ops will not come from one more crypto microbench alone. They come from:

1. **Not treating every BRC-100 method like `createAction`**
2. **Not paying disk + two-phase sign + exclusive DB + monitor contention on the micro path**
3. **Caching read models (UTXOs, grants, identity keys) aggressively**
4. **Using network wait only when the payment product actually requires it**

Native ECDSA is the right foundation. The next biggest structural levers are **tiered CWI**, an **auto-approve path that skips re-auth disk and two-phase sign**, then **UTXO/SQLite/monitor contention**.
