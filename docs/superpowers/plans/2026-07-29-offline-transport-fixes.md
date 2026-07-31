# Offline Transport Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make queued offline payments actually broadcast after reconnect, replace the "too large for QR" dead end with an animated fountain QR on every platform, give Android a real radio transport (Google Nearby Connections), and make offline-held transactions visually distinct in the transactions screen.

**Architecture:** Three independently-landable phases. Phase 1 (pure TS): `TaskSendOffline` gains a 10-second-backoff periodic trigger gated on connectivity plus a manual "Send now"; the release engine stops poisoning independent transactions when one subtree fails; the QR send path finally enqueues via new Done-button semantics backed by a persisted `framePayload` column; the transactions screen overlays badges from `offline_actions`. Phase 2 (TS + UI + one small Swift change): a custom Luby-transform fountain codec (`bsvpayf2:` parts) removes the 2,200-char QR ceiling, the transport selector becomes a three-rung ladder (AWDL → Nearby → QR) driven by new session capability bits, and a radio failure auto-falls back to the QR instead of a failure screen. Phase 3 (Kotlin native): the Nitro transport package gains an Android backend speaking Google Nearby Connections with a PSK-HMAC session binding, exposing the exact same TS surface the AWDL backend has, so the whole JS layer above it is shared.

**Tech Stack:** TypeScript, React Native / Expo 55, `@bsv/sdk` 2.1.9, `@bsv/wallet-toolbox-mobile` 2.4.3, `expo-sqlite`, `react-native-nitro-modules` (Nitrogen codegen), Network.framework (iOS), `com.google.android.gms:play-services-nearby` (Android), jest with `jest-expo`.

**Spec:** `docs/superpowers/specs/2026-07-29-offline-transport-fixes-design.md`. Read it before starting any task.

## Global Constraints

- **No `node_modules` patching for this feature.** The repo ships `patches/@bsv+wallet-toolbox-mobile+2.4.3.patch`; do not add to it. Every seam used here is app code or the app-owned `packages/react-native-localpay-transport`.
- **Nearby rail only.** Do not touch `components/pay/HandleSend.tsx`, `HandleReceive.tsx`, `AddressSend.tsx`, `AddressReceive.tsx`.
- **Spendability is governed by `transactions.status`, never by `proven_tx_reqs.status`.** An offline-held transaction is `transactions.status = 'unproven'` + `proven_tx_reqs.status = 'nosend'`. Do not invent new status values in either column.
- **`online` means exactly** `isConnected === true && isInternetReachable !== false`, implemented once in `utils/net/online.ts`. Never read NetInfo directly.
- **Session capability bits are the transport authority.** The new `o` (OS) field in the session payload is metadata for copy and diagnostics only; it must never be consulted by `selectTransport`.
- **The pairing session payload stays `v: 1`.** New fields must be additions old decoders ignore. Changing `SESSION_VERSION` breaks every shipped build and is not on the table.
- **Money-decision code lives in pure functions** under `utils/offline/` and `utils/localpay/`, unit-tested in `__tests__/`. SQL modules stay logic-free.
- Tests run with `npx jest <pattern>`. Branch start: 47 test files, all green. Keep them green — several existing suites (`offlinePlan`, `processOfflineActions`, `taskSendOffline`, `localpaySession`, `localpayTransportSelect`, `payerHold`) pin behaviour this plan deliberately changes; the task that changes behaviour updates its tests in the same commit.
- **Never run `npm run fix` or `expo lint --fix`** (rewrites ~175 unrelated files). Check only files you touched: `npx prettier --check <files>` and `npx eslint <files>`.
- New i18n keys land in **all six locales** in `context/i18n/translations.tsx` (en ~line 300s, zh ~700s, hi ~1000s, es ~1300s, fr ~1600s, ar ~1900s). Every task that adds a key includes all six strings — never English-only.
- `TaskSendOffline`'s static fields are process-global on purpose (they must survive monitor rebuilds). Tests that touch them must reset via `TaskSendOffline.resetForTests()` in `beforeEach`.
- Native code (Swift/Kotlin) has no jest harness. Its verification steps are compile checkpoints plus the device checklist in Task 17; the TS layer above it is fully mocked and unit-tested.

---

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `utils/localpay/fountain.ts` | Fountain codec: crc32, xorshift RNG, soliton degree, `FountainEncoder`/`FountainDecoder`, `bsvpayf2:` part encoding. Pure, no platform imports. |
| `components/pay/PaymentQrDisplay.tsx` | Renders a `bsvpayf1:` payload as a static QR when it fits, or as an animated fountain when it does not. Used by NearbyFlow and the re-show modal. |
| `utils/localpay/transport/socket.ts` | `makeSocketTransport(kind)` — the existing AWDL wrapper generalised so the same code drives the Kotlin Nearby backend. |
| `utils/localpay/transport/nearby.ts` | `nearbyTransport = makeSocketTransport('nearby')`. |
| `utils/localpay/transport/nearbyPermissions.ts` | Android runtime-permission request for Nearby Connections. |
| `packages/react-native-localpay-transport/android/build.gradle` | Android library module for the Nitro backend + play-services-nearby dependency. |
| `packages/react-native-localpay-transport/android/src/main/AndroidManifest.xml` | Package manifest with Nearby permissions. |
| `packages/react-native-localpay-transport/android/src/main/java/com/margelo/nitro/localpaytransport/HybridLocalPayTransport.kt` | Kotlin Nearby Connections implementation of the shared Nitro spec. |
| `__tests__/localpayFountain.test.ts` | Fountain codec roundtrip/lossy/corruption tests. |

**Modified (by phase):**

| File | Phase | Change |
| --- | --- | --- |
| `utils/monitor/TaskSendOffline.ts` | 1 | Periodic trigger with 10 s→5 min backoff, online gate, `noteConnectivity`/`noteEnqueued`/`requestNow`, `lastStall`. |
| `context/WalletContext.tsx` | 1 | Reconnect listener → `noteConnectivity`; foreground re-arm; pessimistic `noteEnqueued` at build; `txStatusVersion` bump after a productive drain. |
| `utils/offline/plan.ts` | 1 | `applyOutcome` returns per-subtree `blocked` instead of run-global `stop`. |
| `storage/methods/processOfflineActions.ts` | 1 | Skip blocked subtrees, keep posting independent roots, accumulate stall notes. |
| `storage/schema/createTables.ts` | 1 | `framePayload` column on `offline_actions` + `ensureOfflineActionsColumns` guarded ALTER. |
| `storage/StorageExpoSQLite.ts` | 1 | Run the column migration in `migrate()`; `holdReqsOffline` calls `TaskSendOffline.noteEnqueued()`. |
| `storage/methods/offlineActions.ts` | 1 | `framePayload` in row type + insert. |
| `utils/offline/payerHold.ts` | 1 | `framePayload` passthrough + `noteEnqueued`. |
| `components/pay/NearbyFlow.tsx` | 1, 2 | Done = real delivery (`completeQrDelivery`, `builtRef`); fountain rendering; part scanning; auto QR fallback. |
| `components/pay/OfflineNotice.tsx` | 1 | "Send now" button, stall row, "show code again" per queued sent row. |
| `app/pay.tsx` | 1 | Wire send-now/stall/re-show; `txStatusVersion` in queue-effect deps; re-show modal. |
| `app/transactions.tsx` | 1 | Offline badge overlay from `offline_actions`. |
| `context/i18n/translations.tsx` | 1, 2 | New keys, six locales. |
| `utils/localpay/codec.ts` | 2 | `frameBytesFromQr` export. |
| `utils/localpay/session.ts` | 2 | `CAP_NEARBY`, `os` field, `supportsNearby` mint arg. |
| `utils/localpay/transport/select.ts` | 2 | Three-rung ladder + `localSupportsNearby`. |
| `utils/localpay/transport/types.ts` | 2 | `kind` union gains `'nearby'`. |
| `utils/localpay/transport/awdl.ts` | 2 | Becomes a re-export of `makeSocketTransport('awdl')`. |
| `utils/pay/rails/nearby.ts` | 2 | Barrel re-exports the new symbols. |
| `components/QRScanner.tsx` | 2 | `continuous` prop (no lock, no per-frame haptic). |
| `packages/react-native-localpay-transport/src/specs/LocalPayTransport.nitro.ts` | 2, 3 | `connectTimeoutMs` param; platform union gains `android: 'kotlin'`. |
| `packages/react-native-localpay-transport/ios/HybridLocalPayTransport.swift` | 2 | Connect-phase timeout in `sendFrame`. |
| `packages/react-native-localpay-transport/nitro.json` | 3 | Android autolinking entry. |
| `packages/react-native-localpay-transport/package.json` | 3 | Ship `android/` in files; drop "iOS only" from description. |
| `app.json` | 3 | Android permissions for Nearby. |

---

# Phase 1 — Drain fixes + badges

Fixes the stuck-money bug. Ships alone if needed.

### Task 1: TaskSendOffline retry machinery

**Files:**
- Modify: `utils/monitor/TaskSendOffline.ts` (full rewrite, currently 45 lines)
- Test: `__tests__/taskSendOffline.test.ts` (full rewrite)

**Interfaces:**
- Consumes: `ProcessOfflineActionsResult` from `storage/methods/processOfflineActions.ts` (`{ sent: number; rejected: number; stopped: boolean; stalledOn?: string }`) — unchanged.
- Produces (statics later tasks rely on):
  - `TaskSendOffline.noteConnectivity(online: boolean): void` — called by WalletContext's single reconnect listener.
  - `TaskSendOffline.noteEnqueued(): void` — called by every code path that inserts an `offline_actions` row, and pessimistically at wallet build.
  - `TaskSendOffline.requestNow(): void` — the manual "Send now".
  - `TaskSendOffline.lastStall: string | undefined` — most recent `stalledOn`, for the UI.
  - `TaskSendOffline.resetForTests(): void`.
  - `constructor(monitor, release, now?: () => number)` — `now` injectable for tests.

Today's task is a one-shot: `checkNow` is its only trigger, is cleared before the drain runs, and has exactly one setter (`context/WalletContext.tsx:1533`). A drain that fails right after reconnect — common, radios warm up slower than NetInfo reports — is never retried. This task makes the trigger self-rearming: while work is believed pending and the device is online, it fires every 10 s, doubling to a 5-minute cap, resetting on reconnect, new work, or the manual control.

- [ ] **Step 1: Write the failing tests**

Replace `__tests__/taskSendOffline.test.ts` entirely:

```ts
import { TaskSendOffline } from '@/utils/monitor/TaskSendOffline'
import type { ProcessOfflineActionsResult } from '@/storage/methods/processOfflineActions'

// The base class constructor only stores the monitor and name, so a bare
// object is enough — same trick the previous version of this suite used.
const monitor = {} as never

function task(results: ProcessOfflineActionsResult[], nowRef: { t: number }) {
  const calls: number[] = []
  const t = new TaskSendOffline(
    monitor,
    async () => {
      calls.push(nowRef.t)
      const r = results.shift()
      if (!r) throw new Error('release called more times than the test planned')
      return r
    },
    () => nowRef.t
  )
  return { t, calls }
}

const idle: ProcessOfflineActionsResult = { sent: 0, rejected: 0, stopped: false }
const stuck: ProcessOfflineActionsResult = { sent: 0, rejected: 0, stopped: true }

describe('TaskSendOffline trigger', () => {
  beforeEach(() => TaskSendOffline.resetForTests())

  it('never runs while offline, even with checkNow set', () => {
    TaskSendOffline.noteConnectivity(false)
    TaskSendOffline.checkNow = true
    const { t } = task([], { t: 0 })
    expect(t.trigger(0).run).toBe(false)
  })

  it('reconnecting arms an immediate run', () => {
    TaskSendOffline.noteConnectivity(true)
    const { t } = task([], { t: 0 })
    expect(t.trigger(0).run).toBe(true)
  })

  it('does not fire periodically with nothing pending', () => {
    TaskSendOffline.noteConnectivity(true)
    TaskSendOffline.checkNow = false
    const { t } = task([], { t: 0 })
    expect(t.trigger(1_000_000).run).toBe(false)
  })

  it('fires periodically while pending and online', () => {
    TaskSendOffline.noteConnectivity(true)
    TaskSendOffline.checkNow = false
    TaskSendOffline.noteEnqueued()
    const { t } = task([], { t: 0 })
    expect(t.trigger(0).run).toBe(true)
  })
})

describe('TaskSendOffline backoff', () => {
  beforeEach(() => TaskSendOffline.resetForTests())

  it('a stopped run schedules the next attempt 10s out, then doubles to the 5min cap', async () => {
    const nowRef = { t: 1_000 }
    TaskSendOffline.noteConnectivity(true)
    const { t } = task([stuck, stuck, stuck], nowRef)

    await t.runTask() // consumed checkNow, stopped → due at 11_000
    expect(t.trigger(10_999).run).toBe(false)
    expect(t.trigger(11_000).run).toBe(true)

    nowRef.t = 11_000
    await t.runTask() // due at 31_000 (20s)
    expect(t.trigger(30_999).run).toBe(false)
    expect(t.trigger(31_000).run).toBe(true)

    // Drive the doubling to the cap: 10,20,40,80,160,300,300...
    nowRef.t = 31_000
    await t.runTask().catch(() => {}) // third stuck result
    expect(TaskSendOffline.backoffMs).toBe(80_000)
    TaskSendOffline.backoffMs = 400_000 // beyond cap: next schedule must clamp
    nowRef.t = 500_000
    const { t: t2 } = task([stuck], nowRef)
    await t2.runTask()
    expect(TaskSendOffline.backoffMs).toBeLessThanOrEqual(TaskSendOffline.MAX_BACKOFF_MS)
  })

  it('a clean run clears pending and resets backoff', async () => {
    const nowRef = { t: 0 }
    TaskSendOffline.noteConnectivity(true)
    TaskSendOffline.noteEnqueued()
    const { t } = task([idle], nowRef)
    await t.runTask()
    expect(TaskSendOffline.hasPending).toBe(false)
    expect(TaskSendOffline.backoffMs).toBe(TaskSendOffline.BASE_BACKOFF_MS)
    expect(t.trigger(1_000_000).run).toBe(false)
  })

  it('a throwing release is a stopped run, not a dead task', async () => {
    const nowRef = { t: 0 }
    TaskSendOffline.noteConnectivity(true)
    const t = new TaskSendOffline(monitor, async () => { throw new Error('boom') }, () => nowRef.t)
    const log = await t.runTask()
    expect(log).toContain('boom')
    expect(TaskSendOffline.hasPending).toBe(true)
    expect(t.trigger(TaskSendOffline.BASE_BACKOFF_MS).run).toBe(true)
  })

  it('requestNow and noteEnqueued reset the backoff', () => {
    TaskSendOffline.noteConnectivity(true)
    TaskSendOffline.backoffMs = 160_000
    TaskSendOffline.nextDueAt = 999_999
    TaskSendOffline.requestNow()
    expect(TaskSendOffline.backoffMs).toBe(TaskSendOffline.BASE_BACKOFF_MS)
    expect(TaskSendOffline.checkNow).toBe(true)

    TaskSendOffline.backoffMs = 160_000
    TaskSendOffline.nextDueAt = 999_999
    TaskSendOffline.noteEnqueued()
    expect(TaskSendOffline.backoffMs).toBe(TaskSendOffline.BASE_BACKOFF_MS)
    expect(TaskSendOffline.nextDueAt).toBe(0)
  })

  it('records the stall for the UI and clears it on a clean run', async () => {
    const nowRef = { t: 0 }
    TaskSendOffline.noteConnectivity(true)
    const { t } = task([{ ...stuck, stalledOn: 'txA has no request' }, idle], nowRef)
    await t.runTask()
    expect(TaskSendOffline.lastStall).toBe('txA has no request')
    await t.runTask()
    expect(TaskSendOffline.lastStall).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest taskSendOffline`
Expected: FAIL — `noteConnectivity is not a function` (and others).

- [ ] **Step 3: Rewrite the task**

Replace `utils/monitor/TaskSendOffline.ts`:

```ts
/**
 * Releases held offline transactions when the device has signal.
 *
 * Two triggers, both gated on the app's single online signal:
 *
 *  · `checkNow` — an immediate pass, set by reconnect (`noteConnectivity`),
 *    by the manual "Send now" control (`requestNow`), and by app foreground.
 *  · a periodic retry — while `hasPending` says the queue may hold releasable
 *    rows, fire every `backoffMs`, starting at 10 s and doubling to a 5 min
 *    cap. Rationale: users do not keep the app open for long, and once there
 *    IS network the first attempt almost always succeeds, so a short first
 *    gap is cheap; the doubling keeps a genuinely stuck queue from spamming
 *    services.
 *
 * All state is static and process-global BY DESIGN: the monitor is torn down
 * and rebuilt on network switches and wallet rebuilds, and a pending queue
 * must survive that. The previous one-shot version of this task lost its one
 * trigger whenever the first drain after reconnect failed — NetInfo often
 * reports online seconds before routes actually work — which is exactly the
 * "payments sit at nosend forever" bug this rewrite removes.
 */
import { WalletMonitorTask } from '@bsv/wallet-toolbox-mobile/out/src/monitor/tasks/WalletMonitorTask'
import type { Monitor } from '@bsv/wallet-toolbox-mobile'
import type { ProcessOfflineActionsResult } from '@/storage/methods/processOfflineActions'

export class TaskSendOffline extends WalletMonitorTask {
  static taskName = 'SendOffline'

  static readonly BASE_BACKOFF_MS = 10_000
  static readonly MAX_BACKOFF_MS = 300_000

  /** An immediate pass has been requested. Consumed at the top of runTask. */
  static checkNow = false
  /** Last observation from the app's single online listener. Gates trigger. */
  static onlineNow = false
  /** The queue may hold releasable rows. Set pessimistically; a clean run clears it. */
  static hasPending = false
  static backoffMs = TaskSendOffline.BASE_BACKOFF_MS
  static nextDueAt = 0
  /**
   * The most recent run's stalledOn, kept for the UI: a stall means retrying
   * alone will not help, and nothing else in the system records it.
   */
  static lastStall: string | undefined

  static noteConnectivity(online: boolean): void {
    TaskSendOffline.onlineNow = online
    if (online) {
      TaskSendOffline.checkNow = true
      TaskSendOffline.backoffMs = TaskSendOffline.BASE_BACKOFF_MS
      TaskSendOffline.nextDueAt = 0
    }
  }

  /** New work exists. Cheap to over-call: one idle drain clears it. */
  static noteEnqueued(): void {
    TaskSendOffline.hasPending = true
    TaskSendOffline.backoffMs = TaskSendOffline.BASE_BACKOFF_MS
    TaskSendOffline.nextDueAt = 0
  }

  /** The user's "Send now". */
  static requestNow(): void {
    TaskSendOffline.checkNow = true
    TaskSendOffline.backoffMs = TaskSendOffline.BASE_BACKOFF_MS
    TaskSendOffline.nextDueAt = 0
  }

  static resetForTests(): void {
    TaskSendOffline.checkNow = false
    TaskSendOffline.onlineNow = false
    TaskSendOffline.hasPending = false
    TaskSendOffline.backoffMs = TaskSendOffline.BASE_BACKOFF_MS
    TaskSendOffline.nextDueAt = 0
    TaskSendOffline.lastStall = undefined
  }

  constructor(
    monitor: Monitor,
    private readonly release: () => Promise<ProcessOfflineActionsResult>,
    private readonly now: () => number = () => Date.now()
  ) {
    super(monitor, TaskSendOffline.taskName)
  }

  trigger(nowMsecsSinceEpoch: number): { run: boolean } {
    if (!TaskSendOffline.onlineNow) return { run: false }
    return {
      run:
        TaskSendOffline.checkNow ||
        (TaskSendOffline.hasPending && nowMsecsSinceEpoch >= TaskSendOffline.nextDueAt)
    }
  }

  private scheduleRetry(): void {
    TaskSendOffline.hasPending = true
    TaskSendOffline.nextDueAt = this.now() + TaskSendOffline.backoffMs
    TaskSendOffline.backoffMs = Math.min(TaskSendOffline.backoffMs * 2, TaskSendOffline.MAX_BACKOFF_MS)
  }

  async runTask(): Promise<string> {
    TaskSendOffline.checkNow = false
    try {
      const r = await this.release()
      TaskSendOffline.lastStall = r.stalledOn
      if (r.stopped) {
        this.scheduleRetry()
      } else {
        TaskSendOffline.hasPending = false
        TaskSendOffline.backoffMs = TaskSendOffline.BASE_BACKOFF_MS
      }
      if (r.sent === 0 && r.rejected === 0 && !r.stalledOn) return ''
      let log = `sent ${r.sent}, rejected ${r.rejected}${r.stopped ? ', stopped early' : ''}`
      // A stall is distinct from the ordinary "signal went away again" stop: it
      // means retrying alone will not help, so it must not go unnoticed.
      if (r.stalledOn) log += ` — stalled: ${r.stalledOn}`
      return `${log}\n`
    } catch (e) {
      // A throw would take down the monitor's whole run loop — and it is also
      // a failed drain, so it earns a retry rather than silence.
      this.scheduleRetry()
      return `SendOffline failed: ${e instanceof Error ? e.message : String(e)}\n`
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest taskSendOffline`
Expected: PASS (10 tests).

- [ ] **Step 5: Check touched files, commit**

Run: `npx prettier --check utils/monitor/TaskSendOffline.ts __tests__/taskSendOffline.test.ts && npx eslint utils/monitor/TaskSendOffline.ts __tests__/taskSendOffline.test.ts && npx jest`
Expected: clean, full suite green.

```bash
git add utils/monitor/TaskSendOffline.ts __tests__/taskSendOffline.test.ts
git commit -m "fix(pay): self-rearming offline drain — 10s backoff, online-gated, manual trigger"
```

---

### Task 2: Wire the new trigger into WalletContext

**Files:**
- Modify: `context/WalletContext.tsx` — the reconnect effect at `:1529-1535`, the foreground handler at `:1538-1556`, the monitor build at `:915-917`
- Test: none new (the statics are covered by Task 1; this is wiring). Full suite must stay green.

**Interfaces:**
- Consumes: `TaskSendOffline.noteConnectivity/noteEnqueued/requestNow/hasPending` (Task 1); `processOfflineActions`; `setTxStatusVersion` (existing state setter at `WalletContext.tsx:889`).
- Produces: nothing new — behaviour only.

- [ ] **Step 1: Re-point the reconnect listener**

At `context/WalletContext.tsx:1529-1535`, replace the effect body:

```ts
  // Feed the drain's online gate and arm an immediate pass on reconnect.
  useEffect(() => {
    if (!walletBuilt) return
    return subscribeOnline(online => TaskSendOffline.noteConnectivity(online))
  }, [walletBuilt])
```

(NetInfo fires the listener once with the current state at subscription time, so an already-online cold start arms a first pass — same property the old code relied on.)

- [ ] **Step 2: Arm on foreground**

In the AppState handler at `:1538-1556`, inside the `wasBackground && isNowForeground` branch, after the `fetchSSEEvents` block, add:

```ts
        // Reconnects that happened while backgrounded may not replay as a
        // NetInfo event on resume; if work is pending, ask for a pass and let
        // the trigger's online gate decide.
        if (TaskSendOffline.hasPending) TaskSendOffline.requestNow()
```

- [ ] **Step 3: Pessimistic pending at build + txStatusVersion after a productive drain**

At `:915-917`, replace the `addTask` call:

```ts
          if (phoneStorage) {
            monitor.addTask(
              new TaskSendOffline(monitor, async () => {
                const r = await processOfflineActions({ storage: phoneStorage! })
                // The drain writes transaction statuses directly, below the
                // monitor's onTransactionStatusChanged callback — bump the
                // version ourselves so the transactions screen re-fetches.
                if (r.sent > 0 || r.rejected > 0) setTxStatusVersion(v => v + 1)
                return r
              })
            )
            // Rows may be sitting in offline_actions from a previous session.
            // Pessimistic: one idle drain clears it the first time we are online.
            TaskSendOffline.noteEnqueued()
          }
```

- [ ] **Step 4: Verify**

Run: `npx jest`
Expected: full suite green (`walletMonitor.test.ts` exercises this file's monitor wiring; if it pins the old `addTask` shape, update its expectation to the wrapped-lambda form in this commit).

Run: `npx prettier --check context/WalletContext.tsx && npx eslint context/WalletContext.tsx`

- [ ] **Step 5: Commit**

```bash
git add context/WalletContext.tsx __tests__/walletMonitor.test.ts
git commit -m "fix(pay): arm the offline drain from reconnect, foreground, and wallet build"
```

---

### Task 3: Per-subtree failure isolation in the release engine

**Files:**
- Modify: `utils/offline/plan.ts:71-107` (`applyOutcome`), `storage/methods/processOfflineActions.ts:140-198` (driver loop)
- Test: `__tests__/offlinePlan.test.ts` (update `applyOutcome` shape), `__tests__/processOfflineActions.test.ts` (new isolation cases + update stop-semantics cases)

**Interfaces:**
- Consumes: `descendantsOf(txid, txs)` from `utils/offline/order.ts` (existing).
- Produces: `applyOutcome(args): { sent: string[]; rejected: {txid,reason,poisonedByTxid}[]; blocked: string[] }` — the `stop` boolean is GONE; `blocked` lists txids (the failed one plus its descendants) that must be skipped for the rest of this run and left queued. `ProcessOfflineActionsResult` shape is unchanged; `stopped` now means "at least one subtree could not finish".

Today one `serviceError` anywhere aborts the whole run (`plan.ts:83`) and requeues independent transactions behind it (`processOfflineActions.ts:185-195`). With Task 1's retries that would still converge eventually, but each retry would re-fail on the same first bad root and never reach the good ones in the same pass.

- [ ] **Step 1: Update the plan tests**

In `__tests__/offlinePlan.test.ts`, the `applyOutcome` describe block (starts `:69`): every existing assertion on `r.stop` changes mechanically —

- `outcome: 'success'` cases: `expect(r.stop).toBe(false)` → `expect(r.blocked).toEqual([])`
- `outcome: 'serviceError'` case (`:76`): `expect(r.stop).toBe(true)` → `expect(r.blocked).toEqual(['A'])` (plus, in a new case, descendants)
- `invalidTx`/`doubleSpend` cases: `expect(r.stop).toBe(true)` → `expect(r.blocked).toEqual([])` (the subtree is *rejected*, not blocked — nothing is left to skip)

Add one new case to the same describe:

```ts
  it('a serviceError blocks the failed transaction and every descendant, nothing else', () => {
    // A ← B ← C, plus independent D
    const txs = [tx('A'), tx('B', ['A']), tx('C', ['B']), tx('D')]
    const r = applyOutcome({ txid: 'A', outcome: 'serviceError', txs, rows: [row('A'), row('D')] })
    expect(r.sent).toEqual([])
    expect(r.rejected).toEqual([])
    expect([...r.blocked].sort()).toEqual(['A', 'B', 'C'])
  })
```

(`tx()` and `row()` helpers already exist at the top of the file; `tx(id, inputTxids?)` builds an `OrderableTx`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx jest offlinePlan`
Expected: FAIL — `blocked` undefined.

- [ ] **Step 3: Change `applyOutcome`**

In `utils/offline/plan.ts`, replace the return type and the two non-cascade branches (`:71-107`):

```ts
export function applyOutcome(args: {
  txid: string
  outcome: PostOutcome
  txs: OrderableTx[]
  rows: OfflineActionRow[]
}): {
  sent: string[]
  rejected: { txid: string; reason: string; poisonedByTxid: string }[]
  /**
   * Txids that must be skipped for the rest of this run and left queued: the
   * failed transaction plus everything that spends it. A serviceError carries
   * no verdict, so nothing is rejected — but no descendant may post before its
   * parent, and every OTHER root in the plan is unaffected and keeps going.
   * The old run-global `stop` made one unreachable service poison a whole
   * queue of independent payments per pass.
   */
  blocked: string[]
} {
  const { txid, outcome, txs } = args
  if (outcome === 'success') return { sent: [txid], rejected: [], blocked: [] }
  if (outcome === 'serviceError') {
    return { sent: [], rejected: [], blocked: [txid, ...descendantsOf(txid, txs)] }
  }
  // ... the invalidTx/doubleSpend cascade below is unchanged except its
  // return gains `blocked: []` (the subtree is rejected, not deferred):
```

and at the cascade's return (`:106`): `return { sent: [], rejected, blocked: [] }`.

`descendantsOf` is already imported at `plan.ts:10`.

- [ ] **Step 4: Update the driver**

In `storage/methods/processOfflineActions.ts`, replace the loop body (`:140-197`) with:

```ts
  let sent = 0
  let rejected = 0
  const resolved = new Set<string>()
  const skip = new Set<string>()
  const stallNotes: string[] = blocked.length > 0 ? [...blocked] : []

  for (const step of plan) {
    if (skip.has(step.txid)) continue
    const action = step.owned ? held.get(step.txid) : undefined
    if (step.owned && !action) {
      // Its request is gone, so it can never be posted — and nothing downstream
      // of it may go out either, or it becomes an orphan. Skip the subtree and
      // keep releasing independent roots: this is a local anomaly, not a
      // network verdict, and 'failed' is not reversible.
      skip.add(step.txid)
      for (const d of descendantsOf(step.txid, txs)) skip.add(d)
      stallNotes.push(`${step.txid} has no request to release it with`)
      continue
    }
    if (action) await updateOfflineAction(db, step.txid, { status: 'posting' })

    const outcome = action ? await postOwned(storage, action.api) : await postForeign(storage, merged, step.txid)
    // A cascade needs to see what spends the refused transaction, and beefs only
    // reach backwards, so the graph the queue built cannot contain a spender that
    // is not itself queued. Widened only when a cascade is actually about to run,
    // because that widening reads every undecided request in the wallet.
    const cascadeTxs = outcome === 'success' || outcome === 'serviceError' ? txs : await withLocalSpenders(storage, txs)
    const result = applyOutcome({ txid: step.txid, outcome, txs: cascadeTxs, rows })

    for (const txid of result.sent) {
      resolved.add(txid)
      if (held.has(txid)) {
        await updateOfflineAction(db, txid, { status: 'sent' })
        sent++
      } else {
        devLog(`[processOfflineActions] foreign ancestor broadcast: ${txid}`)
      }
    }
    for (const r of result.rejected) {
      resolved.add(r.txid)
      try {
        if (await rejectOne(storage, db, held.get(r.txid)?.row, r)) rejected++
      } catch (e) {
        // The walk must reach the parent. A child's failure has already released
        // the parent's outputs back to spendable, so abandoning the cascade here
        // would leave refused money spendable — the exact outcome children-first
        // ordering exists to prevent.
        devLog(`[processOfflineActions] could not record the rejection of ${r.txid}:`, e)
      }
    }
    for (const b of result.blocked) skip.add(b)
    if (result.blocked.length > 0 && !action) {
      // A foreign ancestor no service would take blocks everything behind it and
      // retrying will not change that, whereas our own failed post is the
      // ordinary "signal went away" case the next run picks up.
      stallNotes.push(`${step.txid} is an ancestor from another wallet's beef that no service would accept`)
    }
  }

  await requeue(db, plan, resolved)
  return {
    sent,
    rejected,
    stopped: skip.size > 0,
    stalledOn: stallNotes.length > 0 ? stallNotes.join('; ') : undefined
  }
```

Add `descendantsOf` to the existing import from `@/utils/offline/order` at the top of the file, and delete the now-unused `stalledOn` const at `:135` (its `blocked` array feeds `stallNotes` instead). The early-return for `rows.length === 0` (`:78`) and the offline probe (`:80-83`) are untouched.

- [ ] **Step 5: Update the driver tests**

In `__tests__/processOfflineActions.test.ts`: any case pinning "one serviceError requeues everything and stops" changes to expect independent roots still posting. Add one new case:

```ts
  it('a failed root does not block an independent root in the same run', async () => {
    // Two unrelated queued transactions A and D. Posting A fails with a
    // service error; D must still be posted and marked sent in the SAME run.
    // Build with the suite's existing fake storage/db helpers: enqueue A and D,
    // make the post path fail for A (serviceError) and succeed for D.
    // Assert: result.sent === 1, result.stopped === true,
    // A's row status === 'queued', D's row status === 'sent'.
  })
```

Write it against the suite's existing fakes (the file already builds fake reqs and a fake db for its ordering tests — follow the pattern of the adjacent cases; the new case differs only in which txids the fake post rejects).

- [ ] **Step 6: Run to verify pass**

Run: `npx jest offlinePlan processOfflineActions`
Expected: PASS.

Run: `npx jest`
Expected: full suite green.

- [ ] **Step 7: Commit**

```bash
git add utils/offline/plan.ts storage/methods/processOfflineActions.ts __tests__/offlinePlan.test.ts __tests__/processOfflineActions.test.ts
git commit -m "fix(pay): a failed subtree no longer blocks independent queued payments"
```

---

### Task 4: The framePayload column

**Files:**
- Modify: `storage/schema/createTables.ts` (`offline_actions` DDL at `:341-355` + new helper), `storage/StorageExpoSQLite.ts:87-90` (`migrate`), `storage/methods/offlineActions.ts` (row type + insert), `utils/offline/payerHold.ts`
- Test: `__tests__/payerHold.test.ts` (framePayload passthrough), `__tests__/processOfflineActions.test.ts` or a small new block in it (ensureColumns behaviour with a fake db)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `offline_actions.framePayload TEXT` — the payer's full `bsvpayf1:` QR string, persisted so the code can be re-shown after an app restart. Null for received rows and for AWDL sends.
  - `ensureOfflineActionsColumns(db: { getAllAsync(sql: string, params: unknown[]): Promise<unknown[]>; execAsync(sql: string): Promise<unknown> }): Promise<void>` exported from `createTables.ts`.
  - `OfflineActionRow.framePayload: string | null`; `NewOfflineAction.framePayload?: string`.
  - `holdSentPaymentOffline(args: { storage: StorageExpoSQLite; txid: string; framePayload?: string }): Promise<void>` — widened signature; also calls `TaskSendOffline.noteEnqueued()` after a successful insert.

`CREATE TABLE IF NOT EXISTS` cannot add a column to an existing install, so this is the table's first real migration: a `PRAGMA table_info` check followed by a guarded `ALTER TABLE`. The pattern set here is the pattern the table lives with.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/payerHold.test.ts` (follow the file's existing fake-storage pattern — it already stubs `sqliteDb`, `findTransactions`, `updateTransactionStatus`):

```ts
  it('persists the frame payload on the queue row when given one', async () => {
    // Use the suite's existing fake storage; capture insert params.
    // holdSentPaymentOffline({ storage, txid: 'T', framePayload: 'bsvpayf1:abc' })
    // Assert the INSERT received 'bsvpayf1:abc' in the framePayload position and
    // that TaskSendOffline.hasPending flipped true (reset it in beforeEach via
    // TaskSendOffline.resetForTests()).
  })
```

Write it concretely against the file's fake db (the fake's `runAsync` already records `(sql, params)` pairs for the existing assertions — assert `params` contains the payload and `sql` names the `framePayload` column).

Add to `__tests__/processOfflineActions.test.ts` (or a new small describe in it):

```ts
import { ensureOfflineActionsColumns } from '@/storage/schema/createTables'

describe('ensureOfflineActionsColumns', () => {
  function fakeDb(columns: string[]) {
    const executed: string[] = []
    return {
      executed,
      getAllAsync: async () => columns.map(name => ({ name })),
      execAsync: async (sql: string) => { executed.push(sql) }
    }
  }

  it('adds framePayload when missing', async () => {
    const db = fakeDb(['offlineActionId', 'txid', 'status'])
    await ensureOfflineActionsColumns(db)
    expect(db.executed.some(s => /ALTER TABLE offline_actions ADD COLUMN framePayload TEXT/.test(s))).toBe(true)
  })

  it('does nothing when the column exists', async () => {
    const db = fakeDb(['offlineActionId', 'framePayload'])
    await ensureOfflineActionsColumns(db)
    expect(db.executed).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest payerHold processOfflineActions`
Expected: FAIL — `ensureOfflineActionsColumns` not exported; framePayload assertions fail.

- [ ] **Step 3: Schema**

In `storage/schema/createTables.ts`, add `framePayload TEXT,` to the `offline_actions` CREATE statement after `poisonedByTxid TEXT,` (new installs get it directly), and export the migration helper:

```ts
/**
 * Post-ship column additions to offline_actions. CREATE TABLE IF NOT EXISTS
 * cannot alter an existing table, so upgrades go through a PRAGMA check + a
 * guarded ALTER. Add future columns to the COLUMNS list; never remove or
 * retype one here — SQLite ALTER cannot do either, and this table is live
 * money bookkeeping on shipped devices.
 */
const OFFLINE_ACTIONS_COLUMNS: { name: string; ddl: string }[] = [
  { name: 'framePayload', ddl: 'ALTER TABLE offline_actions ADD COLUMN framePayload TEXT' }
]

export async function ensureOfflineActionsColumns(db: {
  getAllAsync(sql: string, params: unknown[]): Promise<unknown[]>
  execAsync(sql: string): Promise<unknown>
}): Promise<void> {
  const info = (await db.getAllAsync('PRAGMA table_info(offline_actions)', [])) as { name: string }[]
  const have = new Set(info.map(c => c.name))
  for (const col of OFFLINE_ACTIONS_COLUMNS) {
    if (!have.has(col.name)) await db.execAsync(col.ddl)
  }
}
```

In `storage/StorageExpoSQLite.ts` `migrate()` (`:87-90`), after `await createTables(this.db)`:

```ts
    await ensureOfflineActionsColumns(this.db)
```

(add the import next to the existing `createTables` import at `:3`).

- [ ] **Step 4: Mapper + payer hold**

`storage/methods/offlineActions.ts`:
- `OfflineActionRow` gains `framePayload: string | null` (after `poisonedByTxid`).
- `NewOfflineAction` gains `framePayload?: string`.
- `insertOfflineAction`'s SQL becomes:

```ts
  await db.runAsync(
    `INSERT OR IGNORE INTO offline_actions
       (created_at, updated_at, userId, txid, seq, role, senderIdentityKey, receivedVia, status, framePayload)
     VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM offline_actions), ?, ?, ?, 'queued', ?)`,
    [
      now, now, entry.userId, entry.txid, entry.role,
      entry.senderIdentityKey ?? null, entry.receivedVia ?? null, entry.framePayload ?? null
    ]
  )
```

`utils/offline/payerHold.ts` — widen the signature and arm the drain (the long ORDER MATTERS comment stays):

```ts
import { insertOfflineAction } from '@/storage/methods/offlineActions'
import { TaskSendOffline } from '@/utils/monitor/TaskSendOffline'
import type { StorageExpoSQLite } from '@/storage/StorageExpoSQLite'

export async function holdSentPaymentOffline(args: {
  storage: StorageExpoSQLite
  txid: string
  /** The full bsvpayf1: QR string, persisted so the code can be re-shown later. */
  framePayload?: string
}): Promise<void> {
  const { storage, txid, framePayload } = args
  ...
  await insertOfflineAction(db, { userId: tx.userId, txid, role: 'sent', framePayload })
  TaskSendOffline.noteEnqueued()
  await storage.updateTransactionStatus('unproven', tx.transactionId)
}
```

Also arm from the receive side: in `storage/StorageExpoSQLite.ts` `holdReqsOffline` (`:1438-1476`), after the loop that inserts the queue rows completes, add `TaskSendOffline.noteEnqueued()` (one import; the task class has no React or storage dependencies, so no cycle).

- [ ] **Step 5: Run to verify pass, then full suite**

Run: `npx jest payerHold processOfflineActions offlineHold`
Expected: PASS.
Run: `npx jest`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add storage/schema/createTables.ts storage/StorageExpoSQLite.ts storage/methods/offlineActions.ts utils/offline/payerHold.ts __tests__/payerHold.test.ts __tests__/processOfflineActions.test.ts
git commit -m "feat(pay): persist the payer's QR payload on the queue row (first offline_actions migration)"
```

---

### Task 5: Done becomes a real delivery decision

**Files:**
- Modify: `components/pay/NearbyFlow.tsx` — `executeSend`'s qr branch (`:995-1008`) and AWDL-catch (`:1010-1028`), the send_qr Done button (`:1596-1605`), `reset()` (`:468-491`)
- Test: none new — `finalizeDelivery`'s online/offline/hold behaviour is already pinned by `__tests__/localpayBuild.test.ts`, and Task 4 pinned the framePayload passthrough. Device step in Task 17 validates the UI path.

**Interfaces:**
- Consumes: `finalizeDelivery(wallet, built, ack, originator, { hold })` (`utils/localpay/build.ts:263`) — called with a synthetic positive ack `{ ok: true }`; `holdSentPaymentOffline` with `framePayload` (Task 4); `frameToQr` (existing).
- Produces: `completeQrDelivery()` callback inside NearbyFlow; `builtRef` holding the built payment while the QR is on screen.

Today Done on the shown payment QR does nothing (`NearbyFlow.tsx:1587-1605` — deliberate at the time), which leaves the payer's transaction at `nosend` with no queue row: the exact stuck state reported from device testing. New semantics: Done asserts delivery. Online it broadcasts (identical to a positive AWDL ack); offline it holds + enqueues with the frame persisted for re-show. A payee who scans *after* the broadcast still internalizes fine — the forced broadcast finds the txid already in the mempool, which the provider chain reads as success.

- [ ] **Step 1: Hold the built payment while the QR is up**

Near the other refs (`:395-399`) add:

```ts
  /**
   * The built payment behind the QR currently on screen. Done routes it
   * through finalizeDelivery; without it Done can only guess. Cleared by
   * reset() and consumed (nulled) by completeQrDelivery.
   */
  const builtRef = useRef<Awaited<ReturnType<typeof buildPaymentFrame>> | null>(null)
```

In `executeSend`'s qr branch (`:995-1008`), set it before showing the QR:

```ts
      if (sendKind === 'qr') {
        if (!qr) {
          abortBuild(built.reference)
          setPaymentQr(null)
          fail('generic', t('local_pay_too_large'))
          return
        }
        builtRef.current = built
        setPaymentQr(qr)
        setPhase('send_qr')
        return
      }
```

In the AWDL-catch branch (`:1013-1027`), before `setPaymentQr(qr)`, add `builtRef.current = qr ? built : null` (the QR offer only exists when the frame fits; a null offer keeps the old failure path).

In `reset()` (inside the callback at `:468-491`), add `builtRef.current = null`.

- [ ] **Step 2: The delivery callback**

Below `executeSend`, add:

```ts
  // ── Send: the payer asserts QR delivery ──
  //
  // The QR path has no ack channel, so "the payee has it" is the user's claim,
  // made by tapping Done. Acting on that claim mirrors a positive AWDL ack:
  // broadcast when online, hold + queue when offline. This replaces the old
  // do-nothing Done, which stranded the transaction at nosend with no queue
  // row — nothing in the system would ever broadcast it. The risk of a wrong
  // claim is bounded: the frame is persisted on the queue row, the code can be
  // re-shown from /pay, and a payee scanning after the broadcast internalizes
  // the already-mempooled transaction as a merge.
  const completeQrDelivery = useCallback(async () => {
    const built = builtRef.current
    if (!built || !wallet) {
      // No handle (e.g. re-entry after reset): nothing to decide, just close.
      setSettledAmount(payAmount)
      setRole('payer')
      setPhase('done')
      return
    }
    builtRef.current = null
    setPhase('send_working')
    const outcome = await finalizeDelivery(wallet as unknown as PayingWalletArg, built, { ok: true }, adminOriginator, {
      hold: async txid => {
        if (!storage) throw new Error('no local storage to queue this payment in')
        await holdSentPaymentOffline({ storage, txid, framePayload: frameToQr(built.frame) })
      }
    })
    if (outcome.kind === 'sent' && outcome.broadcast === 'pending') {
      console.warn('[localpay] QR delivery queued or broadcast pending:', outcome.detail ?? '')
      setNotice({ text: t('local_pay_broadcast_pending'), tone: 'warning' })
    }
    setSettledAmount(payAmount)
    setRole('payer')
    setPhase('done')
  }, [wallet, storage, adminOriginator, payAmount, t])
```

(`finalizeDelivery` with `ack.ok === true` never takes the decline branch, so `outcome.kind === 'declined'` is unreachable here; `frameToQr` is already imported from the rails barrel at the top of the file.)

- [ ] **Step 3: Point Done at it**

Replace the send_qr Done button's `onPress` (`:1600-1604`) with `onPress={() => void completeQrDelivery()}` and replace the "Deliberately does NOT abort the build" comment block (`:1587-1595`) with:

```tsx
            {/* Done asserts delivery: broadcast when online, hold + queue when
                offline (see completeQrDelivery). Never an abort — the payee may
                be about to broadcast this frame, and freeing its inputs would
                let this wallet respend them into a conflict. */}
```

- [ ] **Step 4: Verify**

Run: `npx jest` — green (payScreen/payNearbyRail suites mount this component; if any snapshot pins the old comment text, update it).
Run: `npx prettier --check components/pay/NearbyFlow.tsx && npx eslint components/pay/NearbyFlow.tsx`

- [ ] **Step 5: Commit**

```bash
git add components/pay/NearbyFlow.tsx
git commit -m "fix(pay): Done on the payment QR broadcasts or queues instead of stranding the payment"
```

---

### Task 6: Send now, stall surfacing, and re-show

**Files:**
- Modify: `components/pay/OfflineNotice.tsx`, `app/pay.tsx` (queue effect `:112-140` + render site of `OfflineNotice` + new modal), `context/i18n/translations.tsx`
- Test: `__tests__/offlineNotice.test.tsx` (extend — the file exists and renders the component with fake rows)

**Interfaces:**
- Consumes: `TaskSendOffline.requestNow()`, `TaskSendOffline.lastStall` (Task 1); `OfflineActionRow.framePayload` (Task 4); `txStatusVersion` from `useWallet()`.
- Produces: `OfflineNoticeProps` gains `onSendNow?: () => void`, `stalled?: string`, `queuedSent?: OfflineActionRow[]`, `onShowCode?: (row: OfflineActionRow) => void`.

- [ ] **Step 1: Extend the notice tests**

In `__tests__/offlineNotice.test.tsx`, add (following the file's existing render helpers):

```tsx
  it('shows a Send now button when online with a queue and fires the callback', () => {
    const onSendNow = jest.fn()
    // render OfflineNotice with online={true} queued={2} rejected={[]} onSendNow={onSendNow}
    // fireEvent.press the node with text matching the pay_offline_send_now string
    // expect(onSendNow).toHaveBeenCalled()
  })

  it('renders the stall detail when one exists', () => {
    // render with online={true} queued={1} stalled="txA has no request"
    // expect text containing "txA has no request" to be present
  })

  it('offers show-code only for queued sent rows that carry a frame', () => {
    const withFrame = { ...fakeRow, role: 'sent', status: 'queued', framePayload: 'bsvpayf1:abc' }
    const without = { ...fakeRow, txid: 'other', role: 'sent', status: 'queued', framePayload: null }
    // render with queuedSent={[withFrame, without]} and onShowCode
    // expect exactly one show-code button
  })
```

Write them concretely against the fixtures already defined in that file (it builds `OfflineActionRow` fakes for the rejected-row cases — reuse and extend those, adding `framePayload: null` to the base fake now that the type requires it).

- [ ] **Step 2: Run to verify failure**

Run: `npx jest offlineNotice`
Expected: FAIL — unknown props / missing strings.

- [ ] **Step 3: Extend OfflineNotice**

In `components/pay/OfflineNotice.tsx`:
- Props (`:39-51`) gain:

```ts
  /** Fires TaskSendOffline.requestNow via the caller. Rendered only when online with a queue. */
  onSendNow?: () => void
  /** TaskSendOffline.lastStall — set when retrying alone will not drain the queue. */
  stalled?: string
  /** Queued/posting rows the user sent. Rows with a framePayload get a re-show affordance. */
  queuedSent?: OfflineActionRow[]
  onShowCode?: (row: OfflineActionRow) => void
```

- In the `online && queued > 0` card (`:76-86`), after the body `<Text>`, add:

```tsx
            {!!stalled && (
              <Text style={[styles.body, { color: colors.warning }]}>
                {t('pay_offline_stalled_body', { detail: stalled })}
              </Text>
            )}
            {onSendNow && (
              <Text
                accessibilityRole="button"
                onPress={onSendNow}
                style={[styles.action, { color: colors.info }]}
              >
                {t('pay_offline_send_now')}
              </Text>
            )}
```

- After the `sentRejected` map (`:105-118`), add the re-show rows:

```tsx
      {(queuedSent ?? [])
        .filter(r => r.framePayload)
        .map(r => (
          <View key={`code-${r.txid}`} style={[styles.card, { backgroundColor: colors.fillTertiary, borderColor: colors.separator }]}>
            <Ionicons name="qr-code-outline" size={18} color={colors.textSecondary} />
            <View style={styles.text}>
              <Text style={[styles.body, { color: colors.textSecondary }]}>{r.created_at.slice(0, 10)}</Text>
              <Text
                accessibilityRole="button"
                onPress={() => onShowCode?.(r)}
                style={[styles.action, { color: colors.info }]}
              >
                {t('pay_offline_show_code')}
              </Text>
            </View>
          </View>
        ))}
```

- Add to the stylesheet: `action: { ...typography.subhead, fontWeight: '600', marginTop: 4 }`.
- The top-of-file early return (`:56`) must also consider the new content: `if (online && queued === 0 && rejected.length === 0 && sentRejected.length === 0 && (queuedSent ?? []).length === 0) return null`.

- [ ] **Step 4: Wire pay.tsx**

In `app/pay.tsx`:
- Destructure `txStatusVersion` from `useWallet()` (`:104`) and add it to the queue effect's dep array (`:140`) so a drain refreshes the banner.
- Extend the queue effect to keep the sent rows and the stall:

```ts
  const [queuedSentRows, setQueuedSentRows] = useState<OfflineActionRow[]>([])
  const [stalled, setStalled] = useState<string | undefined>(undefined)
  // inside the effect, after setQueued(...):
        setQueuedSentRows(rows.filter(r => r.status !== 'rejected' && r.role === 'sent'))
        setStalled(TaskSendOffline.lastStall)
```

(import `TaskSendOffline` from `@/utils/monitor/TaskSendOffline`).
- Re-show modal + send-now state:

```tsx
  const [showCode, setShowCode] = useState<OfflineActionRow | null>(null)
```

Pass to the `OfflineNotice` render site:

```tsx
        onSendNow={() => TaskSendOffline.requestNow()}
        stalled={stalled}
        queuedSent={queuedSentRows}
        onShowCode={setShowCode}
```

And render, next to the screen's other modals:

```tsx
      <Modal visible={!!showCode} animationType="slide" transparent onRequestClose={() => setShowCode(null)}>
        <View style={styles.codeOverlay}>
          <View style={[styles.codeCard, { backgroundColor: colors.backgroundElevated }]}>
            {showCode?.framePayload && showCode.framePayload.length <= MAX_FRAME_QR_CHARS ? (
              <QRCode value={showCode.framePayload} size={288} ecl="M" color="#000" backgroundColor="#fff" />
            ) : (
              <Text style={{ color: colors.textSecondary }}>{t('local_pay_too_large')}</Text>
            )}
            <TouchableOpacity onPress={() => setShowCode(null)} style={styles.codeClose}>
              <Text style={{ color: colors.info }}>{t('done')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
```

with imports (`react-native-qrcode-svg`, `Modal`, `MAX_FRAME_QR_CHARS` from `@/utils/pay/rails/nearby`) and two styles (`codeOverlay`: flex 1, centered, `rgba(0,0,0,0.5)`; `codeCard`: padding `spacing.xl`, borderRadius 16, alignItems center, gap `spacing.lg`; `codeClose`: padding `spacing.md`). Phase 2's Task 11 swaps the static `<QRCode>` here for `PaymentQrDisplay`, which removes the too-large branch.

- [ ] **Step 5: The strings, six locales**

Add to each locale block of `context/i18n/translations.tsx`:

| key | en | zh | hi | es | fr | ar |
| --- | --- | --- | --- | --- | --- | --- |
| `pay_offline_send_now` | Send now | 立即发送 | अभी भेजें | Enviar ahora | Envoyer maintenant | أرسل الآن |
| `pay_offline_stalled_body` | Some queued payments can't be sent automatically: {{detail}} | 部分排队付款无法自动发送：{{detail}} | कुछ कतारबद्ध भुगतान स्वतः नहीं भेजे जा सकते: {{detail}} | Algunos pagos en cola no se pueden enviar automáticamente: {{detail}} | Certains paiements en attente ne peuvent pas être envoyés automatiquement : {{detail}} | تعذّر إرسال بعض المدفوعات في قائمة الانتظار تلقائيًا: {{detail}} |
| `pay_offline_show_code` | Show code again | 再次显示付款码 | कोड फिर दिखाएँ | Mostrar el código otra vez | Réafficher le code | إظهار الرمز مرة أخرى |

- [ ] **Step 6: Run to verify pass**

Run: `npx jest offlineNotice payScreen`
Expected: PASS.
Run: `npx jest` — green. `npx prettier --check` + `npx eslint` on the four touched files.

- [ ] **Step 7: Commit**

```bash
git add components/pay/OfflineNotice.tsx app/pay.tsx context/i18n/translations.tsx __tests__/offlineNotice.test.tsx
git commit -m "feat(pay): send-now control, stall surfacing, and re-showable payment codes"
```

---

### Task 7: Offline badges in the transactions screen

**Files:**
- Modify: `app/transactions.tsx` (`fetchActions` `:63-70`, `getStatusInfo` `:32-43`, `renderItem` `:198-204`), `context/WalletContext.tsx` (expose `walletUserId`), `app/pay.tsx:119` (userId scoping), `context/i18n/translations.tsx`
- Test: none new (screen-level; `payScreen.test.tsx` covers /pay's query change if it pins the call shape). Device step in Task 17.

**Interfaces:**
- Consumes: `findOfflineActions(db, { status, userId })` (`storage/methods/offlineActions.ts:70`); `storageManager.getAuth()` (`@bsv/wallet-toolbox-mobile` `WalletStorageManager.d.ts:94`, returns `Promise<sdk.AuthId>` whose `userId: number`).
- Produces: `useWallet().walletUserId: number | null` — the active user's storage id, for scoping `offline_actions` reads.

- [ ] **Step 1: Expose walletUserId**

In `context/WalletContext.tsx`: add state `const [walletUserId, setWalletUserId] = useState<number | null>(null)` next to `txStatusVersion` (`:328` area). In the wallet-build flow, directly after `await storageManager.addWalletStorageProvider(phoneStorage as any)` (`:832`), add:

```ts
          try {
            const auth = await storageManager.getAuth()
            setWalletUserId(auth.userId ?? null)
          } catch {
            // Scoping is a filter, not a gate: with no id the queue reads fall
            // back to unscoped, which is today's behaviour.
            setWalletUserId(null)
          }
```

Reset it to `null` in `logout` (`:1568+`, alongside the other resets) and add `walletUserId` to the context value object and its type.

- [ ] **Step 2: Scope the /pay query**

`app/pay.tsx:119` becomes:

```ts
        const rows = await findOfflineActions(db, {
          status: ['queued', 'posting', 'rejected'],
          ...(walletUserId === null ? {} : { userId: walletUserId })
        })
```

(destructure `walletUserId` from `useWallet()`, add to the effect deps.)

- [ ] **Step 3: Badge overlay in transactions.tsx**

- New state + fetch alongside `fetchActions` (`:63-70`):

```ts
  const [offlineByTxid, setOfflineByTxid] = useState<Map<string, OfflineActionRow>>(new Map())

  const fetchOfflineRows = useCallback(async () => {
    try {
      const db = storage?.sqliteDb
      if (!db) return
      const rows = await findOfflineActions(db, {
        status: ['queued', 'posting', 'rejected'],
        ...(walletUserId === null ? {} : { userId: walletUserId })
      })
      // 'sent' rows are excluded by the query: a settled transaction must show
      // its normal status, and sent rows persist as provenance.
      setOfflineByTxid(new Map(rows.map(r => [r.txid, r])))
    } catch {
      // The overlay is advisory. A read failure must not break the list.
    }
  }, [storage, walletUserId])
```

Call `void fetchOfflineRows()` inside the existing initial-load effect (`:72-84`, it already re-runs on `txStatusVersion`) and inside `onRefresh`.
Imports: `findOfflineActions`, `type OfflineActionRow` from `@/storage/methods/offlineActions`.

- Extend `getStatusInfo` to accept the overlay row (keep the base cases untouched):

```ts
function getStatusInfo(
  status: string,
  colors: any,
  t: (key: string) => string,
  offline?: OfflineActionRow
): StatusInfo {
  // The queue row is live held-state and outranks the raw transaction status:
  // a held tx sits at 'unproven' (green "Accepted" — indistinguishable from a
  // broadcast one) or, when the payer-side promotion failed, at 'nosend'
  // (indistinguishable from a deliberate pending-signature noSend).
  if (offline) {
    switch (offline.status) {
      case 'queued': return { label: t('tx_status_offline_queued'), color: colors.info }
      case 'posting': return { label: t('tx_status_offline_sending'), color: colors.info }
      case 'rejected': return { label: t('tx_status_offline_rejected'), color: colors.error }
    }
  }
  switch (status) {
    ... // existing cases unchanged
```

- In `renderItem` (`:199`): `const status = getStatusInfo(item.status, colors, t, item.txid ? offlineByTxid.get(item.txid) : undefined)` and add `offlineByTxid` to the callback's dep array (`:283`).

- [ ] **Step 4: The strings, six locales**

| key | en | zh | hi | es | fr | ar |
| --- | --- | --- | --- | --- | --- | --- |
| `tx_status_offline_queued` | Offline · queued | 离线 · 已排队 | ऑफ़लाइन · कतार में | Sin conexión · en cola | Hors ligne · en file | دون اتصال · في قائمة الانتظار |
| `tx_status_offline_sending` | Offline · sending | 离线 · 发送中 | ऑफ़लाइन · भेजा जा रहा है | Sin conexión · enviando | Hors ligne · envoi | دون اتصال · جارٍ الإرسال |
| `tx_status_offline_rejected` | Offline · rejected | 离线 · 已拒绝 | ऑफ़लाइन · अस्वीकृत | Sin conexión · rechazado | Hors ligne · rejeté | دون اتصال · مرفوض |

- [ ] **Step 5: Verify + commit**

Run: `npx jest` — green. Prettier/eslint on the four touched files.

```bash
git add app/transactions.tsx app/pay.tsx context/WalletContext.tsx context/i18n/translations.tsx
git commit -m "feat(pay): offline queue badges in the transactions list, userId-scoped queue reads"
```

**Phase 1 exit criteria:** full suite green; on device, an offline QR-path send tapped Done shows "Offline · queued" in transactions, and reconnecting Wi-Fi broadcasts it within ~10 s with the badge clearing without a manual refresh.

---

# Phase 2 — QR fountain, transport ladder, session v2

Unlocks every cross-OS pair and removes the size ceiling. Depends on Phase 1 (Done semantics, `framePayload`).

### Task 8: The fountain codec

**Files:**
- Create: `utils/localpay/fountain.ts`
- Modify: `utils/localpay/codec.ts` (one new export)
- Test: `__tests__/localpayFountain.test.ts` (new), `__tests__/localpayCodec.test.ts` (one new case)

**Interfaces:**
- Consumes: nothing (pure module; reuses codec's base64url shape by construction).
- Produces:
  - `FOUNTAIN_QR_PREFIX = 'bsvpayf2:'`, `BLOCK_BYTES = 1200`, `MAX_MESSAGE_BYTES = 65536`, `FOUNTAIN_FRAME_MS = 200`
  - `crc32(bytes: Uint8Array): number`
  - `class FountainEncoder { constructor(message: Uint8Array, blockBytes?: number); readonly blockCount: number; partAt(seq: number): string }`
  - `class FountainDecoder { accept(text: string): { ok: boolean; done: boolean; have: number; total: number }; message(): Uint8Array | null }`
  - from `codec.ts`: `frameBytesFromQr(text: string): Uint8Array` — the raw frame bytes behind a `bsvpayf1:` string.

The message is the exact `encodeFrame` output (the bytes behind a `bsvpayf1:` payload). It is split into K = ceil(len / blockBytes) fixed-size blocks (last block zero-padded; `msgLen` in every part header recovers the true length). Part `seq < K` is block `seq` verbatim — the systematic prefix, so a receiver that catches one clean cycle decodes with zero overhead. Part `seq ≥ K` is the XOR of a pseudo-random subset of blocks chosen deterministically from `seq`, so encoder and decoder never exchange anything but the parts themselves. Wire shape per part:

```
'bsvpayf2:' + base64url( header ‖ payload )
header  = seq u32BE ‖ K u16BE ‖ msgLen u32BE ‖ crc32 u32BE   (14 bytes)
payload = blockBytes bytes (the decoder infers the block size from the payload length)
```

At the default 1,200-byte block a part is 1,214 bytes ≈ 1,628 QR characters — well under the 2,200-char guard and the encoder's measured 2,276 throw point.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/localpayFountain.test.ts`:

```ts
import {
  BLOCK_BYTES,
  FOUNTAIN_QR_PREFIX,
  FountainDecoder,
  FountainEncoder,
  MAX_MESSAGE_BYTES,
  crc32
} from '@/utils/localpay/fountain'

/** Deterministic pseudo-random payload, sized to span several blocks. */
function message(len: number): Uint8Array {
  const m = new Uint8Array(len)
  for (let i = 0; i < len; i++) m[i] = (i * 31 + 7) & 0xff
  return m
}

function drain(decoder: FountainDecoder, encoder: FountainEncoder, seqs: Iterable<number>): Uint8Array | null {
  for (const seq of seqs) {
    const s = decoder.accept(encoder.partAt(seq))
    if (s.done) return decoder.message()
  }
  return null
}

describe('crc32', () => {
  it('matches the standard vector', () => {
    // CRC-32 of ascii "123456789" is 0xCBF43926.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })
})

describe('FountainEncoder', () => {
  it('emits parts of constant size with the right prefix', () => {
    const enc = new FountainEncoder(message(5000), 1200)
    const p0 = enc.partAt(0)
    const p9 = enc.partAt(9)
    expect(p0.startsWith(FOUNTAIN_QR_PREFIX)).toBe(true)
    expect(p0.length).toBe(p9.length)
  })

  it('refuses an empty or oversize message', () => {
    expect(() => new FountainEncoder(new Uint8Array(0))).toThrow()
    expect(() => new FountainEncoder(message(MAX_MESSAGE_BYTES + 1))).toThrow()
  })

  it('computes blockCount as ceil(len / blockBytes)', () => {
    expect(new FountainEncoder(message(2400), 1200).blockCount).toBe(2)
    expect(new FountainEncoder(message(2401), 1200).blockCount).toBe(3)
  })
})

describe('FountainDecoder', () => {
  it('decodes from one clean systematic cycle', () => {
    const msg = message(5000) // K = 5 at 1200
    const enc = new FountainEncoder(msg, 1200)
    const dec = new FountainDecoder()
    const out = drain(dec, enc, [0, 1, 2, 3, 4])
    expect(out).not.toBeNull()
    expect(Array.from(out!)).toEqual(Array.from(msg))
  })

  it('reports progress', () => {
    const enc = new FountainEncoder(message(5000), 1200)
    const dec = new FountainDecoder()
    expect(dec.accept(enc.partAt(0))).toEqual({ ok: true, done: false, have: 1, total: 5 })
    expect(dec.accept(enc.partAt(0))).toEqual({ ok: true, done: false, have: 1, total: 5 }) // duplicate
  })

  it('recovers a message when systematic parts are missed (mixed parts only past K)', () => {
    const msg = message(6000) // K = 5
    const enc = new FountainEncoder(msg, 1200)
    const dec = new FountainDecoder()
    // Skip parts 1 and 3 entirely; feed the rest of the first two cycles.
    const out = drain(dec, enc, [0, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
    expect(out).not.toBeNull()
    expect(Array.from(out!)).toEqual(Array.from(msg))
  })

  it('handles out-of-order and interleaved duplicates', () => {
    const msg = message(3700) // K = 4, last block padded
    const enc = new FountainEncoder(msg, 1200)
    const dec = new FountainDecoder()
    const out = drain(dec, enc, [3, 3, 1, 6, 0, 1, 5, 2])
    expect(out).not.toBeNull()
    expect(Array.from(out!)).toEqual(Array.from(msg))
  })

  it('decodes a message that is an exact multiple of the block size', () => {
    const msg = message(2400)
    const enc = new FountainEncoder(msg, 1200)
    const dec = new FountainDecoder()
    const out = drain(dec, enc, [0, 1])
    expect(Array.from(out!)).toEqual(Array.from(msg))
  })

  it('a single-block message decodes from one part', () => {
    const msg = message(37)
    const enc = new FountainEncoder(msg, 1200)
    const dec = new FountainDecoder()
    const out = drain(dec, enc, [0])
    expect(Array.from(out!)).toEqual(Array.from(msg))
  })

  it('ignores strings that are not parts', () => {
    const dec = new FountainDecoder()
    expect(dec.accept('bsvpay1:notapart').ok).toBe(false)
    expect(dec.accept('bsvpayf2:!!!not-base64!!!').ok).toBe(false)
  })

  it('resets when a different message arrives', () => {
    const encA = new FountainEncoder(message(5000), 1200)
    const encB = new FountainEncoder(message(2400), 1200)
    const dec = new FountainDecoder()
    dec.accept(encA.partAt(0))
    const s = dec.accept(encB.partAt(0))
    expect(s.total).toBe(2)
    expect(s.have).toBe(1)
  })

  it('a corrupt assembly is discarded and collection continues', () => {
    const msg = message(2400) // K = 2
    const enc = new FountainEncoder(msg, 1200)
    const dec = new FountainDecoder()
    // Hand-corrupt part 1's payload: decode its base64, flip a payload byte,
    // re-encode with the SAME header (so crc in the header no longer matches
    // the assembled bytes).
    const raw = enc.partAt(1)
    const b64 = raw.slice(FOUNTAIN_QR_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(globalThis.atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), c => c.charCodeAt(0))
    bytes[20] ^= 0xff
    let bin = ''
    for (const byte of bytes) bin += String.fromCharCode(byte)
    const corrupt =
      FOUNTAIN_QR_PREFIX + globalThis.btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

    dec.accept(enc.partAt(0))
    const s = dec.accept(corrupt)
    expect(s.done).toBe(true)
    expect(dec.message()).toBeNull() // crc mismatch → discard, decoder reset
    // The stream keeps flowing; a fresh clean cycle completes.
    dec.accept(enc.partAt(0))
    const s2 = dec.accept(enc.partAt(1))
    expect(s2.done).toBe(true)
    expect(Array.from(dec.message()!)).toEqual(Array.from(msg))
  })
})
```

Add to `__tests__/localpayCodec.test.ts`:

```ts
import { frameBytesFromQr, frameToQr, encodeFrame } from '@/utils/localpay/codec'

  it('frameBytesFromQr returns the exact encodeFrame bytes', () => {
    // Reuse the suite's existing valid frame fixture (the one frameToQr tests use).
    const qr = frameToQr(fixtureFrame)
    expect(Array.from(frameBytesFromQr(qr))).toEqual(Array.from(encodeFrame(fixtureFrame)))
    expect(() => frameBytesFromQr('bsvpay1:xx')).toThrow()
  })
```

(name the fixture whatever the file already calls its valid `PaymentFrame` — do not mint a new one.)

- [ ] **Step 2: Run to verify failure**

Run: `npx jest localpayFountain localpayCodec`
Expected: FAIL — module not found / export missing.

- [ ] **Step 3: The codec export**

In `utils/localpay/codec.ts`, below `frameFromQr`:

```ts
/**
 * The raw frame bytes behind a bsvpayf1: payload, without decoding the frame.
 * The fountain path re-encodes exactly these bytes, and the re-show path needs
 * them from a persisted framePayload string.
 */
export function frameBytesFromQr(text: string): Uint8Array {
  if (!text.startsWith(FRAME_QR_PREFIX)) throw new CodecError('not a nearby-payment QR')
  return fromB64url(text.slice(FRAME_QR_PREFIX.length))
}
```

- [ ] **Step 4: The fountain module**

Create `utils/localpay/fountain.ts`:

```ts
/**
 * A Luby-transform fountain over QR codes, for payment frames too large to
 * fit one symbol.
 *
 * WHY A FOUNTAIN and not numbered chunks: at ~5 QR frames per second a
 * receiver WILL miss frames, and with plain chunk cycling every miss costs a
 * full cycle waiting for that exact index to come around again. Fountain
 * parts are interchangeable — any ~K+ε distinct parts reconstruct the K
 * source blocks — so misses cost almost nothing and neither side needs a
 * back-channel (the QR path has none).
 *
 * DETERMINISM IS THE CONTRACT: part `seq` is a pure function of
 * (message, blockBytes, seq). The first K parts are the source blocks
 * verbatim (the systematic prefix — one clean camera cycle decodes with zero
 * overhead); later parts XOR a subset of blocks chosen by an xorshift32 RNG
 * seeded from `seq` with an ideal-soliton degree. The decoder rebuilds the
 * same subset from the header's `seq` alone.
 *
 * Wire shape (see the plan/spec): 'bsvpayf2:' + base64url(header ‖ payload),
 * header = seq u32BE ‖ K u16BE ‖ msgLen u32BE ‖ crc32 u32BE = 14 bytes,
 * payload = one block-sized XOR. The block size is not in the header — the
 * decoder infers it from the payload length, which also keeps every part the
 * same size (the last source block is zero-padded).
 */
import { CodecError } from './codec'

export const FOUNTAIN_QR_PREFIX = 'bsvpayf2:'
/** 1,214-byte parts ≈ 1,628 QR chars — inside MAX_FRAME_QR_CHARS with margin. */
export const BLOCK_BYTES = 1200
/**
 * Sanity ceiling on the whole message. At ~5 parts/s and 1,200-byte blocks,
 * 64 KB is ~54 source blocks ≈ 15–30 s of scanning — already at the limit of
 * two people holding phones together. Anything bigger means something upstream
 * is wrong (the air-gap payload target is ~400 bytes).
 */
export const MAX_MESSAGE_BYTES = 65536
/** Sender animation cadence: 5 parts per second. */
export const FOUNTAIN_FRAME_MS = 200

const HEADER_BYTES = 14

// ── crc32 (IEEE 802.3, the standard table implementation) ──

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ── deterministic RNG and part→blocks mapping ──

/** xorshift32. Never returns 0; never seeded with 0. */
function makeRng(seed: number): () => number {
  let x = seed >>> 0
  if (x === 0) x = 0x6d2b79f5
  return () => {
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    return x
  }
}

/**
 * The block indices XORed into part `seq` (which must be ≥ K — below K the
 * part IS block `seq`). Ideal-soliton degree: 1 with probability 1/K, else
 * d with probability 1/(d(d-1)) via the ceil(1/u) inverse-CDF trick; indices
 * by partial Fisher–Yates so they are distinct.
 */
function blocksForPart(seq: number, k: number): number[] {
  const rng = makeRng((seq * 0x9e3779b1) >>> 0)
  // (0,1] for the degree draw — the +1 keeps 1/u finite.
  const open01 = () => ((rng() >>> 9) + 1) / 2 ** 23
  // [0,1) for index draws — floor stays in range.
  const half01 = () => (rng() >>> 9) / 2 ** 23
  let degree: number
  if (k === 1) degree = 1
  else if (open01() <= 1 / k) degree = 1
  else degree = Math.min(k, Math.ceil(1 / open01()))
  const pool = Array.from({ length: k }, (_, i) => i)
  for (let i = 0; i < degree; i++) {
    const j = i + Math.floor(half01() * (k - i))
    const t = pool[i]
    pool[i] = pool[j]
    pool[j] = t
  }
  return pool.slice(0, degree)
}

function xorInto(target: Uint8Array, source: Uint8Array): void {
  for (let i = 0; i < target.length; i++) target[i] ^= source[i]
}

// ── base64url (same shape codec.ts uses; local so this module stays standalone) ──

function toB64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = globalThis.atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  return Uint8Array.from(binary, c => c.charCodeAt(0))
}

// ── encoder ──

export class FountainEncoder {
  private readonly blocks: Uint8Array[]
  private readonly msgLen: number
  private readonly crc: number
  readonly blockCount: number

  constructor(message: Uint8Array, blockBytes: number = BLOCK_BYTES) {
    if (message.length === 0) throw new CodecError('empty fountain message')
    if (message.length > MAX_MESSAGE_BYTES) {
      throw new CodecError(`fountain message of ${message.length} bytes exceeds ${MAX_MESSAGE_BYTES}`)
    }
    this.msgLen = message.length
    this.crc = crc32(message)
    this.blockCount = Math.ceil(message.length / blockBytes)
    this.blocks = []
    for (let i = 0; i < this.blockCount; i++) {
      const block = new Uint8Array(blockBytes) // zero-padded past msgLen
      block.set(message.subarray(i * blockBytes, Math.min((i + 1) * blockBytes, message.length)))
      this.blocks.push(block)
    }
  }

  /** Part `seq`, ready to render. Deterministic; seq may grow without bound. */
  partAt(seq: number): string {
    const k = this.blockCount
    const payload =
      seq < k
        ? this.blocks[seq].slice()
        : (() => {
            const mixed = new Uint8Array(this.blocks[0].length)
            for (const index of blocksForPart(seq, k)) xorInto(mixed, this.blocks[index])
            return mixed
          })()
    const out = new Uint8Array(HEADER_BYTES + payload.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, seq >>> 0)
    view.setUint16(4, k)
    view.setUint32(6, this.msgLen)
    view.setUint32(10, this.crc)
    out.set(payload, HEADER_BYTES)
    return FOUNTAIN_QR_PREFIX + toB64url(out)
  }
}

// ── decoder ──

interface PendingPart {
  indices: Set<number>
  payload: Uint8Array
}

export class FountainDecoder {
  private key = ''
  private total = 0
  private msgLen = 0
  private crc = 0
  private seen = new Set<number>()
  private solved: (Uint8Array | null)[] = []
  private solvedCount = 0
  private pending: PendingPart[] = []

  private reset(key: string, total: number, msgLen: number, crc: number): void {
    this.key = key
    this.total = total
    this.msgLen = msgLen
    this.crc = crc
    this.seen = new Set()
    this.solved = Array.from({ length: total }, () => null)
    this.solvedCount = 0
    this.pending = []
  }

  /**
   * Feed one scanned string. Never throws: anything that is not a well-formed
   * part of the current message reports `ok: false` and changes nothing —
   * the camera WILL hand this stray reads.
   */
  accept(text: string): { ok: boolean; done: boolean; have: number; total: number } {
    const state = () => ({ ok: true, done: this.solvedCount === this.total && this.total > 0, have: this.solvedCount, total: this.total })
    if (typeof text !== 'string' || !text.startsWith(FOUNTAIN_QR_PREFIX)) {
      return { ok: false, done: false, have: this.solvedCount, total: this.total }
    }
    let bytes: Uint8Array
    try {
      bytes = fromB64url(text.slice(FOUNTAIN_QR_PREFIX.length))
    } catch {
      return { ok: false, done: false, have: this.solvedCount, total: this.total }
    }
    if (bytes.length <= HEADER_BYTES) return { ok: false, done: false, have: this.solvedCount, total: this.total }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const seq = view.getUint32(0)
    const total = view.getUint16(4)
    const msgLen = view.getUint32(6)
    const crc = view.getUint32(10)
    const payload = bytes.slice(HEADER_BYTES)
    if (total === 0 || msgLen === 0 || msgLen > MAX_MESSAGE_BYTES) {
      return { ok: false, done: false, have: this.solvedCount, total: this.total }
    }
    if (Math.ceil(msgLen / payload.length) !== total) {
      // Block size, msgLen and K must agree, or the sender and this decoder
      // are not talking about the same message shape.
      return { ok: false, done: false, have: this.solvedCount, total: this.total }
    }

    // A different (K, msgLen, crc) is a different message: start over. This is
    // also the corrupt-assembly recovery path — message() resets on a crc
    // mismatch, and the still-running sender re-fills this decoder.
    const key = `${total}:${msgLen}:${crc}`
    if (key !== this.key) this.reset(key, total, msgLen, crc)

    if (this.seen.has(seq)) return state()
    this.seen.add(seq)

    const indices = seq < total ? new Set([seq]) : new Set(blocksForPart(seq, total))
    this.ingest({ indices, payload })
    return state()
  }

  /** Peeling: reduce by what is solved; solve degree-1 remainders; cascade. */
  private ingest(part: PendingPart): void {
    for (const index of [...part.indices]) {
      const known = this.solved[index]
      if (known) {
        xorInto(part.payload, known)
        part.indices.delete(index)
      }
    }
    if (part.indices.size === 0) return // pure redundancy
    if (part.indices.size > 1) {
      this.pending.push(part)
      return
    }
    const [index] = part.indices
    if (this.solved[index]) return
    this.solved[index] = part.payload
    this.solvedCount++
    // Every pending part that referenced this block sheds it; re-ingest any
    // that became degree-1. Loop to a fixpoint — one solve can cascade.
    let progressed = true
    while (progressed) {
      progressed = false
      const still: PendingPart[] = []
      for (const p of this.pending) {
        for (const i of [...p.indices]) {
          const known = this.solved[i]
          if (known) {
            xorInto(p.payload, known)
            p.indices.delete(i)
          }
        }
        if (p.indices.size === 1) {
          const [i] = p.indices
          if (!this.solved[i]) {
            this.solved[i] = p.payload
            this.solvedCount++
            progressed = true
          }
        } else if (p.indices.size > 1) {
          still.push(p)
        }
      }
      this.pending = still
    }
  }

  /**
   * The assembled message once `accept` reported done — crc-checked. A
   * mismatch discards the assembly, resets the decoder, and returns null;
   * the sender is still looping, so collection simply continues.
   */
  message(): Uint8Array | null {
    if (this.total === 0 || this.solvedCount !== this.total) return null
    const blockBytes = this.solved[0]!.length
    const out = new Uint8Array(this.total * blockBytes)
    for (let i = 0; i < this.total; i++) out.set(this.solved[i]!, i * blockBytes)
    const trimmed = out.slice(0, this.msgLen)
    if (crc32(trimmed) !== this.crc) {
      this.reset('', 0, 0, 0)
      return null
    }
    return trimmed
  }
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx jest localpayFountain localpayCodec`
Expected: PASS. If the mixed-parts-only case fails to complete, print each accepted part's `blocksForPart(seq, K)` — with K=5 and seqs 5..19 the union must cover all five blocks with several degree-1 draws; a wrong float range in `open01`/`half01` shows up here first.

Run: `npx jest` — green. Prettier/eslint on touched files.

- [ ] **Step 6: Commit**

```bash
git add utils/localpay/fountain.ts utils/localpay/codec.ts __tests__/localpayFountain.test.ts __tests__/localpayCodec.test.ts
git commit -m "feat(pay): Luby-transform fountain codec for multipart payment QRs"
```

---

### Task 9: Session payload v2 — CAP_NEARBY and the OS field

**Files:**
- Modify: `utils/localpay/session.ts`
- Test: `__tests__/localpaySession.test.ts` (additions)

**Interfaces:**
- Consumes: nothing new.
- Produces: `CAP_NEARBY = 0x02`; `Session.os?: 'ios' | 'android'`; `mintSession` args gain `supportsNearby?: boolean; os?: 'ios' | 'android'`. Wire field `o: 'i' | 'a'`, omitted when unknown. **`SESSION_VERSION` stays 1.**

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/localpaySession.test.ts` (reuse the file's existing valid-mint helper/fixture args):

```ts
  it('mints CAP_NEARBY and the OS field, and round-trips them', () => {
    const s = mintSession({ ...validMintArgs, supportsAwdl: false, supportsNearby: true, os: 'android' })
    expect(s.caps & CAP_NEARBY).toBe(CAP_NEARBY)
    expect(s.caps & CAP_AWDL).toBe(0)
    const decoded = decodeSession(encodeSession(s))
    expect(decoded.caps).toBe(s.caps)
    expect(decoded.os).toBe('android')
  })

  it('omits the OS field when unknown and tolerates junk in it', () => {
    const s = mintSession({ ...validMintArgs, supportsAwdl: true })
    expect(encodeSession(s)).not.toContain('"o"')
    // A future build may send values this one does not know: they read as absent.
    const body = JSON.parse(new TextDecoder().decode(b64urlDecode(encodeSession({ ...s, os: 'ios' }).slice('bsvpay1:'.length))))
    body.o = 'z'
    const tampered = 'bsvpay1:' + b64urlEncode(new TextEncoder().encode(JSON.stringify(body)))
    expect(decodeSession(tampered).os).toBeUndefined()
  })

  it('a payload with unknown extra keys and unknown cap bits still decodes', () => {
    const s = mintSession({ ...validMintArgs, supportsAwdl: true })
    const body = JSON.parse(new TextDecoder().decode(b64urlDecode(encodeSession(s).slice('bsvpay1:'.length))))
    body.c = 0xff // future caps
    body.future = 'ignored'
    const wire = 'bsvpay1:' + b64urlEncode(new TextEncoder().encode(JSON.stringify(body)))
    const decoded = decodeSession(wire)
    expect(decoded.caps & CAP_AWDL).toBe(CAP_AWDL)
  })
```

(the suite already has base64url helpers or inline equivalents for its tamper tests — reuse them; if named differently, use those names.)

- [ ] **Step 2: Run to verify failure**

Run: `npx jest localpaySession` — FAIL.

- [ ] **Step 3: Implement**

In `utils/localpay/session.ts`:

```ts
export const CAP_AWDL = 0x01
export const CAP_NEARBY = 0x02

export type SessionOs = 'ios' | 'android'

export interface Session {
  ...
  /**
   * OS of the minting device. METADATA ONLY — copy and diagnostics. Transport
   * selection reads caps, which say what the device can DO; reading this
   * instead would break the moment either platform grows a second transport.
   */
  os?: SessionOs
}
```

`mintSession` args gain `supportsNearby?: boolean; os?: SessionOs`; the return builds
`caps: (args.supportsAwdl ? CAP_AWDL : 0) | (args.supportsNearby ? CAP_NEARBY : 0)` and spreads `...(args.os === undefined ? {} : { os: args.os })`.

`encodeSession` body gains `...(s.os === undefined ? {} : { o: s.os === 'ios' ? 'i' : 'a' })` (between `i` and `a` fields).

`decodeSession`: destructure `o` too; after the caps check add:

```ts
  // Tolerant on purpose: 'o' is advisory, from possibly-newer builds.
  const os: SessionOs | undefined = o === 'i' ? 'ios' : o === 'a' ? 'android' : undefined
```

and spread `...(os === undefined ? {} : { os })` into the returned object.

- [ ] **Step 4: Verify + commit**

Run: `npx jest localpaySession` then `npx jest` — green.

```bash
git add utils/localpay/session.ts __tests__/localpaySession.test.ts
git commit -m "feat(pay): session payload learns CAP_NEARBY and an advisory OS field"
```

---

### Task 10: The transport ladder and the shared socket wrapper

**Files:**
- Create: `utils/localpay/transport/socket.ts`, `utils/localpay/transport/nearby.ts`
- Modify: `utils/localpay/transport/select.ts`, `utils/localpay/transport/types.ts` (kind union), `utils/localpay/transport/awdl.ts` (becomes a re-export), `utils/pay/rails/nearby.ts` (barrel), `components/pay/NearbyFlow.tsx` (mint, listener, send branch, attribution)
- Test: `__tests__/localpayTransportSelect.test.ts` (ladder table), `__tests__/localpayTransportAwdl.test.ts` (import path only — behaviour identical)

**Interfaces:**
- Consumes: `CAP_AWDL`, `CAP_NEARBY` (Task 9); `getLocalPayTransport()` (unchanged — on Android it will return the Kotlin backend from Phase 3, null until then).
- Produces:
  - `type TransportKind = 'awdl' | 'nearby' | 'qr'` (from `select.ts`)
  - `selectTransport(session): TransportKind`
  - `localSupportsNearby(): boolean` — `Platform.OS === 'android'` ∧ native `isSupported()`; false until Phase 3 ships the backend (native is null on Android today), which keeps the ladder correct in the interim.
  - `makeSocketTransport(kind: 'awdl' | 'nearby'): LocalPaymentTransport` (from `socket.ts`) — the current awdl.ts body, verbatim, with `kind` parameterised.
  - `nearbyTransport`, `awdlTransport` — the two instances.

- [ ] **Step 1: Write the failing ladder tests**

In `__tests__/localpayTransportSelect.test.ts`, extend the existing suite (it already mocks `react-native` Platform and `react-native-localpay-transport` for `localSupportsAwdl`) with the full table:

```ts
  // caps × platform × native support → transport
  const CASES: [caps: number, platform: 'ios' | 'android', native: boolean, expected: string][] = [
    [CAP_AWDL, 'ios', true, 'awdl'],
    [CAP_AWDL, 'ios', false, 'qr'],
    [CAP_AWDL, 'android', true, 'qr'],            // AWDL cap useless off-iOS
    [CAP_NEARBY, 'android', true, 'nearby'],
    [CAP_NEARBY, 'android', false, 'qr'],
    [CAP_NEARBY, 'ios', true, 'qr'],              // Nearby cap useless on iOS
    [CAP_AWDL | CAP_NEARBY, 'ios', true, 'awdl'], // AWDL outranks Nearby
    [CAP_AWDL | CAP_NEARBY, 'android', true, 'nearby'],
    [0, 'ios', true, 'qr'],
    [0, 'android', true, 'qr']
  ]
```

and a `it.each(CASES)` that sets the Platform mock and the native `isSupported` mock per row, then asserts `selectTransport(sessionWithCaps(caps))`. Follow the file's existing mock plumbing exactly (same `jest.mock` targets, same session fixture builder).

- [ ] **Step 2: Run to verify failure** — `npx jest localpayTransportSelect` FAIL (`'nearby'` unreachable).

- [ ] **Step 3: The ladder**

Replace `utils/localpay/transport/select.ts`:

```ts
import { Platform } from 'react-native'
import { getLocalPayTransport } from 'react-native-localpay-transport'
import { CAP_AWDL, CAP_NEARBY, type Session } from '../session'

export type TransportKind = 'awdl' | 'nearby' | 'qr'

/** True when this device can act as an AWDL peer. */
export function localSupportsAwdl(): boolean {
  if (Platform.OS !== 'ios') return false
  try {
    return getLocalPayTransport()?.isSupported() ?? false
  } catch {
    return false
  }
}

/**
 * True when this device can act as a Nearby Connections peer. The same native
 * surface as AWDL, from the Kotlin backend: isSupported() there means Google
 * Play services is present. Runtime permissions are requested at flow entry,
 * not here — a denial degrades the mint/ladder to QR at that point.
 */
export function localSupportsNearby(): boolean {
  if (Platform.OS !== 'android') return false
  try {
    return getLocalPayTransport()?.isSupported() ?? false
  } catch {
    return false
  }
}

/**
 * The rung both sides can climb to. Caps say what the PEER advertised at mint
 * time; the local check says what THIS device can do. QR is the floor every
 * pair can reach — and the automatic fallback when a chosen radio fails at
 * send time (see NearbyFlow's executeSend).
 */
export function selectTransport(session: Session): TransportKind {
  if ((session.caps & CAP_AWDL) !== 0 && localSupportsAwdl()) return 'awdl'
  if ((session.caps & CAP_NEARBY) !== 0 && localSupportsNearby()) return 'nearby'
  return 'qr'
}
```

- [ ] **Step 4: The shared socket wrapper**

Create `utils/localpay/transport/socket.ts` containing the ENTIRE current body of `awdl.ts` (`utils/localpay/transport/awdl.ts:1-202` — `SEND_TIMEOUT_MS`, base64 helpers, `parseAck`, `makeConfirm`, `warnAckFailure`, `declineQuietly`, and the transport object) with exactly two changes:

1. the transport object literal moves inside a factory:

```ts
/**
 * The socketed transport wrapper, shared by both radio backends. The native
 * surface is identical on both platforms (one Nitro spec): iOS implements it
 * over AWDL/Network.framework, Android over Google Nearby Connections. Which
 * one getLocalPayTransport() returns is decided by the platform at build
 * time, so `kind` here is attribution, not dispatch.
 */
export function makeSocketTransport(kind: 'awdl' | 'nearby'): LocalPaymentTransport {
  return {
    kind,
    receive(session, signal) { ...unchanged body... },
    send(session, frame, signal) { ...unchanged body... }
  }
}
```

2. the two `'AWDL transport unavailable'` reject messages become `` `${kind} transport unavailable` ``.

Replace `utils/localpay/transport/awdl.ts` with:

```ts
import { makeSocketTransport } from './socket'

export const awdlTransport = makeSocketTransport('awdl')
```

Create `utils/localpay/transport/nearby.ts`:

```ts
import { makeSocketTransport } from './socket'

export const nearbyTransport = makeSocketTransport('nearby')
```

In `utils/localpay/transport/types.ts:64`, widen: `readonly kind: 'awdl' | 'nearby' | 'qr'`.

In `utils/pay/rails/nearby.ts`, add `localSupportsNearby`, `nearbyTransport`, `CAP_NEARBY`, and `type TransportKind` to the existing re-exports.

- [ ] **Step 5: NearbyFlow wiring**

In `components/pay/NearbyFlow.tsx` (import the new symbols from the rails barrel; add `Platform` to the `react-native` import):

- Next to the `supportsAwdl` memo (`:410`):

```ts
  const supportsNearby = useMemo(() => localSupportsNearby(), [])
  /** The radio this device listens on as payee, if any. */
  const radioTransport = useMemo(
    () => (supportsAwdl ? awdlTransport : supportsNearby ? nearbyTransport : null),
    [supportsAwdl, supportsNearby]
  )
```

- The payee listener effect (`:748-784`): replace `if (!supportsAwdl) return` with `if (!radioTransport) return`, replace `awdlTransport.receive(...)` with `radioTransport.receive(...)`, and swap `supportsAwdl` for `radioTransport` in the dep array.
- Attribution at `:639`: `await savePending(storage, frame, confirm ? (radioTransport?.kind ?? 'awdl') : 'qr')` — and add `radioTransport` to `settleReceived`'s dep array (`:733`).
- The mint (`:813-821`): pass the new args —

```ts
      const session = mintSession({
        identityKey,
        amount: sats,
        derivationPrefix,
        derivationSuffix,
        // Caps advertise what this payee can DO; the payer's ladder picks the
        // highest rung both sides share, QR being the floor.
        supportsAwdl,
        supportsNearby,
        os: Platform.OS === 'ios' ? 'ios' : 'android'
      })
```

- `executeSend`'s radio branch (`:1010-1012`): `const radio = sendKind === 'awdl' ? awdlTransport : nearbyTransport` above the try, and `ack = await radio.send(session, built.frame, controller.signal)`.
- The `sendKind === 'qr'` comparison and memo (`:888-891, :995`) need no change — `selectTransport` still returns `'qr'` for that branch, and the union widening is source-compatible.

- [ ] **Step 6: Verify + commit**

Run: `npx jest localpayTransportSelect localpayTransportAwdl payNearbyRail payRails` then `npx jest` — green. (The awdl transport suite's import target is unchanged; its behaviour tests now exercise `socket.ts` through it.)

```bash
git add utils/localpay/transport/ utils/pay/rails/nearby.ts components/pay/NearbyFlow.tsx __tests__/localpayTransportSelect.test.ts
git commit -m "feat(pay): three-rung transport ladder — AWDL, Nearby, QR floor"
```

---

### Task 11: Animated sender

**Files:**
- Create: `components/pay/PaymentQrDisplay.tsx`
- Modify: `components/pay/NearbyFlow.tsx` (qr branch of `executeSend`, send_qr render), `app/pay.tsx` (re-show modal), `context/i18n/translations.tsx`
- Test: none new (the codec is Task 8-tested; this is rendering). Device step in Task 17.

**Interfaces:**
- Consumes: `FountainEncoder`, `FOUNTAIN_FRAME_MS`, `MAX_MESSAGE_BYTES` (Task 8); `frameBytesFromQr`, `MAX_FRAME_QR_CHARS`, `encodeFrame` (codec, via the rails barrel — add `encodeFrame`, `frameBytesFromQr`, and the fountain exports to `utils/pay/rails/nearby.ts` in this task).
- Produces: `PaymentQrDisplay({ frameQr, size?, onError? })` — renders a `bsvpayf1:` payload statically when it fits a symbol, otherwise animates fountain parts. `NearbyFlow`'s `paymentQr` state now always holds the full `bsvpayf1:` string (never withheld for size — only the >64 KB sanity case still fails).

- [ ] **Step 1: The display component**

Create `components/pay/PaymentQrDisplay.tsx`:

```tsx
/**
 * One payment code, whatever its size. A frame that fits a single symbol
 * renders as today's static QR. A larger one animates: FountainEncoder parts
 * at 5/s, endlessly — the receiver needs any ~K distinct parts, so there is
 * no "start", no "end", and nothing to coordinate. The decision is made from
 * the payload alone so every caller (send screen, re-show modal) behaves
 * identically.
 */
import React, { useEffect, useMemo, useState } from 'react'
import QRCode from 'react-native-qrcode-svg'
import {
  FOUNTAIN_FRAME_MS,
  FountainEncoder,
  MAX_FRAME_QR_CHARS,
  frameBytesFromQr
} from '@/utils/pay/rails/nearby'

export default function PaymentQrDisplay({
  frameQr,
  size = 288,
  onError
}: {
  /** The full bsvpayf1: payload. */
  frameQr: string
  size?: number
  /** Backstop for the encoder throwing out of render — pass the screen's handler. */
  onError?: () => void
}) {
  const encoder = useMemo(() => {
    if (frameQr.length <= MAX_FRAME_QR_CHARS) return null
    try {
      return new FountainEncoder(frameBytesFromQr(frameQr))
    } catch {
      return null // >64 KB or malformed: let the static path hit onError
    }
  }, [frameQr])

  const [part, setPart] = useState<string | null>(null)

  useEffect(() => {
    if (!encoder) {
      setPart(null)
      return
    }
    let seq = 0
    setPart(encoder.partAt(0))
    const id = setInterval(() => {
      seq += 1
      setPart(encoder.partAt(seq))
    }, FOUNTAIN_FRAME_MS)
    return () => clearInterval(id)
  }, [encoder])

  const value = encoder ? part : frameQr
  if (!value) return null
  return <QRCode value={value} size={size} ecl="M" color="#000" backgroundColor="#fff" onError={onError} />
}
```

Add to `utils/pay/rails/nearby.ts` re-exports: `encodeFrame`, `frameBytesFromQr` (from the codec) and `FOUNTAIN_FRAME_MS`, `FOUNTAIN_QR_PREFIX`, `FountainDecoder`, `FountainEncoder`, `MAX_MESSAGE_BYTES` (from the fountain module).

- [ ] **Step 2: NearbyFlow sender**

In `components/pay/NearbyFlow.tsx`:

- `executeSend`: delete the `const qr = frameQrOrNull(built.frame)` line (`:993`) and replace the qr branch (as rewritten in Task 5) with:

```ts
      if (sendKind === 'qr') {
        // The fountain removes the symbol-size ceiling; the only refusal left
        // is the 64 KB sanity cap, past which QR handover is unreasonable and
        // something upstream is wrong.
        if (encodeFrame(built.frame).length > MAX_MESSAGE_BYTES) {
          abortBuild(built.reference)
          setPaymentQr(null)
          fail('generic', t('local_pay_too_large'))
          return
        }
        builtRef.current = built
        setPaymentQr(frameToQr(built.frame))
        setPhase('send_qr')
        return
      }
```

(The AWDL-catch branch still calls `frameQrOrNull` until Task 13 rewrites it; leave both in place this task.)

- send_qr render (`:1570-1583`): replace the inner `<QRCode .../>` with:

```tsx
                <PaymentQrDisplay frameQr={paymentQr} size={PAYMENT_QR_SIZE} onError={onPaymentQrError} />
```

(import `PaymentQrDisplay` from `@/components/pay/PaymentQrDisplay`; the `qrPlate` wrapper stays.)

and directly under the amount caption add the animated hint, shown only when animating:

```tsx
            {paymentQr.length > MAX_FRAME_QR_CHARS && (
              <Text style={[styles.support, { color: colors.textSecondary }]}>{t('local_pay_animated_hint')}</Text>
            )}
```

- [ ] **Step 3: Upgrade the re-show modal**

In `app/pay.tsx`, replace Task 6's modal body branch with:

```tsx
            {showCode?.framePayload ? (
              <PaymentQrDisplay frameQr={showCode.framePayload} size={288} />
            ) : null}
```

(remove the now-unused `QRCode` import and the `MAX_FRAME_QR_CHARS` import if nothing else uses them).

- [ ] **Step 4: Strings, six locales**

| key | en | zh | hi | es | fr | ar |
| --- | --- | --- | --- | --- | --- | --- |
| `local_pay_animated_hint` | Hold the screens together — the code animates until the other device has it all. | 请将两台设备屏幕对准——二维码会持续变化，直到对方接收完成。 | स्क्रीन आमने-सामने रखें — कोड तब तक बदलता रहेगा जब तक दूसरा डिवाइस पूरा प्राप्त न कर ले। | Mantén las pantallas enfrentadas: el código se anima hasta que el otro dispositivo lo reciba todo. | Gardez les écrans face à face — le code s'anime jusqu'à réception complète. | أبقِ الشاشتين متقابلتين — يتحرك الرمز حتى يستلم الجهاز الآخر كل البيانات. |

Also REPLACE `local_pay_too_large`'s copy in all six locales — the current text claims "Both devices need to be on iOS", which the fountain makes false:

| key | en | zh | hi | es | fr | ar |
| --- | --- | --- | --- | --- | --- | --- |
| `local_pay_too_large` | This payment's data is too large to hand over with QR codes. | 此付款数据过大，无法通过二维码传输。 | इस भुगतान का डेटा QR कोड से देने के लिए बहुत बड़ा है। | Los datos de este pago son demasiado grandes para entregarlos con códigos QR. | Les données de ce paiement sont trop volumineuses pour être transmises par code QR. | بيانات هذه الدفعة أكبر من أن تُنقل عبر رموز QR. |

- [ ] **Step 5: Verify + commit**

Run: `npx jest` — green (payScreen/payNearbyRail mount the changed components). Prettier/eslint on touched files.

```bash
git add components/pay/PaymentQrDisplay.tsx components/pay/NearbyFlow.tsx app/pay.tsx utils/pay/rails/nearby.ts context/i18n/translations.tsx
git commit -m "feat(pay): animated fountain QR replaces the too-large dead end"
```

---

### Task 12: Fountain receiver

**Files:**
- Modify: `components/QRScanner.tsx` (`continuous` prop), `components/pay/NearbyFlow.tsx` (`onFrameScanned`, scanner render `:1718-1726`, `openScanner`, `reset`), `context/i18n/translations.tsx`
- Test: fountain assembly is Task 8-tested; the scanner prop is exercised by `payScreen.test.tsx` mounting (type-level) plus the device step.

**Interfaces:**
- Consumes: `FountainDecoder`, `FOUNTAIN_QR_PREFIX` (rails barrel, Task 11); `decodeFrame` (add to the rails barrel re-exports).
- Produces: `QRScannerProps.continuous?: boolean` — when true, every recognised barcode is forwarded immediately: no 1,500 ms lock, no per-read haptic (5 reads/s would buzz continuously); the caller owns dedupe and completion.

- [ ] **Step 1: QRScanner continuous mode**

In `components/QRScanner.tsx`: add to props (after `multiScan`, `:27`):

```ts
  /**
   * Forward every recognised barcode immediately — no scan lock, no per-read
   * haptic. For animated multi-part codes (~5 reads/s): the lock would cap
   * assembly below 1 part/1.5 s, and per-read haptics would buzz constantly.
   * The caller owns dedupe and completion.
   */
  continuous?: boolean
```

and at the top of `handleBarCodeScanned` (`:57-59`):

```ts
      if (continuous) {
        if (stoppedRef.current) return
        onScan(data)
        return
      }
```

(destructure `continuous = false` in the component signature; add it to the `useCallback` deps.)

- [ ] **Step 2: NearbyFlow part assembly**

In `components/pay/NearbyFlow.tsx`:

- New refs/state near the others:

```ts
  const fountainDecoderRef = useRef<FountainDecoder | null>(null)
  const [scanProgress, setScanProgress] = useState<{ have: number; total: number } | null>(null)
```

- `openScanner` (`:440-443`) additionally clears them:

```ts
  const openScanner = useCallback((next: 'send_scan' | 'receive_scan') => {
    scanLatchRef.current = false
    fountainDecoderRef.current = null
    setScanProgress(null)
    setPhase(next)
  }, [])
```

(same two resets inside `reset()`.)

- `onFrameScanned` (`:832-854`) grows the part branch ahead of the existing logic:

```ts
  const onFrameScanned = useCallback(
    (data: string) => {
      // Animated-code parts arrive continuously and are handled statefully;
      // everything else keeps the one-shot latch semantics below.
      if (typeof data === 'string' && data.startsWith(FOUNTAIN_QR_PREFIX)) {
        if (scanLatchRef.current || settlingRef.current) return
        const session = hostedSession
        if (!session) return
        if (!fountainDecoderRef.current) fountainDecoderRef.current = new FountainDecoder()
        const s = fountainDecoderRef.current.accept(data)
        if (!s.ok) return
        setScanProgress({ have: s.have, total: s.total })
        if (!s.done) return
        const message = fountainDecoderRef.current.message()
        if (!message) return // crc mismatch: decoder reset itself, keep scanning
        fountainDecoderRef.current = null
        setScanProgress(null)
        scanLatchRef.current = true
        let frame: PaymentFrame
        try {
          frame = decodeFrame(message)
        } catch {
          fail('generic', t('invalid_qr_code'))
          return
        }
        void settleRef.current(frame, session)
        return
      }
      if (scanLatchRef.current) return
      scanLatchRef.current = true
      ... // existing single-QR body unchanged
```

(add `hostedSession` to the callback's deps if not already there — it is, at `:853`.)

- Scanner render (`:1718-1726`): pass the mode and the progress:

```tsx
        <QRScanner
          multiScan
          continuous={phase === 'receive_scan'}
          onScan={phase === 'send_scan' ? onSessionScanned : onFrameScanned}
          onClose={closeScanner}
          hintText={phase === 'send_scan' ? t('local_pay_scan_qr') : t('local_pay_scan_payer_qr')}
          renderBottom={
            phase === 'receive_scan' && scanProgress
              ? () => (
                  <Text style={{ color: 'rgba(255,255,255,0.8)', marginTop: 8 }}>
                    {t('local_pay_scan_progress', { have: scanProgress.have, total: scanProgress.total })}
                  </Text>
                )
              : undefined
          }
        />
```

- [ ] **Step 3: String, six locales**

| key | en | zh | hi | es | fr | ar |
| --- | --- | --- | --- | --- | --- | --- |
| `local_pay_scan_progress` | {{have}} of {{total}} pieces | 已接收 {{have}}/{{total}} 片段 | {{total}} में से {{have}} हिस्से | {{have}} de {{total}} fragmentos | {{have}} sur {{total}} fragments | {{have}} من {{total}} أجزاء |

- [ ] **Step 4: Verify + commit**

Run: `npx jest` — green. Prettier/eslint on the three touched files.

```bash
git add components/QRScanner.tsx components/pay/NearbyFlow.tsx utils/pay/rails/nearby.ts context/i18n/translations.tsx
git commit -m "feat(pay): continuous scanning assembles fountain parts with live progress"
```

---

### Task 13: Fast radio failure, automatic QR fallback

**Files:**
- Modify: `packages/react-native-localpay-transport/src/specs/LocalPayTransport.nitro.ts` (`sendFrame` signature), `packages/react-native-localpay-transport/ios/HybridLocalPayTransport.swift:357-429` (`sendFrame`), `utils/localpay/transport/socket.ts` (pass the new arg), `components/pay/NearbyFlow.tsx` (AWDL-catch branch), `context/i18n/translations.tsx`
- Test: `__tests__/localpayTransportAwdl.test.ts` (the native mock's `sendFrame` gains an arg — update arity assertions if any pin it)

**Interfaces:**
- Produces: `sendFrame(instanceName, pskBase64, frameBase64, timeoutMs, connectTimeoutMs): Promise<string>` — rejects with `"connect timeout: no route to peer"` when the connection is not `.ready` within `connectTimeoutMs`. `socket.ts` gains `CONNECT_TIMEOUT_MS = 4_000` alongside `SEND_TIMEOUT_MS = 20_000`.

Today an iOS payer with its Wi-Fi radio off sits the full 20 s send timeout and then lands on a *failure screen* with a manual "show QR instead" button. The connect phase is where "radios off" shows up, and it resolves in well under 4 s when it is going to resolve at all; the remaining 16 s budget still covers a slow payee save + ack.

- [ ] **Step 1: Widen the Nitro spec**

In `LocalPayTransport.nitro.ts:36-41`:

```ts
  sendFrame(
    instanceName: string,
    pskBase64: string,
    frameBase64: string,
    /** Whole-exchange budget: connect + transfer + the payee's save + ack. */
    timeoutMs: number,
    /**
     * Connect-phase budget. "Radios off" and "peer not there" both surface as
     * a connection that never reaches .ready; failing that fast is what lets
     * the UI fall back to the QR automatically instead of after 20 s.
     */
    connectTimeoutMs: number
  ): Promise<string>
```

- [ ] **Step 2: Regenerate the Nitro bindings**

Run, from `packages/react-native-localpay-transport/`: `npx nitrogen`
Expected: regenerated files under `nitrogen/generated/` (ios + shared); `git diff --stat` shows the Swift protocol gaining the parameter. Verify: `grep -rn "connectTimeoutMs" nitrogen/generated/ | head`. (Known gotcha from the AWDL branch: if nitrogen renames or relocates outputs, the podspec's source globs must still cover them — check `LocalPayTransport.podspec` includes the generated dirs, and do not hand-edit generated files.)

- [ ] **Step 3: Implement in Swift**

In `HybridLocalPayTransport.swift`, `sendFrame` (`:357`): add `connectTimeoutMs: Double` to the signature after `timeoutMs`, and insert a connect-deadline check. After the `settle` closure definition (`:390-399`) and alongside the existing whole-send timeout (`:401-404`), add:

```swift
    var becameReady = false
    queue.asyncAfter(deadline: .now() + .milliseconds(Int(connectTimeoutMs))) {
      // Same queue-confinement invariant as `settled` — see the comment above.
      if !becameReady {
        settle(.failure(NSError(domain: "LocalPayTransport", code: 14,
          userInfo: [NSLocalizedDescriptionKey: "connect timeout: no route to peer"])))
      }
    }
```

and in the state handler's `.ready` case (`:408`), first line: `becameReady = true`.

- [ ] **Step 4: Pass it from TS**

In `utils/localpay/transport/socket.ts`: add `const CONNECT_TIMEOUT_MS = 4_000` under `SEND_TIMEOUT_MS`, and extend the `native.sendFrame(...)` call with the fifth argument `CONNECT_TIMEOUT_MS`. Update any `sendFrame` mock signatures in `__tests__/localpayTransportAwdl.test.ts` to accept (and, where asserted, expect) five arguments.

- [ ] **Step 5: Auto-fallback in NearbyFlow**

Replace `executeSend`'s radio catch branch (`:1013-1028`, as it stands after Tasks 5/10/11) with:

```ts
      let ack: Ack
      try {
        ack = await radio.send(session, built.frame, controller.signal)
      } catch (e) {
        if (controller.signal.aborted) return
        // The radio path failed: connect timeout (radios off, peer gone),
        // Local Network denial, or a lost ack. The frame is signed and noSend,
        // so the QR still completes this payment — fall straight through to
        // the code instead of a failure screen. Deliberately NOT aborted: a
        // lost ack does not prove non-delivery, and Done's semantics
        // (broadcast-or-queue, re-showable) keep the already-delivered case
        // consistent — the payee's copy merges once this transaction is out.
        const message = messageOf(e)
        console.warn('[localpay] radio send failed, falling back to QR:', message)
        if (encodeFrame(built.frame).length > MAX_MESSAGE_BYTES) {
          // No radio and no representable code: the one genuinely dead end.
          fail(looksLikeLocalNetworkDenial(message) ? 'network' : 'generic', t('local_pay_too_large'))
          return
        }
        builtRef.current = built
        setPaymentQr(frameToQr(built.frame))
        setNotice({ text: t('local_pay_radio_fallback'), tone: 'info' })
        setPhase('send_qr')
        return
      }
```

Delete the now-unused `frameQrOrNull` helper (`:244-251`) — this was its last caller — and render the notice on the send_qr screen: after `{presenceBlock}` in the send_qr block, add

```tsx
            {!!notice && (
              <>
                <View style={styles.gapLg} />
                {noticeBlock(notice)}
              </>
            )}
```

- [ ] **Step 6: String, six locales**

| key | en | zh | hi | es | fr | ar |
| --- | --- | --- | --- | --- | --- | --- |
| `local_pay_radio_fallback` | Wireless link unavailable — show this code to the other device instead. | 无线连接不可用——请改为向对方出示此码。 | वायरलेस लिंक उपलब्ध नहीं — इसके बजाय यह कोड दूसरे डिवाइस को दिखाएँ। | Enlace inalámbrico no disponible: muestra este código al otro dispositivo. | Liaison sans fil indisponible — présentez plutôt ce code à l'autre appareil. | الاتصال اللاسلكي غير متاح — اعرض هذا الرمز على الجهاز الآخر بدلاً من ذلك. |

- [ ] **Step 7: Verify + commit**

Run: `npx jest` — green. Prettier/eslint on TS files touched. Swift compiles on the next EAS/prebuild run (no local compile harness — this is one of the Task 17 device items).

```bash
git add packages/react-native-localpay-transport components/pay/NearbyFlow.tsx utils/localpay/transport/socket.ts __tests__/localpayTransportAwdl.test.ts context/i18n/translations.tsx
git commit -m "feat(pay): 4s connect budget and automatic QR fallback when the radio path dies"
```

**Phase 2 exit criteria:** suite green; on two devices, a deliberately multi-input payment crosses iOS→Android and Android→iOS via the animated code with visible progress; an iOS payer with Wi-Fi off reaches the QR automatically in ~4 s.

---

# Phase 3 — Android Nearby Connections

A Kotlin backend for the existing Nitro spec. Everything above the native layer — `socket.ts`, ack semantics, the ladder, NearbyFlow — already works against it unchanged, because Phase 2 built against the shared surface. Native code has no jest harness: each task ends at a compile checkpoint, and behaviour lands on the Task 17 device matrix.

**Wire protocol over Nearby** (both tasks below implement exactly this): Nearby encrypts its link but knows nothing of our pairing, so the first payload each way binds the connection to the pairing QR. Every payload is one type byte followed by its body:

```
0x01 HELLO_A (payer→payee): HMAC-SHA256(psk, utf8(instanceName) ‖ 0x01)
0x02 HELLO_B (payee→payer): HMAC-SHA256(psk, utf8(instanceName) ‖ 0x02)
0x03 FRAME   (payer→payee): the encodeFrame bytes
0x04 ACK     (payee→payer): the ack JSON bytes ({"ok":true} / {"ok":false,"error":code})
```

A wrong or missing HELLO proof → disconnect; the payee keeps advertising. The role byte in the HMAC input prevents reflecting a proof back at its sender. serviceId is the fixed app-level `org.bsvblockchain.bsvbrowser.localpay`; per-session discrimination is the Bonjour-style `instanceName` (`bsvpay-<base32(sessionId)>`) carried as the advertised endpoint name. Strategy `P2P_POINT_TO_POINT`. `Payload.fromBytes` caps at 32 KB — a frame above that is rejected by `sendFrame` (the JS fallback then takes the fountain QR), which is acceptable: the radio exists for the common small-frame case.

### Task 14: Android scaffolding — the package compiles

**Files:**
- Modify: `packages/react-native-localpay-transport/src/specs/LocalPayTransport.nitro.ts:3`, `packages/react-native-localpay-transport/nitro.json`, `packages/react-native-localpay-transport/package.json`, `app.json` (permissions land in Task 16 — not here)
- Create: `packages/react-native-localpay-transport/android/build.gradle`, `packages/react-native-localpay-transport/android/src/main/AndroidManifest.xml`, `packages/react-native-localpay-transport/android/src/main/java/com/margelo/nitro/localpaytransport/HybridLocalPayTransport.kt` (skeleton)
- Test: compile checkpoint (gradle), plus `npx jest` stays green (JS surface unchanged).

**Interfaces:**
- Produces: an Android library module Nitro autolinks, whose `HybridLocalPayTransport` Kotlin class implements the generated spec with honest stubs: `isSupported()` returns false, everything else rejects `"not implemented"`. `getLocalPayTransport()` on Android then returns a real object whose `isSupported()` is false — identical ladder behaviour to today, so this ships safely mid-phase.

- [ ] **Step 1: Widen the spec to both platforms**

`LocalPayTransport.nitro.ts:3`:

```ts
export interface LocalPayTransport extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
```

`nitro.json` autolinking gains the android entry:

```json
  "autolinking": {
    "LocalPayTransport": {
      "ios": { "language": "swift", "implementationClassName": "HybridLocalPayTransport" },
      "android": { "language": "kotlin", "implementationClassName": "HybridLocalPayTransport" }
    }
  }
```

`package.json`: description drops "iOS only" (now "…for BSV Browser local payments. iOS (AWDL) + Android (Nearby Connections)."), and `files` gains `"android"`.

- [ ] **Step 2: Regenerate bindings**

Run from the package dir: `npx nitrogen`
Expected: `nitrogen/generated/android/` appears (Kotlin spec base class `HybridLocalPayTransportSpec` under `.../com/margelo/nitro/localpaytransport/`, JNI C++ glue, and a `LocalPayTransport+autolinking.gradle`). Verify: `ls nitrogen/generated/android` and `grep -rn "abstract class HybridLocalPayTransportSpec" nitrogen/generated/android | head -1`. Nitrogen's output naming is the authority for Step 4's imports — read the generated file header if anything below fails to resolve.

- [ ] **Step 3: The Android module**

Create `packages/react-native-localpay-transport/android/build.gradle`:

```groovy
apply plugin: 'com.android.library'
apply plugin: 'org.jetbrains.kotlin.android'

android {
  namespace 'com.margelo.nitro.localpaytransport'
  compileSdkVersion rootProject.hasProperty('compileSdkVersion') ? rootProject.compileSdkVersion : 35
  defaultConfig {
    minSdkVersion rootProject.hasProperty('minSdkVersion') ? rootProject.minSdkVersion : 24
  }
  compileOptions {
    sourceCompatibility JavaVersion.VERSION_17
    targetCompatibility JavaVersion.VERSION_17
  }
  kotlinOptions { jvmTarget = '17' }
}

dependencies {
  implementation 'com.google.android.gms:play-services-nearby:19.3.0'
  implementation project(':react-native-nitro-modules')
}

// Nitro's generated sources, CMake wiring, and package registration.
apply from: '../nitrogen/generated/android/LocalPayTransport+autolinking.gradle'
```

(If nitrogen emitted the autolinking gradle under a different name, `ls nitrogen/generated/android/*.gradle` and apply that file — never copy its contents by hand.)

Create `packages/react-native-localpay-transport/android/src/main/AndroidManifest.xml`:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <!-- Nearby Connections. SCAN/ADVERTISE/NEARBY_WIFI_DEVICES are declared
       neverForLocation: this transport identifies peers by a session-derived
       name, never by position. Legacy (≤ API 30) needs the location grants
       because the OS gated BT scans behind them. -->
  <uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />
  <uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />
  <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" android:maxSdkVersion="28" />
  <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" android:maxSdkVersion="30" />
  <uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
  <uses-permission android:name="android.permission.CHANGE_WIFI_STATE" />
  <uses-permission android:name="android.permission.BLUETOOTH_ADVERTISE" />
  <uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
  <uses-permission android:name="android.permission.BLUETOOTH_SCAN" android:usesPermissionFlags="neverForLocation" />
  <uses-permission android:name="android.permission.NEARBY_WIFI_DEVICES" android:usesPermissionFlags="neverForLocation" />
</manifest>
```

Create the skeleton `HybridLocalPayTransport.kt`:

```kotlin
package com.margelo.nitro.localpaytransport

import com.margelo.nitro.core.Promise

/**
 * Android backend of the LocalPayTransport Nitro spec, over Google Nearby
 * Connections. This skeleton keeps the module honest while Task 15 lands the
 * implementation: isSupported() = false makes the JS ladder treat this device
 * exactly as it does today (QR only).
 */
class HybridLocalPayTransport : HybridLocalPayTransportSpec() {
  override fun isSupported(): Boolean = false

  override fun startListening(
    instanceName: String,
    pskBase64: String,
    onFrame: (String) -> Unit,
    onError: (String) -> Unit
  ): Promise<Unit> = Promise.rejected(Error("not implemented"))

  override fun stopListening(): Promise<Unit> = Promise.resolved(Unit)

  override fun confirmFrame(accepted: Boolean, reason: String): Promise<Unit> =
    Promise.rejected(Error("not implemented"))

  override fun sendFrame(
    instanceName: String,
    pskBase64: String,
    frameBase64: String,
    timeoutMs: Double,
    connectTimeoutMs: Double
  ): Promise<String> = Promise.rejected(Error("not implemented"))
}
```

(The generated spec base class dictates the exact callback and Promise types — if the override signatures differ from nitrogen's output, nitrogen's output wins; adjust the overrides, not the generated code.)

- [ ] **Step 4: Compile checkpoint**

Run: `npx expo prebuild -p android --no-install` (regenerates `android/` autolinking so settings.gradle picks the module up), then `cd android && ./gradlew :react-native-localpay-transport:assembleDebug`
Expected: BUILD SUCCESSFUL. If the module name differs, `grep localpay android/settings.gradle` for the autolinked name. Then `npx jest` — green (JS unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/react-native-localpay-transport
git commit -m "feat(pay): Android module scaffolding for the localpay transport (honest stubs)"
```

---

### Task 15: The Nearby Connections implementation

**Files:**
- Modify: `packages/react-native-localpay-transport/android/src/main/java/com/margelo/nitro/localpaytransport/HybridLocalPayTransport.kt` (full implementation)
- Test: compile checkpoint; behaviour on the Task 17 device matrix. The TS layer above is already fully tested against mocks.

**Interfaces:**
- Consumes: the wire protocol at the top of this phase; `NitroModules.applicationContext` for the ConnectionsClient.
- Produces: the four spec methods with the exact same money-safety contract the Swift backend documents (`LocalPayTransport.nitro.ts:13-35`): delivery (`onFrame`) and acknowledgement (`confirmFrame`) are separate; a positive ack is sent only by JS after the durable write; `confirmFrame` with no held connection resolves and does nothing.

- [ ] **Step 1: Replace the skeleton**

```kotlin
package com.margelo.nitro.localpaytransport

import android.content.Context
import android.util.Base64
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.AdvertisingOptions
import com.google.android.gms.nearby.connection.ConnectionInfo
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback
import com.google.android.gms.nearby.connection.ConnectionResolution
import com.google.android.gms.nearby.connection.ConnectionsClient
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo
import com.google.android.gms.nearby.connection.DiscoveryOptions
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback
import com.google.android.gms.nearby.connection.Payload
import com.google.android.gms.nearby.connection.PayloadCallback
import com.google.android.gms.nearby.connection.PayloadTransferUpdate
import com.google.android.gms.nearby.connection.Strategy
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.Promise
import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import android.os.Handler
import android.os.Looper

/**
 * LocalPayTransport over Google Nearby Connections.
 *
 * Mirrors the Swift/AWDL backend's contract exactly (the JS wrapper in
 * utils/localpay/transport/socket.ts is shared): the payee listens
 * (advertises), the payer dials (discovers), one frame crosses, and the ack
 * that releases the payer's transaction travels back over the SAME connection
 * only when JS calls confirmFrame after its durable write.
 *
 * Nearby encrypts the link but knows nothing of our pairing, so the first
 * payload each way is an HMAC proof binding the connection to the pairing
 * QR's PSK — see the protocol table in the implementation plan. A failed
 * proof disconnects and, on the payee, keeps advertising: a stranger must not
 * be able to kill a live request by connecting to it.
 *
 * All mutable state is confined to the main-thread Handler: Nearby delivers
 * its callbacks on the main thread, and hopping everything we initiate onto
 * the same thread makes the state machine single-threaded by construction —
 * the same discipline the Swift side gets from its serial DispatchQueue.
 */
class HybridLocalPayTransport : HybridLocalPayTransportSpec() {
  private val main = Handler(Looper.getMainLooper())
  private val serviceId = "org.bsvblockchain.bsvbrowser.localpay"

  private fun client(): ConnectionsClient? {
    val context: Context = NitroModules.applicationContext ?: return null
    return Nearby.getConnectionsClient(context)
  }

  // ── crypto ──

  private fun hmac(psk: ByteArray, instanceName: String, role: Byte): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(psk, "HmacSHA256"))
    mac.update(instanceName.toByteArray(Charsets.UTF_8))
    mac.update(role)
    return mac.doFinal()
  }

  private fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean = MessageDigest.isEqual(a, b)

  // ── payee (listener) state ──

  private var listening = false
  private var listenPsk: ByteArray? = null
  private var listenName: String? = null
  private var listenOnFrame: ((String) -> Unit)? = null
  private var listenOnError: ((String) -> Unit)? = null
  /** Endpoint whose HELLO verified. Only its FRAME is deliverable. */
  private var boundEndpoint: String? = null
  /** Endpoint holding an undelivered ack — the payer confirmFrame answers. */
  private var pendingAckEndpoint: String? = null

  override fun isSupported(): Boolean {
    val context: Context = NitroModules.applicationContext ?: return false
    return GoogleApiAvailability.getInstance()
      .isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
  }

  private val payeePayloads = object : PayloadCallback() {
    override fun onPayloadReceived(endpointId: String, payload: Payload) {
      val bytes = payload.asBytes() ?: return
      if (bytes.isEmpty()) return
      val psk = listenPsk ?: return
      val name = listenName ?: return
      when (bytes[0]) {
        TYPE_HELLO_A -> {
          val proof = bytes.copyOfRange(1, bytes.size)
          if (!constantTimeEquals(proof, hmac(psk, name, ROLE_A))) {
            client()?.disconnectFromEndpoint(endpointId)
            return
          }
          boundEndpoint = endpointId
          val reply = byteArrayOf(TYPE_HELLO_B) + hmac(psk, name, ROLE_B)
          client()?.sendPayload(endpointId, Payload.fromBytes(reply))
        }
        TYPE_FRAME -> {
          if (endpointId != boundEndpoint) {
            client()?.disconnectFromEndpoint(endpointId)
            return
          }
          // First-success-wins, like the Swift listener: stop advertising and
          // hold this connection open for the ack JS will decide on.
          pendingAckEndpoint = endpointId
          client()?.stopAdvertising()
          val frame = bytes.copyOfRange(1, bytes.size)
          listenOnFrame?.invoke(Base64.encodeToString(frame, Base64.NO_WRAP))
        }
        else -> client()?.disconnectFromEndpoint(endpointId)
      }
    }

    override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {}
  }

  private val payeeLifecycle = object : ConnectionLifecycleCallback() {
    override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
      // Accept transport-level connections freely; trust is established by the
      // HELLO HMAC, not by Nearby's own auth digits (nobody is reading those
      // off a screen mid-payment).
      client()?.acceptConnection(endpointId, payeePayloads)
    }
    override fun onConnectionResult(endpointId: String, result: ConnectionResolution) {}
    override fun onDisconnected(endpointId: String) {
      if (endpointId == boundEndpoint && pendingAckEndpoint == null) boundEndpoint = null
    }
  }

  override fun startListening(
    instanceName: String,
    pskBase64: String,
    onFrame: (String) -> Unit,
    onError: (String) -> Unit
  ): Promise<Unit> {
    val promise = Promise<Unit>()
    main.post {
      val c = client()
      val psk = try { Base64.decode(pskBase64, Base64.DEFAULT) } catch (e: Exception) { null }
      if (c == null || psk == null) {
        promise.reject(Error("nearby unavailable or bad psk"))
        return@post
      }
      listening = true
      listenPsk = psk
      listenName = instanceName
      listenOnFrame = onFrame
      listenOnError = onError
      boundEndpoint = null
      pendingAckEndpoint = null
      c.startAdvertising(
        instanceName,
        serviceId,
        payeeLifecycle,
        AdvertisingOptions.Builder().setStrategy(Strategy.P2P_POINT_TO_POINT).build()
      )
        .addOnSuccessListener { promise.resolve(Unit) }
        .addOnFailureListener { e ->
          listening = false
          promise.reject(Error("advertising failed: ${e.message}"))
        }
    }
    return promise
  }

  override fun stopListening(): Promise<Unit> {
    val promise = Promise<Unit>()
    main.post {
      // Mirrors Swift stopListening: cancels advertising AND any held
      // connection — which is why the JS receive() path never calls it on the
      // success path (it would destroy the socket the ack must cross).
      client()?.stopAdvertising()
      client()?.stopAllEndpoints()
      listening = false
      boundEndpoint = null
      pendingAckEndpoint = null
      listenPsk = null
      listenName = null
      listenOnFrame = null
      listenOnError = null
      promise.resolve(Unit)
    }
    return promise
  }

  override fun confirmFrame(accepted: Boolean, reason: String): Promise<Unit> {
    val promise = Promise<Unit>()
    main.post {
      val endpoint = pendingAckEndpoint
      val c = client()
      if (endpoint == null || c == null) {
        // Idempotent and safe to call late, per the spec contract.
        promise.resolve(Unit)
        return@post
      }
      pendingAckEndpoint = null
      val json = if (accepted) "{\"ok\":true}"
      else "{\"ok\":false,\"error\":${jsonString(reason)}}"
      val payload = byteArrayOf(TYPE_ACK) + json.toByteArray(Charsets.UTF_8)
      c.sendPayload(endpoint, Payload.fromBytes(payload))
        .addOnSuccessListener {
          c.disconnectFromEndpoint(endpoint)
          promise.resolve(Unit)
        }
        .addOnFailureListener { e ->
          c.disconnectFromEndpoint(endpoint)
          promise.reject(Error("ack failed: ${e.message}"))
        }
    }
    return promise
  }

  // ── payer (dialer) ──

  override fun sendFrame(
    instanceName: String,
    pskBase64: String,
    frameBase64: String,
    timeoutMs: Double,
    connectTimeoutMs: Double
  ): Promise<String> {
    val promise = Promise<String>()
    main.post {
      val c = client()
      val psk = try { Base64.decode(pskBase64, Base64.DEFAULT) } catch (e: Exception) { null }
      val frame = try { Base64.decode(frameBase64, Base64.DEFAULT) } catch (e: Exception) { null }
      if (c == null || psk == null || frame == null) {
        promise.reject(Error("nearby unavailable or bad psk/frame"))
        return@post
      }
      if (frame.size + 1 > MAX_BYTES_PAYLOAD) {
        // Payload.fromBytes caps at 32 KB; the JS layer falls back to the
        // fountain QR on this rejection, which handles any size.
        promise.reject(Error("frame too large for a nearby payload"))
        return@post
      }

      var settled = false
      var ready = false
      var connectedEndpoint: String? = null
      fun settle(block: () -> Unit) {
        if (settled) return
        settled = true
        c.stopDiscovery()
        connectedEndpoint?.let { c.disconnectFromEndpoint(it) }
        block()
      }

      main.postDelayed({
        if (!ready) settle { promise.reject(Error("connect timeout: no route to peer")) }
      }, connectTimeoutMs.toLong())
      main.postDelayed({
        settle { promise.reject(Error("timed out waiting for peer")) }
      }, timeoutMs.toLong())

      val payloads = object : PayloadCallback() {
        override fun onPayloadReceived(endpointId: String, payload: Payload) {
          val bytes = payload.asBytes() ?: return
          if (bytes.isEmpty()) return
          when (bytes[0]) {
            TYPE_HELLO_B -> {
              val proof = bytes.copyOfRange(1, bytes.size)
              if (!constantTimeEquals(proof, hmac(psk, instanceName, ROLE_B))) {
                settle { promise.reject(Error("peer failed the session proof")) }
                return
              }
              ready = true
              c.sendPayload(endpointId, Payload.fromBytes(byteArrayOf(TYPE_FRAME) + frame))
            }
            TYPE_ACK -> {
              val ack = bytes.copyOfRange(1, bytes.size)
              settle { promise.resolve(Base64.encodeToString(ack, Base64.NO_WRAP)) }
            }
            else -> settle { promise.reject(Error("unexpected payload from peer")) }
          }
        }
        override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {}
      }

      val lifecycle = object : ConnectionLifecycleCallback() {
        override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
          c.acceptConnection(endpointId, payloads)
        }
        override fun onConnectionResult(endpointId: String, result: ConnectionResolution) {
          if (!result.status.isSuccess) {
            settle { promise.reject(Error("connection refused: ${result.status.statusMessage}")) }
            return
          }
          connectedEndpoint = endpointId
          c.stopDiscovery()
          c.sendPayload(
            endpointId,
            Payload.fromBytes(byteArrayOf(TYPE_HELLO_A) + hmac(psk, instanceName, ROLE_A))
          )
        }
        override fun onDisconnected(endpointId: String) {
          settle { promise.reject(Error("peer disconnected before acking")) }
        }
      }

      val discovery = object : EndpointDiscoveryCallback() {
        override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
          // Sessions are one-per-payment: only the endpoint advertising THIS
          // session's name is our payee. Anything else on the serviceId is a
          // different payment happening nearby.
          if (info.endpointName != instanceName) return
          c.requestConnection(instanceName, endpointId, lifecycle)
        }
        override fun onEndpointLost(endpointId: String) {}
      }

      c.startDiscovery(
        serviceId,
        discovery,
        DiscoveryOptions.Builder().setStrategy(Strategy.P2P_POINT_TO_POINT).build()
      ).addOnFailureListener { e ->
        settle { promise.reject(Error("discovery failed: ${e.message}")) }
      }
    }
    return promise
  }

  private fun jsonString(s: String): String =
    "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

  companion object {
    private const val TYPE_HELLO_A: Byte = 0x01
    private const val TYPE_HELLO_B: Byte = 0x02
    private const val TYPE_FRAME: Byte = 0x03
    private const val TYPE_ACK: Byte = 0x04
    private const val ROLE_A: Byte = 0x01
    private const val ROLE_B: Byte = 0x02
    private const val MAX_BYTES_PAYLOAD = 32768
  }
}
```

Listener error propagation: if `startAdvertising`'s failure happens after the promise resolved (rare — a later revocation), route it through `listenOnError`. The generated spec's callback types are the authority for the exact lambda signatures.

- [ ] **Step 2: Compile checkpoint**

Run: `cd android && ./gradlew :react-native-localpay-transport:assembleDebug`
Expected: BUILD SUCCESSFUL. Fix Kotlin signature mismatches against the generated spec only by adjusting this file.

- [ ] **Step 3: Commit**

```bash
git add packages/react-native-localpay-transport
git commit -m "feat(pay): Nearby Connections backend — advertise/discover, PSK-HMAC binding, socketed ack"
```

---

### Task 16: Permissions and capability wiring

**Files:**
- Create: `utils/localpay/transport/nearbyPermissions.ts`
- Modify: `app.json` (android permissions), `components/pay/NearbyFlow.tsx` (nearbyReady state), `utils/pay/rails/nearby.ts` (barrel)
- Test: `__tests__/localpayTransportSelect.test.ts` already covers the ladder; the permission helper gets its own small suite in the same file style if it contains branching (it does — API levels).

**Interfaces:**
- Produces: `requestNearbyPermissions(): Promise<boolean>` — requests the API-level-appropriate set, resolves true only when every needed grant landed; `NearbyFlow`'s `nearbyReady` boolean replaces raw `supportsNearby` in the mint and the `radioTransport` choice.

- [ ] **Step 1: app.json**

In the `android` block, add to (or create) `permissions`:

```json
      "permissions": [
        "android.permission.BLUETOOTH_ADVERTISE",
        "android.permission.BLUETOOTH_CONNECT",
        "android.permission.BLUETOOTH_SCAN",
        "android.permission.NEARBY_WIFI_DEVICES",
        "android.permission.ACCESS_FINE_LOCATION",
        "android.permission.ACCESS_WIFI_STATE",
        "android.permission.CHANGE_WIFI_STATE"
      ]
```

(the package manifest from Task 14 carries the maxSdkVersion/neverForLocation attributes; this list keeps expo prebuild from stripping them.)

- [ ] **Step 2: The runtime request helper**

Create `utils/localpay/transport/nearbyPermissions.ts`:

```ts
/**
 * The runtime grants Nearby Connections needs, by API level. Requested lazily
 * — on entering the nearby flow — never at app start: a user who only ever
 * pays over QR should never see a Bluetooth prompt. A denial is a soft
 * degrade to QR, not an error.
 */
import { PermissionsAndroid, Platform } from 'react-native'

export async function requestNearbyPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return false
  const api = typeof Platform.Version === 'number' ? Platform.Version : parseInt(String(Platform.Version), 10)
  const wanted: string[] =
    api >= 33
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES
        ]
      : api >= 31
        ? [
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
          ]
        : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION]
  try {
    const results = await PermissionsAndroid.requestMultiple(wanted as never)
    return wanted.every(p => results[p as keyof typeof results] === PermissionsAndroid.RESULTS.GRANTED)
  } catch {
    return false
  }
}
```

Add a small `describe('requestNearbyPermissions')` to `__tests__/localpayTransportSelect.test.ts` mocking `PermissionsAndroid.requestMultiple` for: all-granted → true; one denied → false; non-android → false without requesting. (Mock `Platform.Version` alongside the existing `Platform.OS` mock.)

- [ ] **Step 3: NearbyFlow gating**

In `components/pay/NearbyFlow.tsx`, replace the Task 10 `supportsNearby` memo with permission-gated state:

```ts
  /**
   * Nearby is usable only once BOTH hold: GMS is present (localSupportsNearby)
   * and the runtime grants landed. Resolved async on mount, Android only; a
   * denial leaves this false and the flow QR-only, silently — same posture as
   * a GMS-less device.
   */
  const [nearbyReady, setNearbyReady] = useState(false)
  useEffect(() => {
    if (Platform.OS !== 'android' || !localSupportsNearby()) return
    let live = true
    void requestNearbyPermissions().then(granted => {
      if (live) setNearbyReady(granted)
    })
    return () => {
      live = false
    }
  }, [])
```

and swap every `supportsNearby` read for `nearbyReady` (the `radioTransport` memo — which becomes a memo on `[supportsAwdl, nearbyReady]` — and the `mintSession` args). Add `requestNearbyPermissions` to the rails barrel and import from it.

The payer side needs no extra gate: its `selectTransport` rung already requires `localSupportsNearby()`, and `sendFrame`'s discovery fails fast into the Task 13 QR fallback if a grant is missing — but the mount-time request above runs for payers too (same screen), so in practice the grants exist before the first send.

- [ ] **Step 4: Verify + commit**

Run: `npx jest` — green. Prettier/eslint on touched TS files.

```bash
git add app.json utils/localpay/transport/nearbyPermissions.ts utils/pay/rails/nearby.ts components/pay/NearbyFlow.tsx __tests__/localpayTransportSelect.test.ts
git commit -m "feat(pay): lazy Nearby permission flow gating the CAP_NEARBY advertisement"
```

---

### Task 17: Device matrix, docs, closeout

**Files:**
- Modify: `docs/superpowers/specs/2026-07-29-offline-transport-fixes-design.md` (status line), this plan (check boxes)
- No code. Two physical iPhones + two physical Androids (Nearby does not work on emulators).

- [ ] **Step 1: Build** — EAS local builds for both platforms per the pipeline notes (`eas build --local`; iOS needs the Rust xcframework rebuilt after any fresh checkout — see `.easignore` notes in project memory).

- [ ] **Step 2: Run the matrix** (record outcomes inline here):

1. **iOS↔iOS AWDL regression** — pay both directions over AWDL; ack, celebration, broadcast as before.
2. **iOS payer, Wi-Fi radio off** → payment QR appears automatically within ~4 s, animated when the frame is large; Done queues; reconnect broadcasts within ~10 s.
3. **Android↔Android, airplane-mode-with-radios (Wi-Fi+BT on, no internet)** → Nearby end-to-end: pairing QR scan, radio frame, ack, payee "not yet broadcast", both queues drain on reconnect in dependency order.
4. **Android↔Android, GMS unavailable or permissions denied** → silent QR fountain fallback, payment completes.
5. **Android→iOS and iOS→Android, deliberately multi-input transaction** → fountain both directions: progress counter climbs, settle path identical to a static scan.
6. **Offline QR send, kill app after Done, relaunch** → "Show code again" re-renders (animated if large) from `framePayload`; payee scans and internalizes; both sides consistent after reconnect.
7. **Flaky-signal drain** — reconnect with weak signal so the first drain fails → backoff retries succeed unattended; "Send now" forces an immediate attempt; transactions screen badges move `Offline · queued` → gone without manual refresh.
8. **Stall visibility** — queue a row, delete its req in a debug build (or replay the known stall) → offline notice shows the stall detail instead of a silent forever-pending.

Additions from the execution reviews (2026-07-29, see the SDD ledger's per-task notes):

9. **First-run iOS payer, Local Network permission not yet granted** — the system prompt races the 4 s connect budget, so the first-ever nearby payment is expected to degrade to the QR even when the radio would work. Distinct row from radios-off; grant the permission and re-run to confirm AWDL then engages.
10. **Nearby bystander connect-and-idle** — a third Android device requests a connection to an advertising payee and goes silent: expect a silent disconnect at ~30 s, the listener SURVIVES, and no error surfaces. Then a HELLO-verified peer that stalls before its FRAME: expect the listener error path at ~30 s.
11. **Nearby mid-negotiation death premise** — the payer's connect budget expiring mid-negotiation assumes Nearby fires no `onConnectionResult`/`onDisconnected` for a never-established connection; watch the payee's logs during row 9/10 runs to confirm no reaper leaks or double-fires.
12. **Android payer with Nearby permissions denied** — expect a fast, automatic QR fallback with the "wireless link unavailable" notice, not a hang: the ladder consults GMS only, so the deny is discovered at dial time by design.

Additions from the frame-v2 / always-fountain encoding change (2026-07-30, see `docs/superpowers/specs/2026-07-30-nearby-payment-encoding-design.md`):

13. **iOS→Android and Android→iOS, ordinary single-input payment over QR** — the code is now an air-gap part rather than a `bsvpayf1:` symbol, and a one-block frame must render STILL (renderer holds `seq` at 0, no timer): confirm it does not flicker, scans on the first read, settles, and the figure on the receipt equals the amount sent. The receipt figure now comes from the transaction's output, not from a frame field, so a wrong number here is a derivation or output-index bug, not copy.
14. **Multi-input payment over QR** — fund a wallet with several small UTXOs, then send an amount needing 3+ inputs. This frame was refused before render prior to the change and has therefore NEVER run on a device: expect the code to animate, the progress counter to climb, and the scan to complete inside ~15 s at 1 KiB blocks.
15. **Old build pays new build (v1 frame)** — a payer on a pre-v2 build: expect the mismatch screen with the request still live and unspent, no double-credit, and no crash on either side. Rows 13–14 already cover the new-to-new path.
16. **Re-show after the change** — a `framePayload` written by a v2 build re-renders through "Show code again" as parts (still for one block, animated above it). A row written by a PRE-v2 build renders too but will be refused on scan; that is correct, its inputs are stale.

Additions from the Android registration fix (2026-07-31, see the SDD ledger's 2026-07-31 entries and `2026-07-29-offline-transport-fixes-design.md`'s Native module correction):

17. **First Android build after commits `84cd96e` + `0c75467`** — two independent, additive bugs, both required fixing before any Android device could reach the Nearby path: (a) the native module was compiling and autolinking all along but never actually loading (`JNI_OnLoad` was never wired up, so it never registered with Nitro); (b) separately, `.easignore`'s bare `android` rule had no negation for `packages/*/android`, so the module's entire Android source directory was silently stripped out of every EAS build archive since it was written — bug (a)'s fix could not have mattered in any binary actually built via `eas build`/one of the `android-*` npm scripts until (b) was also fixed. Confirm, on a build produced AFTER both commits, on the payee's very first entry into the flow: the "Allow BSV Browser to find nearby devices?" permission dialog now appears (it did not before, on any Android device or any EAS-built binary); the pairing QR payload decodes to `"c":2`; and a full Android↔Android payment completes end-to-end over the radio (not the QR floor) with Wi-Fi network off and both radios on. This is the row that actually validates rows 3/4/10/11/12 above rather than assuming a working native layer ever existed in a shipped build.

Not device-testable, unit-covered only (`__tests__/localpayVerify.test.ts`): a frame with correct nonces whose output pays a stranger. Nothing in the app builds one, so do not look for a row here.

- [ ] **Step 3: Close out** — set the spec's Status to "Implemented (device-validated)" with the date; note deviations discovered on device in the spec's own sections (the 2026-07-28 spec's correction style — say what changed and why); update project memory (`project_local_payments_awdl` / new entry) with what shipped.

---

## Self-review notes (writing-plans checklist, run 2026-07-29)

- **Spec coverage:** reconnect-broadcast → Tasks 1–3; QR-enqueue bug + Done semantics + framePayload → Tasks 4–5; send-now/stall/re-show → Task 6; badges → Task 7; fountain codec/sender/receiver → Tasks 8, 11, 12; session v2 → Task 9; ladder → Task 10; iOS auto-fallback + connect budget → Task 13; Android Nearby → Tasks 14–16; device matrix incl. all spec test items → Task 17. The spec's `txStatusVersion`-bump verification lands in Task 2; userId scoping in Task 7.
- **Type consistency:** `applyOutcome` returns `{sent, rejected, blocked}` (Tasks 3); `holdSentPaymentOffline({storage, txid, framePayload?})` (Tasks 4, 5); `sendFrame(...5 args)` (Tasks 13, 14, 15 all use the five-arg form); `TransportKind` from `select.ts` (Tasks 10, 11); `FountainDecoder.accept → {ok, done, have, total}` (Tasks 8, 12); `Session.os?: 'ios' | 'android'` with wire field `o: 'i' | 'a'` (Tasks 9, 10).
- **Known intentional deviations from current code comments:** Task 5 rewrites the send_qr Done comment (`NearbyFlow.tsx:1587-1595`) — the old "safer of the two failure modes" reasoning is superseded by re-showable persisted frames; Task 11 rewrites `local_pay_too_large` copy whose "both devices need iOS" claim the fountain falsifies; Task 13 removes `frameQrOrNull` entirely.
