# Offline Nearby Payments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let two devices with no internet complete a nearby payment, spend the received funds again while still offline, and have the whole accumulated chain of transactions broadcast in dependency order when either device regains signal.

**Architecture:** A local, checkpoint-anchored block-header store answers `chainTracker.isValidRootForHeight` with no network, which is the only thing BEEF verification needs. An override of `StorageProvider.attemptToPostReqsToNetwork` intercepts the one forced broadcast inside `internalizeAction`, parking the request at `nosend` (broadcast held) while the transaction stays `unproven` (outputs spendable), and recording it in a new `offline_actions` table. A monitor task, triggered on reconnect, walks each held request's stored BEEF, topologically orders every ancestor that lacks a merkle path, and posts them parent-first — cascading failure to descendants with an attribution note when the network rejects one.

**Tech Stack:** TypeScript, React Native / Expo 55, `@bsv/sdk` 2.1.9, `@bsv/wallet-toolbox-mobile` 2.4.3, `expo-sqlite`, `expo-file-system` 55, `@react-native-community/netinfo` 11.5.2, jest with `jest-expo`.

## Global Constraints

- **No `node_modules` patching for this feature.** Every seam used is a public, overridable method on `StorageProvider` or an injectable option. The repo does ship `patches/@bsv+wallet-toolbox-mobile+2.4.3.patch`; do not add to it.
- **Only `attemptToPostReqsToNetwork` as a *method* is intercepted.** `processAction.js:146` calls `storage.attemptToPostReqsToNetwork(...)`, so the override applies to the internalize and non-delayed create paths. `TaskSendWaiting.js:180` calls the *module function* directly, so the monitor's normal broadcast retries are deliberately unaffected. Never change that.
- **Spendability is governed by `transactions.status`, never by `proven_tx_reqs.status`** — verified at `storage/StorageExpoSQLite.ts:742` and `:1278`, and `storage/methods/listOutputsSql.ts:86`. An offline transaction is `transactions.status = 'unproven'` + `proven_tx_reqs.status = 'nosend'`.
- **Do not invent a new `proven_tx_reqs.status` value.** `nosend` is already ignored by `TaskSendWaiting`, `TaskCheckForProofs`, and `TaskFailAbandoned`, is barred from counting attempts by `TaskCheckNoSends`, and is listed in `readyToSendStatuses` (`storage/storageProviderHelpers.js:14`) so it stays releasable.
- **Nearby rail only.** Do not touch `components/pay/HandleSend.tsx`, `HandleReceive.tsx`, `AddressSend.tsx`, or `AddressReceive.tsx` beyond the offline disabling in Task 12.
- **SQL modules stay logic-free.** Every decision lives in a pure function unit-tested in `__tests__/`; the SQL layer is a thin mapper validated on device in Task 13. There is no SQLite test harness in this repo (`ls __tests__` — no storage tests exist) and this plan does not add one.
- **`online` means exactly** `isConnected === true && isInternetReachable !== false`. One implementation, in `utils/net/online.ts`.
- Tests run with `npx jest <pattern>`. Existing suite is 36 files (342 tests) at branch start; keep it green.
- **Never run `npm run fix` (or `npm run lint:fix`) in this work.** Measured on the branch base: `npx prettier --check .` reports only 4 drifting files, all pre-existing in `utils/webview/`, but `expo lint --fix` rewrites ~175 unrelated files. That buries a task's diff and makes review impossible. Check only the files you touched:
  `npx prettier --check <your files>` and `npx eslint <your files>`. A repo-wide formatting sweep is its own commit, not part of this feature.
- Header checkpoint constants are real values fetched 2026-07-28 and are reproduced verbatim in Task 2. Do not substitute placeholders.

---

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `utils/net/online.ts` | The single definition of "online": pure predicate, one-shot fetch, subscription. |
| `hooks/useOnline.ts` | React binding for the above. |
| `utils/headers/checkpoints.ts` | Per-chain trust anchors (height + hash), hardcoded. |
| `utils/headers/fs.ts` | `HeaderFs` interface + `expoHeaderFs()` + `memoryHeaderFs()` so the store is testable without native modules. |
| `utils/headers/headerStore.ts` | File-backed header window: validated append, in-memory merkle-root index, extra-root cache. |
| `utils/headers/syncHeaders.ts` | Chunked pull from a chaintracks client into the store. |
| `utils/headers/prewarm.ts` | Copy already-verified roots out of the local `proven_txs` table into the store. |
| `utils/headers/OfflineFirstChaintracks.ts` | `ChaintracksClientApi` that answers roots locally and delegates everything else. |
| `utils/offline/order.ts` | Pure release ordering and descendant discovery. |
| `utils/offline/plan.ts` | Pure release plan + outcome-to-mutations decisions. |
| `storage/methods/offlineActions.ts` | Thin SQL mapper for the `offline_actions` table. |
| `utils/monitor/TaskSendOffline.ts` | Manually triggered monitor task that drives the release. |
| `storage/methods/processOfflineActions.ts` | Imperative driver: post in order, apply outcomes, cascade. |
| `components/pay/OfflineNotice.tsx` | Offline banner plus the queued/rejected list. |

**Modified:**

| File | Change |
| --- | --- |
| `storage/schema/createTables.ts` | Add the `offline_actions` table. |
| `storage/StorageExpoSQLite.ts` | Override `attemptToPostReqsToNetwork`; add `holdReqsOffline`; expose the db to the offline modules. |
| `services/walletServiceConfig.ts` | Accept an injected chaintracks client. |
| `context/WalletContext.tsx` | Build the offline tracker, open + sync the store, pre-warm, register `TaskSendOffline`, re-point the three NetInfo sites. |
| `utils/localpay/build.ts` | `finalizeDelivery` enqueues instead of broadcasting when offline. |
| `utils/pay/rails/nearby.ts` | Re-export the offline enqueue helper. |
| `app/pay.tsx` | Disable non-nearby cells offline; render `OfflineNotice`. |
| `components/pay/PayCellRow.tsx` | Add a `disabled` prop. |
| `components/pay/ReceivedOverlay.tsx` | "not yet broadcast" state. |
| `context/i18n/translations.tsx` | New keys in all five locales. |

---

### Task 1: One definition of "online"

**Files:**
- Create: `utils/net/online.ts`, `hooks/useOnline.ts`
- Modify: `context/WalletContext.tsx:1244`, `:1268-1272`, `:1333-1338`
- Test: `__tests__/netOnline.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `isOnlineState(state: {isConnected: boolean | null; isInternetReachable: boolean | null}): boolean`, `getOnline(): Promise<boolean>`, `subscribeOnline(cb: (online: boolean) => void): () => void`, and `useOnline(): boolean`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/netOnline.test.ts`:

```ts
import { isOnlineState } from '@/utils/net/online'

describe('isOnlineState', () => {
  it('is online when connected and reachability is unknown', () => {
    expect(isOnlineState({ isConnected: true, isInternetReachable: null })).toBe(true)
  })

  it('is online when connected and reachable', () => {
    expect(isOnlineState({ isConnected: true, isInternetReachable: true })).toBe(true)
  })

  it('is offline when connected but explicitly unreachable', () => {
    expect(isOnlineState({ isConnected: true, isInternetReachable: false })).toBe(false)
  })

  it('is offline when not connected', () => {
    expect(isOnlineState({ isConnected: false, isInternetReachable: true })).toBe(false)
  })

  it('is offline when connectivity is unknown', () => {
    expect(isOnlineState({ isConnected: null, isInternetReachable: null })).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest netOnline`
Expected: FAIL — `Cannot find module '@/utils/net/online'`

- [ ] **Step 3: Write minimal implementation**

Create `utils/net/online.ts`:

```ts
/**
 * The single definition of "online" for the whole app.
 *
 * `isInternetReachable` is tri-state: NetInfo reports `null` while it has not
 * finished probing. Treating `null` as offline would make every cold start look
 * offline for a beat, so only an explicit `false` counts against us — which is
 * the same rule the three call sites this replaces already used.
 */
import NetInfo from '@react-native-community/netinfo'

export interface OnlineState {
  isConnected: boolean | null
  isInternetReachable: boolean | null
}

export function isOnlineState(state: OnlineState): boolean {
  return state.isConnected === true && state.isInternetReachable !== false
}

export async function getOnline(): Promise<boolean> {
  return isOnlineState(await NetInfo.fetch())
}

/** Returns the unsubscribe function. */
export function subscribeOnline(cb: (online: boolean) => void): () => void {
  return NetInfo.addEventListener(state => cb(isOnlineState(state)))
}
```

Create `hooks/useOnline.ts`:

```ts
import { useEffect, useState } from 'react'
import { getOnline, subscribeOnline } from '@/utils/net/online'

/**
 * Starts optimistic. A first render that wrongly says "online" costs a failed
 * request; a first render that wrongly says "offline" hides the online payment
 * rails from a user who has signal, which is worse.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true)
  useEffect(() => {
    let cancelled = false
    void getOnline().then(v => {
      if (!cancelled) setOnline(v)
    })
    const unsubscribe = subscribeOnline(v => {
      if (!cancelled) setOnline(v)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])
  return online
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest netOnline`
Expected: PASS, 5 tests

- [ ] **Step 5: Re-point the three existing NetInfo call sites**

In `context/WalletContext.tsx`, add `import { getOnline, isOnlineState, subscribeOnline } from '@/utils/net/online'`.

Replace the body at `:1244-1245`:

```ts
        if (!(await getOnline())) return
```

Replace the listener at `:1268-1272`:

```ts
    const unsubscribe = subscribeOnline(online => {
      if (online) tryProcess()
    })
```

Replace the listener at `:1333-1338`:

```ts
    const netUnsubscribe = subscribeOnline(next => {
      online = next
      // Coming back online is worth a pass now rather than at the next tick.
      if (online) void tick()
    })
```

Leave the `import NetInfo` line in place only if another reference survives; otherwise remove it. `isOnlineState` is imported for Task 10's use — if the linter flags it as unused now, add it in Task 10 instead.

- [ ] **Step 6: Verify nothing regressed**

Run: `npx jest` and `npm run fix`
Expected: all 37 test files pass; no lint errors.

- [ ] **Step 7: Commit**

```bash
git add utils/net/online.ts hooks/useOnline.ts __tests__/netOnline.test.ts context/WalletContext.tsx
git commit -m "refactor(net): one definition of online, replacing three copies"
```

---

### Task 2: Checkpoints and the header store

**Files:**
- Create: `utils/headers/checkpoints.ts`, `utils/headers/fs.ts`, `utils/headers/headerStore.ts`
- Test: `__tests__/headerStore.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `HeaderCheckpoint { height: number; hash: string }`, `HEADER_CHECKPOINTS: Record<'main' | 'test' | 'ttn', HeaderCheckpoint>`
  - `HeaderFs { readBytes(p): Promise<Uint8Array | undefined>; appendBytes(p, b): Promise<void>; readText(p): Promise<string | undefined>; writeText(p, t): Promise<void> }`, `expoHeaderFs(): HeaderFs`, `memoryHeaderFs(): HeaderFs`
  - `class HeaderStore` with `static open(fs, chain, anchor): Promise<HeaderStore>`, `tipHeight: number`, `tipHash: string`, `count: number`, `rootForHeight(h): string | undefined`, `append(bytes, firstHeight): Promise<number>`, `putExtraRoot(h, root): Promise<void>`

The checkpoint is the **last header trusted a priori**, so the first stored header sits at `anchor.height + 1` and must name `anchor.hash` as its previous hash.

- [ ] **Step 1: Write the failing test**

Create `__tests__/headerStore.test.ts`:

```ts
import { HeaderStore } from '@/utils/headers/headerStore'
import { memoryHeaderFs } from '@/utils/headers/fs'
import { Utils } from '@bsv/sdk'

// Two real consecutive ttn headers, heights 1 and 2, from
// GET /getHeaders?height=1&count=2 on the ttn chaintracks deployment. Verified:
// header 1's previousHash is TTN_ANCHOR.hash, header 2's previousHash is header
// 1's hash, and both declare bits 0x1d00ffff, which their hashes satisfy.
// 320 hex characters = 2 x 80 bytes. Keep each header on one line: a bad line
// split silently changes the fixture into a different, invalid chain.
const TTN_ANCHOR = { height: 0, hash: '000000000499eabba0a88f5b3747231c74b9191c1a4a04b2c2ea817976b7776d' }
// prettier-ignore
const TTN_1_AND_2 = '000000206d77b7767981eac2b2044a1a1c19b9741c2347375b8fa8a0bbea990400000000f824a7d1f9f896347f9b5272b0ba7db7af6934d02fa94ed9c8545b70e90e652e0dcaa468ffff001dd21635fa000000204bd109783c507e98b9da565c304e1313b085a54e0d4618ccf1e3d8b000000000fc8f1cc1c283eb968aea8d6217ce8e1868c4dd1bc90dc4afeeba622e21de176817caa468ffff001d05d356b3'

const bytes = () => new Uint8Array(Utils.toArray(TTN_1_AND_2, 'hex'))

describe('HeaderStore', () => {
  it('starts empty at the anchor', async () => {
    const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', TTN_ANCHOR)
    expect(store.count).toBe(0)
    expect(store.tipHeight).toBe(0)
    expect(store.tipHash).toBe(TTN_ANCHOR.hash)
    expect(store.rootForHeight(1)).toBeUndefined()
  })

  it('appends a chain that links to the anchor and indexes its roots', async () => {
    const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', TTN_ANCHOR)
    const added = await store.append(bytes(), 1)
    expect(added).toBe(2)
    expect(store.count).toBe(2)
    expect(store.tipHeight).toBe(2)
    // Display order, i.e. the on-wire 32 bytes reversed — which is what
    // findHeaderHexForHeight reports and what Beef.verify compares against.
    expect(store.rootForHeight(1)).toBe('2e650ee9705b54c8d94ea92fd03469afb77dbab072529b7f3496f8f9d1a724f8')
    expect(store.rootForHeight(2)).toBe('6817de212e62baeeafc40dc91bddc468188ece17628dea8a96eb83c2c11c8ffc')
  })

  it('refuses a chunk that does not link to the current tip', async () => {
    const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', { height: 0, hash: 'ff'.repeat(32) })
    await expect(store.append(bytes(), 1)).rejects.toThrow(/previous hash/i)
    expect(store.count).toBe(0)
  })

  it('refuses a chunk starting at the wrong height', async () => {
    const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', TTN_ANCHOR)
    await expect(store.append(bytes(), 5)).rejects.toThrow(/height/i)
  })

  it('refuses a buffer that is not a multiple of 80 bytes', async () => {
    const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', TTN_ANCHOR)
    await expect(store.append(bytes().subarray(0, 100), 1)).rejects.toThrow(/80/)
  })

  it('refuses a header whose hash does not meet its target', async () => {
    const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', TTN_ANCHOR)
    const b = bytes()
    // Tighten the difficulty of header 1 to an impossible target: bits live at
    // offset 72..76 of the 80-byte header.
    b[72] = 0x01
    b[73] = 0x00
    b[74] = 0x00
    b[75] = 0x00
    await expect(store.append(b, 1)).rejects.toThrow()
    expect(store.count).toBe(0)
  })

  it('reloads its index and tip from the filesystem', async () => {
    const fs = memoryHeaderFs()
    const first = await HeaderStore.open(fs, 'ttn', TTN_ANCHOR)
    await first.append(bytes(), 1)
    const second = await HeaderStore.open(fs, 'ttn', TTN_ANCHOR)
    expect(second.count).toBe(2)
    expect(second.tipHeight).toBe(2)
    expect(second.tipHash).toBe(first.tipHash)
    expect(second.rootForHeight(2)).toBe(first.rootForHeight(2))
  })

  it('discards a stored window whose anchor no longer matches', async () => {
    const fs = memoryHeaderFs()
    const first = await HeaderStore.open(fs, 'ttn', TTN_ANCHOR)
    await first.append(bytes(), 1)
    const moved = await HeaderStore.open(fs, 'ttn', { height: 10, hash: 'ab'.repeat(32) })
    expect(moved.count).toBe(0)
    expect(moved.tipHeight).toBe(10)
  })

  it('serves and persists extra roots below the window', async () => {
    const fs = memoryHeaderFs()
    const store = await HeaderStore.open(fs, 'ttn', TTN_ANCHOR)
    await store.putExtraRoot(7, 'aa'.repeat(32))
    expect(store.rootForHeight(7)).toBe('aa'.repeat(32))
    const reopened = await HeaderStore.open(fs, 'ttn', TTN_ANCHOR)
    expect(reopened.rootForHeight(7)).toBe('aa'.repeat(32))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest headerStore`
Expected: FAIL — `Cannot find module '@/utils/headers/headerStore'`

- [ ] **Step 3: Write the checkpoints**

Create `utils/headers/checkpoints.ts`:

```ts
/**
 * Trust anchors for the local header window.
 *
 * A checkpoint is the last header we trust WITHOUT having validated it, so the
 * window starts at `height + 1` and its first header must name `hash` as its
 * previous hash. Nothing enters the store unless it chains back to one of these
 * — which is what stops a compromised or wrong chaintracks deployment from
 * feeding us a merkle root we would then accept money against.
 *
 * Values fetched from the arcade chaintracks deployments on 2026-07-28.
 *
 *  · main — height 907,324, mined 2025-07-27, about one year and 52,560 blocks
 *    behind the 959,884 tip at the time of writing. One year of headers is
 *    ~4.2 MB. Bump this in a future release to prune.
 *  · test — height 1,697,402, about 52,560 blocks behind its 1,749,962 tip.
 *  · ttn — height 0. The whole teratest chain was 27,502 blocks (~2.2 MB), so
 *    windowing it buys nothing and starting from genesis costs nothing.
 */
export interface HeaderCheckpoint {
  /** Height of the last a-priori-trusted header. The window starts above it. */
  height: number
  /** Block hash in display order. */
  hash: string
}

export const HEADER_CHECKPOINTS: Record<'main' | 'test' | 'ttn', HeaderCheckpoint> = {
  main: {
    height: 907324,
    hash: '00000000000000000ccc802efeef429acb6b670a6b2bac373ece30f7d2df3e26'
  },
  test: {
    height: 1697402,
    hash: '0000000000ae922fff32ff94055b7b1c3963c6b5fd04e2b25f3c52d1708498e7'
  },
  ttn: {
    height: 0,
    hash: '000000000499eabba0a88f5b3747231c74b9191c1a4a04b2c2ea817976b7776d'
  }
}
```

- [ ] **Step 4: Write the filesystem seam**

Create `utils/headers/fs.ts`:

```ts
/**
 * The four filesystem operations the header store needs, behind an interface.
 *
 * expo-file-system's binary API is native-only, so the store would be
 * untestable in jest without this seam. It is deliberately tiny: no seeking, no
 * deletes, no directory walking.
 */
import { Directory, File, Paths } from 'expo-file-system'

export interface HeaderFs {
  readBytes(path: string): Promise<Uint8Array | undefined>
  appendBytes(path: string, bytes: Uint8Array): Promise<void>
  readText(path: string): Promise<string | undefined>
  writeText(path: string, text: string): Promise<void>
}

const HEADERS_DIR = 'headers'

export function expoHeaderFs(): HeaderFs {
  const dir = new Directory(Paths.document, HEADERS_DIR)
  const ensureDir = () => {
    if (!dir.exists) dir.create({ intermediates: true })
  }
  const file = (path: string) => new File(dir, path)
  return {
    async readBytes(path) {
      const f = file(path)
      return f.exists ? await f.bytes() : undefined
    },
    async appendBytes(path, bytes) {
      ensureDir()
      const f = file(path)
      if (!f.exists) f.create()
      f.write(bytes, { append: true })
    },
    async readText(path) {
      const f = file(path)
      return f.exists ? await f.text() : undefined
    },
    async writeText(path, text) {
      ensureDir()
      const f = file(path)
      if (!f.exists) f.create()
      f.write(text)
    }
  }
}

/** In-memory HeaderFs for tests. */
export function memoryHeaderFs(): HeaderFs {
  const files = new Map<string, Uint8Array>()
  const text = new Map<string, string>()
  return {
    async readBytes(path) {
      return files.get(path)
    },
    async appendBytes(path, bytes) {
      const existing = files.get(path)
      if (!existing) {
        files.set(path, bytes.slice())
        return
      }
      const next = new Uint8Array(existing.length + bytes.length)
      next.set(existing, 0)
      next.set(bytes, existing.length)
      files.set(path, next)
    },
    async readText(path) {
      return text.get(path)
    },
    async writeText(path, value) {
      text.set(path, value)
    }
  }
}
```

- [ ] **Step 5: Write the store**

Create `utils/headers/headerStore.ts`:

```ts
/**
 * A validated window of block headers, on disk, plus an in-memory merkle-root
 * index.
 *
 * WHY THIS EXISTS: `Beef.verify` needs exactly one thing — a merkle root for a
 * block height (@bsv/sdk Beef.js:702-707). Everything else about offline
 * payments follows from being able to answer that with no network.
 *
 * SHAPE: `<chain>.bin` holds contiguous 80-byte headers starting at
 * `anchor.height + 1`; `<chain>.json` holds the metadata; `<chain>-extra.json`
 * holds roots resolved below the window while online. On open, one pass over
 * the .bin builds a packed Uint8Array of 32-byte roots — ~1.7 MB for a year,
 * versus ~3.4 MB if they were kept as hex strings — so a lookup is an array
 * slice and a hex encode rather than file I/O.
 *
 * VALIDATION is a single pass per appended chunk: link each header to the
 * previous hash, hash it once, check that hash against the target its own bits
 * declare, and keep the root. Doing it here rather than calling the toolbox's
 * `validateBufferOfHeaders` avoids hashing every header twice, since that
 * helper checks linkage but not difficulty.
 */
import { Utils } from '@bsv/sdk'
import {
  blockHash,
  deserializeBaseBlockHeader,
  validateHeaderDifficulty
} from '@bsv/wallet-toolbox-mobile/out/src/services/chaintracker/chaintracks/util/blockHeaderUtilities'
import type { HeaderCheckpoint } from './checkpoints'
import type { HeaderFs } from './fs'

const HEADER_BYTES = 80
const ROOT_BYTES = 32

interface StoredMeta {
  chain: string
  anchorHeight: number
  anchorHash: string
  count: number
  tipHash: string
}

export class HeaderStore {
  private roots: Uint8Array
  private extra: Record<string, string>
  private constructor(
    private readonly fs: HeaderFs,
    readonly chain: string,
    readonly anchor: HeaderCheckpoint,
    private headerCount: number,
    private currentTipHash: string,
    roots: Uint8Array,
    extra: Record<string, string>
  ) {
    this.roots = roots
    this.extra = extra
  }

  private get binPath(): string {
    return `${this.chain}.bin`
  }
  private get metaPath(): string {
    return `${this.chain}.json`
  }
  private get extraPath(): string {
    return `${this.chain}-extra.json`
  }

  /** First height held by the window. */
  get baseHeight(): number {
    return this.anchor.height + 1
  }
  get count(): number {
    return this.headerCount
  }
  /** Highest validated height, or the anchor height when the window is empty. */
  get tipHeight(): number {
    return this.anchor.height + this.headerCount
  }
  /** Hash of the highest validated header, or the anchor hash when empty. */
  get tipHash(): string {
    return this.currentTipHash
  }

  static async open(fs: HeaderFs, chain: string, anchor: HeaderCheckpoint): Promise<HeaderStore> {
    const extraRaw = await fs.readText(`${chain}-extra.json`)
    let extra: Record<string, string> = {}
    if (extraRaw) {
      try {
        const parsed = JSON.parse(extraRaw) as unknown
        if (parsed && typeof parsed === 'object') extra = parsed as Record<string, string>
      } catch {
        // A corrupt cache of roots is a cache miss, never a load failure.
      }
    }

    const metaRaw = await fs.readText(`${chain}.json`)
    let meta: StoredMeta | undefined
    if (metaRaw) {
      try {
        meta = JSON.parse(metaRaw) as StoredMeta
      } catch {
        meta = undefined
      }
    }

    const empty = new HeaderStore(fs, chain, anchor, 0, anchor.hash, new Uint8Array(0), extra)

    // A shipped checkpoint that moved (app update) invalidates the window: its
    // first header no longer links to anything we trust. Start over rather than
    // keep headers we can no longer justify.
    if (
      !meta ||
      meta.chain !== chain ||
      meta.anchorHeight !== anchor.height ||
      meta.anchorHash !== anchor.hash ||
      meta.count <= 0
    ) {
      await empty.writeMeta()
      return empty
    }

    const bin = await fs.readBytes(`${chain}.bin`)
    if (!bin || bin.length < meta.count * HEADER_BYTES) {
      await empty.writeMeta()
      return empty
    }

    const roots = new Uint8Array(meta.count * ROOT_BYTES)
    for (let i = 0; i < meta.count; i++) {
      // Merkle root occupies bytes 36..68 of a header, little-endian on the
      // wire and display order reversed.
      const src = bin.subarray(i * HEADER_BYTES + 36, i * HEADER_BYTES + 68)
      const display = src.slice().reverse()
      roots.set(display, i * ROOT_BYTES)
    }
    return new HeaderStore(fs, chain, anchor, meta.count, meta.tipHash, roots, extra)
  }

  rootForHeight(height: number): string | undefined {
    const index = height - this.baseHeight
    if (index >= 0 && index < this.headerCount) {
      return Utils.toHex(Array.from(this.roots.subarray(index * ROOT_BYTES, (index + 1) * ROOT_BYTES)))
    }
    return this.extra[String(height)]
  }

  /**
   * Validates and appends a chunk. Returns the number of headers added.
   *
   * Throws without mutating anything if the chunk is misaligned, starts at the
   * wrong height, fails to link, or contains a header whose hash does not meet
   * its declared target.
   */
  async append(bytes: Uint8Array, firstHeight: number): Promise<number> {
    if (bytes.length === 0) return 0
    if (bytes.length % HEADER_BYTES !== 0) {
      throw new Error(`header chunk must be a multiple of 80 bytes, got ${bytes.length}`)
    }
    if (firstHeight !== this.tipHeight + 1) {
      throw new Error(`header chunk starts at height ${firstHeight}, expected ${this.tipHeight + 1}`)
    }

    const added = bytes.length / HEADER_BYTES
    const newRoots = new Uint8Array(added * ROOT_BYTES)
    let prev = this.currentTipHash

    for (let i = 0; i < added; i++) {
      const offset = i * HEADER_BYTES
      const header = bytes.slice(offset, offset + HEADER_BYTES)
      const parsed = deserializeBaseBlockHeader(bytes, offset)
      if (parsed.previousHash !== prev) {
        throw new Error(
          `header at height ${firstHeight + i} names previous hash ${parsed.previousHash}, expected ${prev}`
        )
      }
      const hash = blockHash(header)
      // Throws on failure — a header that does not meet its own target is not a
      // header, and accepting it would let anyone mint merkle roots.
      validateHeaderDifficulty(hash, parsed.bits)
      newRoots.set(new Uint8Array(Utils.toArray(parsed.merkleRoot, 'hex')), i * ROOT_BYTES)
      prev = hash
    }

    await this.fs.appendBytes(this.binPath, bytes)
    const merged = new Uint8Array(this.roots.length + newRoots.length)
    merged.set(this.roots, 0)
    merged.set(newRoots, this.roots.length)
    this.roots = merged
    this.headerCount += added
    this.currentTipHash = prev
    await this.writeMeta()
    return added
  }

  async putExtraRoot(height: number, root: string): Promise<void> {
    if (this.extra[String(height)] === root) return
    this.extra = { ...this.extra, [String(height)]: root }
    await this.fs.writeText(this.extraPath, JSON.stringify(this.extra))
  }

  private async writeMeta(): Promise<void> {
    const meta: StoredMeta = {
      chain: this.chain,
      anchorHeight: this.anchor.height,
      anchorHash: this.anchor.hash,
      count: this.headerCount,
      tipHash: this.currentTipHash
    }
    await this.fs.writeText(this.metaPath, JSON.stringify(meta))
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest headerStore`
Expected: PASS, 9 tests. If the "wrong target" test does not throw, print `deserializeBaseBlockHeader(b, 0).bits` and confirm the bits field was actually overwritten before changing production code.

- [ ] **Step 7: Commit**

```bash
git add utils/headers/checkpoints.ts utils/headers/fs.ts utils/headers/headerStore.ts __tests__/headerStore.test.ts
git commit -m "feat(headers): checkpoint-anchored header window with validated append"
```

---

### Task 3: Header sync

**Files:**
- Create: `utils/headers/syncHeaders.ts`
- Test: `__tests__/syncHeaders.test.ts`

**Interfaces:**
- Consumes: `HeaderStore` from Task 2.
- Produces: `syncHeaders(args: { store: HeaderStore; client: HeaderSource; chunkSize?: number; onProgress?: (tipHeight: number, presentHeight: number) => void; shouldStop?: () => boolean }): Promise<{ added: number; tipHeight: number; presentHeight: number }>` and `interface HeaderSource { getHeaders(height: number, count: number): Promise<string>; getPresentHeight(): Promise<number> }`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/syncHeaders.test.ts`:

```ts
import { syncHeaders } from '@/utils/headers/syncHeaders'
import { HeaderStore } from '@/utils/headers/headerStore'
import { memoryHeaderFs } from '@/utils/headers/fs'

// Same two verified ttn headers as __tests__/headerStore.test.ts, one per line.
const ANCHOR = { height: 0, hash: '000000000499eabba0a88f5b3747231c74b9191c1a4a04b2c2ea817976b7776d' }
// prettier-ignore
const H1 = '000000206d77b7767981eac2b2044a1a1c19b9741c2347375b8fa8a0bbea990400000000f824a7d1f9f896347f9b5272b0ba7db7af6934d02fa94ed9c8545b70e90e652e0dcaa468ffff001dd21635fa'
// prettier-ignore
const H2 = '000000204bd109783c507e98b9da565c304e1313b085a54e0d4618ccf1e3d8b000000000fc8f1cc1c283eb968aea8d6217ce8e1868c4dd1bc90dc4afeeba622e21de176817caa468ffff001d05d356b3'

const store = () => HeaderStore.open(memoryHeaderFs(), 'ttn', ANCHOR)

describe('syncHeaders', () => {
  it('pulls chunks until it reaches the present height', async () => {
    const calls: [number, number][] = []
    const client = {
      getPresentHeight: async () => 2,
      getHeaders: async (height: number, count: number) => {
        calls.push([height, count])
        return height === 1 ? H1 : H2
      }
    }
    const s = await store()
    const r = await syncHeaders({ store: s, client, chunkSize: 1 })
    expect(r.added).toBe(2)
    expect(r.tipHeight).toBe(2)
    expect(calls).toEqual([
      [1, 1],
      [2, 1]
    ])
  })

  it('does nothing when already at the tip', async () => {
    const client = { getPresentHeight: async () => 0, getHeaders: async () => '' }
    const s = await store()
    const r = await syncHeaders({ store: s, client })
    expect(r.added).toBe(0)
  })

  it('stops without error when the service returns no headers', async () => {
    const client = { getPresentHeight: async () => 500, getHeaders: async () => '' }
    const s = await store()
    const r = await syncHeaders({ store: s, client })
    expect(r.added).toBe(0)
    expect(r.tipHeight).toBe(0)
  })

  it('honours shouldStop between chunks', async () => {
    let served = 0
    const client = {
      getPresentHeight: async () => 2,
      getHeaders: async (height: number) => {
        served++
        return height === 1 ? H1 : H2
      }
    }
    const s = await store()
    const r = await syncHeaders({ store: s, client, chunkSize: 1, shouldStop: () => served >= 1 })
    expect(r.added).toBe(1)
    expect(served).toBe(1)
  })

  it('reports progress per chunk', async () => {
    const progress: number[] = []
    const client = {
      getPresentHeight: async () => 2,
      getHeaders: async (height: number) => (height === 1 ? H1 : H2)
    }
    const s = await store()
    await syncHeaders({ store: s, client, chunkSize: 1, onProgress: tip => progress.push(tip) })
    expect(progress).toEqual([1, 2])
  })

  it('propagates a validation failure rather than silently truncating', async () => {
    const client = { getPresentHeight: async () => 2, getHeaders: async () => H2 }
    const s = await store()
    await expect(syncHeaders({ store: s, client, chunkSize: 1 })).rejects.toThrow(/previous hash/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest syncHeaders`
Expected: FAIL — `Cannot find module '@/utils/headers/syncHeaders'`

- [ ] **Step 3: Write minimal implementation**

Create `utils/headers/syncHeaders.ts`:

```ts
/**
 * Pulls headers from a chaintracks deployment into the local window.
 *
 * `getHeaders(height, count)` returns hex of concatenated 80-byte headers and is
 * the only header source that works on every chain we ship — there is no bulk
 * header CDN for teratest. Verified against both deployments on 2026-07-28.
 *
 * The default chunk of 2,000 headers is 320 KB of response body: about 26
 * requests per year of mainnet headers, small enough that a dropped connection
 * costs almost nothing and progress moves visibly.
 */
import { Utils } from '@bsv/sdk'
import type { HeaderStore } from './headerStore'

export interface HeaderSource {
  getHeaders(height: number, count: number): Promise<string>
  getPresentHeight(): Promise<number>
}

export interface SyncHeadersResult {
  added: number
  tipHeight: number
  presentHeight: number
}

export async function syncHeaders(args: {
  store: HeaderStore
  client: HeaderSource
  chunkSize?: number
  onProgress?: (tipHeight: number, presentHeight: number) => void
  shouldStop?: () => boolean
}): Promise<SyncHeadersResult> {
  const { store, client, chunkSize = 2000, onProgress, shouldStop } = args
  const presentHeight = await client.getPresentHeight()
  let added = 0

  while (store.tipHeight < presentHeight) {
    if (shouldStop?.()) break
    const from = store.tipHeight + 1
    const want = Math.min(chunkSize, presentHeight - store.tipHeight)
    const hex = await client.getHeaders(from, want)
    if (!hex) break
    const bytes = new Uint8Array(Utils.toArray(hex, 'hex'))
    if (bytes.length === 0) break
    // A validation failure must propagate. A truncated-but-silent sync would
    // leave a window that looks complete and quietly refuses real payments.
    added += await store.append(bytes, from)
    onProgress?.(store.tipHeight, presentHeight)
  }

  return { added, tipHeight: store.tipHeight, presentHeight }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest syncHeaders`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add utils/headers/syncHeaders.ts __tests__/syncHeaders.test.ts
git commit -m "feat(headers): chunked, resumable sync from chaintracks getHeaders"
```

---

### Task 4: The offline-first chain tracker

**Files:**
- Create: `utils/headers/OfflineFirstChaintracks.ts`
- Test: `__tests__/offlineChaintracks.test.ts`

**Interfaces:**
- Consumes: `HeaderStore` from Task 2.
- Produces: `class OfflineFirstChaintracks` with `constructor(remote: ChaintracksClientApi, online: () => Promise<boolean>)`, `setStore(store: HeaderStore): void`, `lastMissHeight: number | undefined`, and the full `ChaintracksClientApi` surface.

- [ ] **Step 1: Write the failing test**

Create `__tests__/offlineChaintracks.test.ts`:

```ts
import { OfflineFirstChaintracks } from '@/utils/headers/OfflineFirstChaintracks'
import { HeaderStore } from '@/utils/headers/headerStore'
import { memoryHeaderFs } from '@/utils/headers/fs'

const ANCHOR = { height: 0, hash: '00'.repeat(32) }
const ROOT = 'ab'.repeat(32)

async function storeWithExtraRoot(height: number, root: string) {
  const s = await HeaderStore.open(memoryHeaderFs(), 'ttn', ANCHOR)
  await s.putExtraRoot(height, root)
  return s
}

function remote(overrides: Record<string, unknown> = {}) {
  return {
    findHeaderForHeight: jest.fn().mockResolvedValue({ merkleRoot: ROOT, height: 5 }),
    currentHeight: jest.fn().mockResolvedValue(999),
    isValidRootForHeight: jest.fn().mockResolvedValue(true),
    getChain: jest.fn().mockResolvedValue('ttn'),
    getHeaders: jest.fn().mockResolvedValue(''),
    getPresentHeight: jest.fn().mockResolvedValue(999),
    ...overrides
  } as never
}

describe('OfflineFirstChaintracks', () => {
  it('answers from the store without touching the network', async () => {
    const r = remote()
    const ct = new OfflineFirstChaintracks(r, async () => true)
    ct.setStore(await storeWithExtraRoot(5, ROOT))
    expect(await ct.isValidRootForHeight(ROOT, 5)).toBe(true)
    expect((r as never as { findHeaderForHeight: jest.Mock }).findHeaderForHeight).not.toHaveBeenCalled()
  })

  it('rejects a wrong root from the store without asking the network', async () => {
    const r = remote()
    const ct = new OfflineFirstChaintracks(r, async () => true)
    ct.setStore(await storeWithExtraRoot(5, ROOT))
    expect(await ct.isValidRootForHeight('cd'.repeat(32), 5)).toBe(false)
    expect((r as never as { findHeaderForHeight: jest.Mock }).findHeaderForHeight).not.toHaveBeenCalled()
  })

  it('falls back to the network on a miss while online and caches the root', async () => {
    const r = remote()
    const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', ANCHOR)
    const ct = new OfflineFirstChaintracks(r, async () => true)
    ct.setStore(store)
    expect(await ct.isValidRootForHeight(ROOT, 5)).toBe(true)
    expect(store.rootForHeight(5)).toBe(ROOT)
  })

  it('refuses on a miss while offline and records the missed height', async () => {
    const r = remote()
    const ct = new OfflineFirstChaintracks(r, async () => false)
    ct.setStore(await HeaderStore.open(memoryHeaderFs(), 'ttn', ANCHOR))
    expect(await ct.isValidRootForHeight(ROOT, 5)).toBe(false)
    expect(ct.lastMissHeight).toBe(5)
    expect((r as never as { findHeaderForHeight: jest.Mock }).findHeaderForHeight).not.toHaveBeenCalled()
  })

  it('refuses on a miss with no store at all', async () => {
    const ct = new OfflineFirstChaintracks(remote(), async () => false)
    expect(await ct.isValidRootForHeight(ROOT, 5)).toBe(false)
  })

  it('returns false rather than throwing when the network lookup fails', async () => {
    const r = remote({ findHeaderForHeight: jest.fn().mockRejectedValue(new Error('down')) })
    const ct = new OfflineFirstChaintracks(r, async () => true)
    ct.setStore(await HeaderStore.open(memoryHeaderFs(), 'ttn', ANCHOR))
    expect(await ct.isValidRootForHeight(ROOT, 5)).toBe(false)
  })

  it('reports the store tip as the current height while offline', async () => {
    const ct = new OfflineFirstChaintracks(remote(), async () => false)
    ct.setStore(await storeWithExtraRoot(5, ROOT))
    expect(await ct.currentHeight()).toBe(0)
  })

  it('reports the remote height while online', async () => {
    const ct = new OfflineFirstChaintracks(remote(), async () => true)
    expect(await ct.currentHeight()).toBe(999)
  })

  it('delegates everything else to the remote client', async () => {
    const r = remote()
    const ct = new OfflineFirstChaintracks(r, async () => true)
    expect(await ct.getChain()).toBe('ttn')
    expect((r as never as { getChain: jest.Mock }).getChain).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest offlineChaintracks`
Expected: FAIL — `Cannot find module '@/utils/headers/OfflineFirstChaintracks'`

- [ ] **Step 3: Write minimal implementation**

Create `utils/headers/OfflineFirstChaintracks.ts`:

```ts
/**
 * The chain tracker the wallet uses. Answers merkle roots from the local header
 * window first, the network second, and nothing at all when offline and the
 * height is outside the window.
 *
 * This is the single seam that makes offline payments possible: both BEEF
 * verification call sites — `signer/methods/internalizeAction.js:96` and
 * `storage/methods/createAction.js:495` — reach it through
 * `Services.getChainTracker()`, which wraps whatever sits in
 * `options.chaintracks` (`services/Services.js:149-154`).
 *
 * On a miss it calls `findHeaderForHeight` rather than the remote's own
 * `isValidRootForHeight`, because we want the root itself to cache — a coin
 * whose ancestry we resolved once should verify offline forever after.
 */
import type { ChaintracksClientApi } from '@bsv/wallet-toolbox-mobile/out/src/services/chaintracker/chaintracks/Api/ChaintracksClientApi'
import type { HeaderStore } from './headerStore'

export class OfflineFirstChaintracks implements ChaintracksClientApi {
  private store: HeaderStore | undefined
  /**
   * Height of the most recent root we could not resolve. The UI reads it to
   * explain a refusal ("this coin's history is older than the headers on this
   * device") instead of showing a bare verification failure.
   */
  lastMissHeight: number | undefined

  constructor(
    private readonly remote: ChaintracksClientApi,
    private readonly online: () => Promise<boolean>
  ) {}

  setStore(store: HeaderStore): void {
    this.store = store
  }

  async isValidRootForHeight(root: string, height: number): Promise<boolean> {
    const local = this.store?.rootForHeight(height)
    if (local !== undefined) return local === root

    if (!(await this.online())) {
      this.lastMissHeight = height
      return false
    }

    try {
      const header = await this.remote.findHeaderForHeight(height)
      if (!header) {
        this.lastMissHeight = height
        return false
      }
      const remoteRoot = String(header.merkleRoot)
      await this.store?.putExtraRoot(height, remoteRoot)
      return remoteRoot === root
    } catch {
      // A verification path must never throw a network error at the caller:
      // `Beef.verify` treats false as "not proven", which is the truth here.
      this.lastMissHeight = height
      return false
    }
  }

  async currentHeight(): Promise<number> {
    if (await this.online()) return await this.remote.currentHeight()
    return this.store?.tipHeight ?? 0
  }

  // ── Everything below is pure delegation ───────────────────────────────────
  getChain() {
    return this.remote.getChain()
  }
  getInfo() {
    return this.remote.getInfo()
  }
  getPresentHeight() {
    return this.remote.getPresentHeight()
  }
  getHeaders(height: number, count: number) {
    return this.remote.getHeaders(height, count)
  }
  findChainTipHeader() {
    return this.remote.findChainTipHeader()
  }
  findChainTipHash() {
    return this.remote.findChainTipHash()
  }
  findHeaderForHeight(height: number) {
    return this.remote.findHeaderForHeight(height)
  }
  findHeaderForBlockHash(hash: string) {
    return this.remote.findHeaderForBlockHash(hash)
  }
  addHeader(header: Parameters<ChaintracksClientApi['addHeader']>[0]) {
    return this.remote.addHeader(header)
  }
  startListening() {
    return this.remote.startListening()
  }
  listening() {
    return this.remote.listening()
  }
  isListening() {
    return this.remote.isListening()
  }
  isSynchronized() {
    return this.remote.isSynchronized()
  }
  subscribeHeaders(listener: Parameters<ChaintracksClientApi['subscribeHeaders']>[0]) {
    return this.remote.subscribeHeaders(listener)
  }
  subscribeReorgs(listener: Parameters<ChaintracksClientApi['subscribeReorgs']>[0]) {
    return this.remote.subscribeReorgs(listener)
  }
  unsubscribe(subscriptionId: string) {
    return this.remote.unsubscribe(subscriptionId)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest offlineChaintracks`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add utils/headers/OfflineFirstChaintracks.ts __tests__/offlineChaintracks.test.ts
git commit -m "feat(headers): offline-first chain tracker with root caching"
```

---

### Task 5: Wire the header store into the wallet

**Files:**
- Create: `utils/headers/prewarm.ts`
- Modify: `services/walletServiceConfig.ts:16-104`, `context/WalletContext.tsx` (wallet build, around `:640-700`)
- Test: `__tests__/headerPrewarm.test.ts`

**Interfaces:**
- Consumes: `HEADER_CHECKPOINTS`, `HeaderStore`, `expoHeaderFs`, `syncHeaders`, `OfflineFirstChaintracks`, `getOnline`.
- Produces: `prewarmOwnRoots(args: { rows: ProvenTxRootRow[]; store: HeaderStore }): Promise<number>` with `interface ProvenTxRootRow { height: number; merkleRoot: string }`; and `createServiceOptions(..., chaintracksOverride?: ChaintracksClientApi)`.

Pre-warm needs no network. `proven_txs` already stores `height` and `merkleRoot` for every transaction this wallet has a proof for, and those proofs were validated against chaintracks by `TaskCheckForProofs` before the row was written. Copying them into the store is a local move of already-verified data, and it covers exactly the coins this wallet is about to spend.

- [ ] **Step 1: Write the failing test**

Create `__tests__/headerPrewarm.test.ts`:

```ts
import { prewarmOwnRoots } from '@/utils/headers/prewarm'
import { HeaderStore } from '@/utils/headers/headerStore'
import { memoryHeaderFs } from '@/utils/headers/fs'

const ANCHOR = { height: 100, hash: '00'.repeat(32) }

describe('prewarmOwnRoots', () => {
  it('copies proven roots into the store', async () => {
    const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', ANCHOR)
    const added = await prewarmOwnRoots({
      rows: [
        { height: 7, merkleRoot: 'aa'.repeat(32) },
        { height: 9, merkleRoot: 'bb'.repeat(32) }
      ],
      store
    })
    expect(added).toBe(2)
    expect(store.rootForHeight(7)).toBe('aa'.repeat(32))
    expect(store.rootForHeight(9)).toBe('bb'.repeat(32))
  })

  it('skips rows already covered and malformed rows', async () => {
    const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', ANCHOR)
    await store.putExtraRoot(7, 'aa'.repeat(32))
    const added = await prewarmOwnRoots({
      rows: [
        { height: 7, merkleRoot: 'aa'.repeat(32) },
        { height: 0, merkleRoot: '' },
        { height: 8, merkleRoot: 'cc'.repeat(32) }
      ],
      store
    })
    expect(added).toBe(1)
    expect(store.rootForHeight(8)).toBe('cc'.repeat(32))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest headerPrewarm`
Expected: FAIL — `Cannot find module '@/utils/headers/prewarm'`

- [ ] **Step 3: Write minimal implementation**

Create `utils/headers/prewarm.ts`:

```ts
/**
 * Seeds the header store with roots this wallet has already had validated.
 *
 * `proven_txs` rows are written only after `TaskCheckForProofs` has confirmed
 * the proof against chaintracks, so their `merkleRoot` values are not the
 * server's unverified word — they are our own past verifications. Copying them
 * costs no network and covers exactly the heights a counterparty's BEEF will
 * reference, because our outputs become their inputs.
 */
import type { HeaderStore } from './headerStore'

export interface ProvenTxRootRow {
  height: number
  merkleRoot: string
}

export async function prewarmOwnRoots(args: { rows: ProvenTxRootRow[]; store: HeaderStore }): Promise<number> {
  const { rows, store } = args
  let added = 0
  for (const row of rows) {
    if (!Number.isInteger(row.height) || row.height <= 0) continue
    if (typeof row.merkleRoot !== 'string' || row.merkleRoot.length !== 64) continue
    if (store.rootForHeight(row.height) !== undefined) continue
    await store.putExtraRoot(row.height, row.merkleRoot)
    added++
  }
  return added
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest headerPrewarm`
Expected: PASS, 2 tests

- [ ] **Step 5: Let the service config accept an injected tracker**

In `services/walletServiceConfig.ts`, add the import and parameter. Each of the three network branches currently constructs its own `ChaintracksServiceClient`; keep that as the default and let a caller substitute a wrapper.

Add to the imports:

```ts
import type { ChaintracksClientApi } from '@bsv/wallet-toolbox-mobile/out/src/services/chaintracker/chaintracks/Api/ChaintracksClientApi'
```

Change the signature at `:16`:

```ts
export function createServiceOptions(
  network: AppChain,
  callbackToken: string,
  bsvExchangeRate: BsvExchangeRate,
  arcUrlOverride?: string,
  arcApiKeyOverride?: string,
  /**
   * Substitute for the plain remote chaintracks client. WalletContext passes an
   * OfflineFirstChaintracks wrapping the default, which is what makes BEEF
   * verification work with no network.
   */
  chaintracksOverride?: ChaintracksClientApi
): WalletServicesOptions {
```

In each of the three returned objects, replace `chaintracks: new ChaintracksServiceClient(...)` with:

```ts
      chaintracks:
        chaintracksOverride ??
        new ChaintracksServiceClient(
          walletChain,
          process.env?.EXPO_PUBLIC_CHAINTRACKS_URL ?? 'https://arcade-v2-us-1.bsvblockchain.tech/chaintracks/v1'
        )
```

(keeping each branch's own env var and URL — `EXPO_PUBLIC_TEST_CHAINTRACKS_URL` and `EXPO_PUBLIC_TERATEST_CHAINTRACKS_URL` respectively).

Then thread the parameter through `createServices` at `:94-104`:

```ts
export function createServices(
  network: AppChain,
  callbackToken: string,
  bsvExchangeRate: BsvExchangeRate,
  arcUrlOverride?: string,
  arcApiKeyOverride?: string,
  chaintracksOverride?: ChaintracksClientApi
): { services: Services; serviceOptions: WalletServicesOptions } {
  const serviceOptions = createServiceOptions(
    network,
    callbackToken,
    bsvExchangeRate,
    arcUrlOverride,
    arcApiKeyOverride,
    chaintracksOverride
  )
  const services = new Services(serviceOptions)
  return { services, serviceOptions }
}
```

- [ ] **Step 6: Build and inject the tracker in WalletContext**

In `context/WalletContext.tsx`, add imports:

```ts
import { HEADER_CHECKPOINTS } from '@/utils/headers/checkpoints'
import { expoHeaderFs } from '@/utils/headers/fs'
import { HeaderStore } from '@/utils/headers/headerStore'
import { OfflineFirstChaintracks } from '@/utils/headers/OfflineFirstChaintracks'
import { prewarmOwnRoots } from '@/utils/headers/prewarm'
import { syncHeaders } from '@/utils/headers/syncHeaders'
import { ChaintracksServiceClient } from '@bsv/wallet-toolbox-mobile'
```

Immediately before the `createServices(...)` call in `buildWallet` (currently at `:640`), construct the tracker:

```ts
        // The remote client the wrapper delegates to. Built here rather than
        // inside createServiceOptions so the same instance is both the fallback
        // for root misses and the source for header sync.
        const chaintracksUrl =
          selectedNetwork === 'main'
            ? (process.env?.EXPO_PUBLIC_CHAINTRACKS_URL ?? 'https://arcade-v2-us-1.bsvblockchain.tech/chaintracks/v1')
            : selectedNetwork === 'test'
              ? (process.env?.EXPO_PUBLIC_TEST_CHAINTRACKS_URL ??
                'https://arcade-v2-testnet-us-1.bsvblockchain.tech/chaintracks/v1')
              : (process.env?.EXPO_PUBLIC_TERATEST_CHAINTRACKS_URL ??
                'https://arcade-v2-ttn-us-1.bsvblockchain.tech/chaintracks/v1')
        const remoteChaintracks = new ChaintracksServiceClient(walletChain, chaintracksUrl)
        const offlineChaintracks = new OfflineFirstChaintracks(remoteChaintracks, getOnline)
        offlineChaintracksRef.current = offlineChaintracks
```

Add `const offlineChaintracksRef = useRef<OfflineFirstChaintracks | undefined>(undefined)` alongside the other refs in the provider, and pass the wrapper as the sixth argument to `createServices(...)`.

Also add the database accessor to `storage/StorageExpoSQLite.ts` now — Tasks 5, 9, 11, and 12 all need it, and widening `db` to public would let anything reach past the provider:

```ts
  /**
   * The raw database, for the offline-actions modules only. A narrow accessor
   * rather than a public `db`, so the surface stays deliberate.
   */
  get sqliteDb(): SQLiteDatabase | undefined {
    return this.db
  }
```

- [ ] **Step 7: Open, pre-warm, and sync the store in the background**

Still in `buildWallet`, after the monitor block and before `setManagers(...)`, add:

```ts
        // Header window: open, seed from our own validated proofs, then extend
        // to tip. All three steps are off the critical path — the wallet is
        // usable immediately, it just cannot verify offline until the first
        // sync finishes.
        InteractionManager.runAfterInteractions(() => {
          void (async () => {
            try {
              const anchor = HEADER_CHECKPOINTS[walletChain as 'main' | 'test' | 'ttn']
              if (!anchor) return
              const store = await HeaderStore.open(expoHeaderFs(), walletChain, anchor)
              offlineChaintracksRef.current?.setStore(store)

              const db = phoneStorage?.sqliteDb
              if (db) {
                const rows = (await db.getAllAsync(
                  'SELECT DISTINCT height, merkleRoot FROM proven_txs WHERE height > 0'
                )) as { height: number; merkleRoot: string }[]
                const warmed = await prewarmOwnRoots({ rows, store })
                logWithTimestamp(F, `Header prewarm: ${warmed} roots from proven_txs`)
              }

              if (await getOnline()) {
                const r = await syncHeaders({
                  store,
                  client: remoteChaintracks,
                  shouldStop: () => !offlineChaintracksRef.current
                })
                logWithTimestamp(F, `Header sync: +${r.added} to ${r.tipHeight}/${r.presentHeight}`)
              }
            } catch (e: any) {
              console.warn('[WalletContext] header store unavailable:', e?.message)
            }
          })()
        })
```

Add a reconnect-triggered top-up next to the existing `subscribeOnline` listener from Task 1's third call site:

```ts
  // Top the header window up whenever signal returns, so the next time we go
  // underground the window already reaches the tip.
  useEffect(() => {
    if (!walletBuilt) return
    return subscribeOnline(online => {
      if (!online) return
      const ct = offlineChaintracksRef.current
      if (!ct) return
      void (async () => {
        try {
          const anchor = HEADER_CHECKPOINTS[toWalletChain(selectedNetwork) as 'main' | 'test' | 'ttn']
          if (!anchor) return
          const store = await HeaderStore.open(expoHeaderFs(), toWalletChain(selectedNetwork), anchor)
          ct.setStore(store)
          await syncHeaders({ store, client: ct })
        } catch {
          // Best-effort. The next reconnect retries.
        }
      })()
    })
  }, [walletBuilt, selectedNetwork])
```

- [ ] **Step 8: Verify**

Run: `npx jest && npx tsc --noEmit && npm run fix`
Expected: all tests pass, no type errors, no lint errors. If `phoneStorage` is typed loosely enough that `sqliteDb` does not resolve, narrow its declared type to `StorageExpoSQLite | undefined` rather than casting.

- [ ] **Step 9: Commit**

```bash
git add utils/headers/prewarm.ts __tests__/headerPrewarm.test.ts services/walletServiceConfig.ts context/WalletContext.tsx storage/StorageExpoSQLite.ts
git commit -m "feat(headers): inject the offline tracker and sync the window in background"
```

---

### Task 6: The `offline_actions` table

**Files:**
- Modify: `storage/schema/createTables.ts` (append before the closing brace)
- Create: `storage/methods/offlineActions.ts`
- Test: none (SQL layer; validated on device in Task 13 — see Global Constraints)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type OfflineActionStatus = 'queued' | 'posting' | 'sent' | 'rejected'`
  - `type OfflineActionRole = 'received' | 'sent'`
  - `interface OfflineActionRow { offlineActionId: number; created_at: string; updated_at: string; userId: number; txid: string; seq: number; role: OfflineActionRole; senderIdentityKey: string | null; receivedVia: string | null; status: OfflineActionStatus; rejectedReason: string | null; poisonedByTxid: string | null }`
  - `interface OfflineDb { runAsync(sql: string, params?: unknown[]): Promise<unknown>; getAllAsync(sql: string, params?: unknown[]): Promise<unknown[]>; getFirstAsync(sql: string, params?: unknown[]): Promise<unknown> }`
  - `insertOfflineAction(db, entry): Promise<void>`, `findOfflineActions(db, filter): Promise<OfflineActionRow[]>`, `updateOfflineAction(db, txid, patch): Promise<void>`

- [ ] **Step 1: Add the table**

In `storage/schema/createTables.ts`, insert immediately before the closing `}` of `createTables`:

```ts
  // Offline actions — the broadcast queue and provenance record for
  // transactions accepted with no network. The money itself lives in the normal
  // transactions/outputs tables the whole time (that is what keeps it
  // spendable); this table records what still needs sending, in what order it
  // arrived, and who handed it to us.
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS offline_actions (
      offlineActionId INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      userId INTEGER NOT NULL,
      txid TEXT NOT NULL UNIQUE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      senderIdentityKey TEXT,
      receivedVia TEXT,
      status TEXT NOT NULL,
      rejectedReason TEXT,
      poisonedByTxid TEXT,
      FOREIGN KEY (userId) REFERENCES users(userId)
    );
    CREATE INDEX IF NOT EXISTS idx_offline_actions_status ON offline_actions(status);
    CREATE INDEX IF NOT EXISTS idx_offline_actions_userId ON offline_actions(userId);
    CREATE INDEX IF NOT EXISTS idx_offline_actions_seq ON offline_actions(seq);
  `)
```

- [ ] **Step 2: Write the mapper**

Create `storage/methods/offlineActions.ts`:

```ts
/**
 * Thin SQL mapper for `offline_actions`. Deliberately logic-free: every
 * decision about ordering, cascading, and status lives in
 * `utils/offline/order.ts` and `utils/offline/plan.ts`, which are unit-tested.
 * This file is validated on device.
 */
export type OfflineActionStatus = 'queued' | 'posting' | 'sent' | 'rejected'
export type OfflineActionRole = 'received' | 'sent'

export interface OfflineActionRow {
  offlineActionId: number
  created_at: string
  updated_at: string
  userId: number
  txid: string
  seq: number
  role: OfflineActionRole
  senderIdentityKey: string | null
  receivedVia: string | null
  status: OfflineActionStatus
  rejectedReason: string | null
  poisonedByTxid: string | null
}

/** Structurally satisfied by expo-sqlite's SQLiteDatabase. */
export interface OfflineDb {
  runAsync(sql: string, params?: unknown[]): Promise<unknown>
  getAllAsync(sql: string, params?: unknown[]): Promise<unknown[]>
  getFirstAsync(sql: string, params?: unknown[]): Promise<unknown>
}

export interface NewOfflineAction {
  userId: number
  txid: string
  role: OfflineActionRole
  senderIdentityKey?: string
  receivedVia?: string
}

/** Idempotent: a re-delivered frame must not create a second queue row. */
export async function insertOfflineAction(db: OfflineDb, entry: NewOfflineAction): Promise<void> {
  const now = new Date().toISOString()
  const seqRow = (await db.getFirstAsync('SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM offline_actions')) as {
    nextSeq: number
  } | null
  await db.runAsync(
    `INSERT OR IGNORE INTO offline_actions
       (created_at, updated_at, userId, txid, seq, role, senderIdentityKey, receivedVia, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
    [
      now,
      now,
      entry.userId,
      entry.txid,
      seqRow?.nextSeq ?? 1,
      entry.role,
      entry.senderIdentityKey ?? null,
      entry.receivedVia ?? null
    ]
  )
}

export async function findOfflineActions(
  db: OfflineDb,
  filter: { status?: OfflineActionStatus[]; userId?: number } = {}
): Promise<OfflineActionRow[]> {
  const where: string[] = []
  const params: unknown[] = []
  if (filter.status && filter.status.length > 0) {
    where.push(`status IN (${filter.status.map(() => '?').join(',')})`)
    params.push(...filter.status)
  }
  if (filter.userId !== undefined) {
    where.push('userId = ?')
    params.push(filter.userId)
  }
  const sql =
    'SELECT * FROM offline_actions' + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ' ORDER BY seq ASC'
  return (await db.getAllAsync(sql, params)) as OfflineActionRow[]
}

export async function updateOfflineAction(
  db: OfflineDb,
  txid: string,
  patch: { status?: OfflineActionStatus; rejectedReason?: string | null; poisonedByTxid?: string | null }
): Promise<void> {
  const sets: string[] = ['updated_at = ?']
  const params: unknown[] = [new Date().toISOString()]
  if (patch.status !== undefined) {
    sets.push('status = ?')
    params.push(patch.status)
  }
  if (patch.rejectedReason !== undefined) {
    sets.push('rejectedReason = ?')
    params.push(patch.rejectedReason)
  }
  if (patch.poisonedByTxid !== undefined) {
    sets.push('poisonedByTxid = ?')
    params.push(patch.poisonedByTxid)
  }
  params.push(txid)
  await db.runAsync(`UPDATE offline_actions SET ${sets.join(', ')} WHERE txid = ?`, params)
}
```

- [ ] **Step 3: Verify it compiles and nothing regressed**

Run: `npx tsc --noEmit && npx jest && npm run fix`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add storage/schema/createTables.ts storage/methods/offlineActions.ts
git commit -m "feat(offline): add the offline_actions table and its mapper"
```

---

### Task 7: Release ordering and cascade, as pure functions

**Files:**
- Create: `utils/offline/order.ts`
- Test: `__tests__/offlineOrder.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface OrderableTx { txid: string; hasProof: boolean; isTxidOnly: boolean; inputTxids: string[] }`, `releaseOrder(txs: OrderableTx[]): string[]`, `descendantsOf(txid: string, txs: OrderableTx[]): string[]`.

`OrderableTx` is exactly the shape `BeefTx` already presents, so the driver in Task 9 passes `beef.txs` straight in with no adapter and there is only one implementation of the ordering rule.

- [ ] **Step 1: Write the failing test**

Create `__tests__/offlineOrder.test.ts`:

```ts
import { descendantsOf, releaseOrder, type OrderableTx } from '@/utils/offline/order'

const tx = (txid: string, inputTxids: string[] = [], extra: Partial<OrderableTx> = {}): OrderableTx => ({
  txid,
  hasProof: false,
  isTxidOnly: false,
  inputTxids,
  ...extra
})

describe('releaseOrder', () => {
  it('puts a parent before its child', () => {
    const order = releaseOrder([tx('B', ['A']), tx('A')])
    expect(order).toEqual(['A', 'B'])
  })

  it('orders a three-deep chain regardless of input order', () => {
    const order = releaseOrder([tx('C', ['B']), tx('A'), tx('B', ['A'])])
    expect(order).toEqual(['A', 'B', 'C'])
  })

  it('excludes transactions that already have a proof', () => {
    const order = releaseOrder([tx('A', [], { hasProof: true }), tx('B', ['A'])])
    expect(order).toEqual(['B'])
  })

  it('excludes txid-only entries', () => {
    const order = releaseOrder([tx('A', [], { isTxidOnly: true }), tx('B', ['A'])])
    expect(order).toEqual(['B'])
  })

  it('ignores inputs that are not in the set', () => {
    const order = releaseOrder([tx('B', ['A', 'unknown'])])
    expect(order).toEqual(['B'])
  })

  it('keeps a stable order for independent transactions', () => {
    const order = releaseOrder([tx('X'), tx('Y'), tx('Z')])
    expect(order).toEqual(['X', 'Y', 'Z'])
  })

  it('handles a diamond', () => {
    const order = releaseOrder([tx('D', ['B', 'C']), tx('B', ['A']), tx('C', ['A']), tx('A')])
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('B'))
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('C'))
    expect(order.indexOf('B')).toBeLessThan(order.indexOf('D'))
    expect(order.indexOf('C')).toBeLessThan(order.indexOf('D'))
  })

  it('drops a cycle rather than looping forever', () => {
    const order = releaseOrder([tx('A', ['B']), tx('B', ['A'])])
    expect(order).toEqual([])
  })

  it('returns nothing for an empty set', () => {
    expect(releaseOrder([])).toEqual([])
  })
})

describe('descendantsOf', () => {
  it('finds direct and transitive children', () => {
    const txs = [tx('A'), tx('B', ['A']), tx('C', ['B']), tx('D')]
    expect(descendantsOf('A', txs).sort()).toEqual(['B', 'C'])
  })

  it('excludes the transaction itself', () => {
    expect(descendantsOf('A', [tx('A')])).toEqual([])
  })

  it('returns nothing for a leaf', () => {
    const txs = [tx('A'), tx('B', ['A'])]
    expect(descendantsOf('B', txs)).toEqual([])
  })

  it('does not loop on a cycle', () => {
    const txs = [tx('A', ['B']), tx('B', ['A'])]
    expect(descendantsOf('A', txs)).toEqual(['B'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest offlineOrder`
Expected: FAIL — `Cannot find module '@/utils/offline/order'`

- [ ] **Step 3: Write minimal implementation**

Create `utils/offline/order.ts`:

```ts
/**
 * The order in which held transactions may be released, and who dies with whom
 * when one is rejected.
 *
 * Pure on purpose. Ordering is the difference between a chain of offline
 * payments landing and a child being rejected as an orphan, so it gets
 * exhaustive unit tests rather than device-only confidence.
 *
 * `OrderableTx` is the shape `BeefTx` already has, so the driver passes
 * `beef.txs` in directly and there is exactly one ordering rule in the codebase.
 */
export interface OrderableTx {
  txid: string
  /** True once a merkle path is attached — already mined, nothing to send. */
  hasProof: boolean
  /** True for a bare txid reference with no transaction bytes. */
  isTxidOnly: boolean
  inputTxids: string[]
}

/**
 * Dependency order over the transactions that still need broadcasting.
 *
 * Mined and txid-only entries are excluded: the first needs nothing, the second
 * has nothing to send. Inputs outside the set are ignored — they are either
 * already on chain or someone else's problem, and in both cases they impose no
 * ordering on us. A cycle (impossible in real transactions, possible in
 * corrupt data) is dropped rather than allowed to spin.
 */
export function releaseOrder(txs: OrderableTx[]): string[] {
  const sendable = txs.filter(t => !t.hasProof && !t.isTxidOnly)
  const inSet = new Set(sendable.map(t => t.txid))
  const remaining = new Map(sendable.map(t => [t.txid, t]))
  const emitted = new Set<string>()
  const order: string[] = []

  // Insertion-ordered passes rather than recursion: the input order is the
  // arrival order, so independent transactions keep it and the result is stable.
  let progressed = true
  while (progressed && remaining.size > 0) {
    progressed = false
    for (const t of [...remaining.values()]) {
      const blocked = t.inputTxids.some(i => inSet.has(i) && !emitted.has(i))
      if (blocked) continue
      order.push(t.txid)
      emitted.add(t.txid)
      remaining.delete(t.txid)
      progressed = true
    }
  }
  return order
}

/**
 * Every transaction in the set that depends on `txid`, directly or through
 * other members. Used to cascade a rejection: if a parent is refused, no child
 * of it can ever be valid.
 */
export function descendantsOf(txid: string, txs: OrderableTx[]): string[] {
  const childrenOf = new Map<string, string[]>()
  for (const t of txs) {
    for (const input of t.inputTxids) {
      const list = childrenOf.get(input)
      if (list) list.push(t.txid)
      else childrenOf.set(input, [t.txid])
    }
  }
  const found = new Set<string>()
  const queue = [...(childrenOf.get(txid) ?? [])]
  while (queue.length > 0) {
    const next = queue.shift() as string
    if (next === txid || found.has(next)) continue
    found.add(next)
    queue.push(...(childrenOf.get(next) ?? []))
  }
  return [...found]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest offlineOrder`
Expected: PASS, 13 tests

- [ ] **Step 5: Commit**

```bash
git add utils/offline/order.ts __tests__/offlineOrder.test.ts
git commit -m "feat(offline): pure release ordering and descendant cascade"
```

---

### Task 8: Hold the forced broadcast

**Files:**
- Modify: `storage/StorageExpoSQLite.ts` (add `holdReqsOffline` and the `attemptToPostReqsToNetwork` override near the existing `internalizeAction` override at `:1345`)
- Create: `utils/offline/hold.ts`
- Test: `__tests__/offlineHold.test.ts`

**Interfaces:**
- Consumes: `insertOfflineAction`, `OfflineDb` (Task 6).
- Produces: `buildOfflineHoldResult(reqs: HeldReq[]): { status: 'success'; details: { txid: string; req: HeldReq; status: 'success' }[] }`, `interface HeldReq { txid: string }`, and `StorageExpoSQLite.holdReqsOffline(reqs: { txid: string }[], userId: number): Promise<void>`. The `sqliteDb` accessor was added in Task 5; do not add it again.

**Why this seam.** `internalizeAction` forces a synchronous broadcast for every unseen txid at `storage/methods/internalizeAction.js:536`, and offline that rolls the internalize back. The only thing that call reaches is `storage.attemptToPostReqsToNetwork(...)` (`storage/methods/processAction.js:146`) — a public method on `StorageProvider` (`StorageProvider.js:449`, `.d.ts:111`). Overriding it holds the broadcast without duplicating one line of the money logic above it. `TaskSendWaiting` calls the *module function* instead (`TaskSendWaiting.js:180`), so the monitor's ordinary retries are untouched.

The transaction row is already `unproven` at this point — `findOrInsertTargetTransaction` sets `provenTx != null ? 'completed' : 'unproven'` (`internalizeAction.js:352`) — so the outputs are spendable and only the request needs holding.

- [ ] **Step 1: Write the failing test**

Create `__tests__/offlineHold.test.ts`:

```ts
import { buildOfflineHoldResult } from '@/utils/offline/hold'

describe('buildOfflineHoldResult', () => {
  it('reports every held request as accepted for later delivery', () => {
    const reqs = [{ txid: 'aa' }, { txid: 'bb' }]
    const r = buildOfflineHoldResult(reqs)
    expect(r.status).toBe('success')
    expect(r.details.map(d => d.txid)).toEqual(['aa', 'bb'])
    expect(r.details.every(d => d.status === 'success')).toBe(true)
  })

  it('carries the request through so callers can inspect it', () => {
    const req = { txid: 'aa' }
    expect(buildOfflineHoldResult([req]).details[0].req).toBe(req)
  })

  it('handles an empty set', () => {
    expect(buildOfflineHoldResult([]).details).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest offlineHold`
Expected: FAIL — `Cannot find module '@/utils/offline/hold'`

- [ ] **Step 3: Write the result builder**

Create `utils/offline/hold.ts`:

```ts
/**
 * The result shape `shareReqsWithWorld` expects back from
 * `attemptToPostReqsToNetwork` when we have parked a request instead of
 * broadcasting it.
 *
 * `status: 'success'` here means "accepted for delivery", not "the network has
 * it". Nothing in the stored state claims otherwise: the request sits at
 * `nosend` rather than `unmined`, `wasBroadcast` stays false, and a row in
 * `offline_actions` records that it still needs sending. `aggregateActionResults`
 * maps this to a notDelayedResult of `success`
 * (`utility/aggregateResults.js:17-21`), which is what stops
 * `internalizeAction` from rolling back the payment it just verified.
 */
export interface HeldReq {
  txid: string
}

export function buildOfflineHoldResult<T extends HeldReq>(
  reqs: T[]
): { status: 'success'; details: { txid: string; req: T; status: 'success' }[] } {
  return {
    status: 'success',
    details: reqs.map(req => ({ txid: req.txid, req, status: 'success' as const }))
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest offlineHold`
Expected: PASS, 3 tests

- [ ] **Step 5: Add the override to the storage provider**

In `storage/StorageExpoSQLite.ts`, add imports:

```ts
import { Beef } from '@bsv/sdk'
import { insertOfflineAction } from './methods/offlineActions'
import { buildOfflineHoldResult } from '../utils/offline/hold'
import { getOnline } from '../utils/net/online'
```

Add the two new methods next to the existing `internalizeAction` override (the `sqliteDb` accessor already exists from Task 5):

```ts
  /**
   * Park requests for later delivery instead of broadcasting them now.
   *
   * Sets each request to 'nosend' — held, ignored by every monitor task, and
   * still releasable via `options.sendWith` because `readyToSendStatuses`
   * includes it (`storage/storageProviderHelpers.js:14`) — and records a row in
   * `offline_actions`. The transaction row is left alone: `internalizeAction`
   * has already set it to 'unproven', which is exactly what keeps the received
   * outputs spendable while the broadcast waits.
   *
   * Public and upstream-shaped: this is the method that becomes
   * `StorageProvider.holdReqsOffline` in wallet-toolbox.
   */
  async holdReqsOffline(reqs: { txid: string; id?: number }[], userId: number): Promise<void> {
    const db = this.getDB()
    for (const req of reqs) {
      const existing = await this.findProvenTxReqs({ partial: { txid: req.txid } })
      const row = existing[0]
      if (row) {
        await this.updateProvenTxReq(row.provenTxReqId, { status: 'nosend' })
      }
      await insertOfflineAction(db, { userId, txid: req.txid, role: 'received' })
    }
  }

  /**
   * Offline, hold instead of posting. Online, behave exactly as before.
   *
   * Reached only from `shareReqsWithWorld` (`storage/methods/processAction.js:146`),
   * which is the forced broadcast inside `internalizeAction` and the
   * non-delayed create path. `TaskSendWaiting` calls the module function
   * directly, so the monitor's retry behaviour is deliberately unchanged.
   */
  async attemptToPostReqsToNetwork(reqs: any[], trx?: TrxToken, logger?: any): Promise<any> {
    if (reqs.length > 0 && !(await getOnline())) {
      const userId = reqs[0]?.notify?.transactionIds?.length
        ? ((
            await this.findTransactions({
              partial: { transactionId: reqs[0].notify.transactionIds[0] },
              noRawTx: true
            })
          )[0]?.userId ?? 0)
        : 0
      devLog(`[StorageExpoSQLite] offline: holding ${reqs.length} req(s) for later delivery`)
      await this.holdReqsOffline(
        reqs.map(r => ({ txid: r.txid })),
        userId
      )
      return { ...buildOfflineHoldResult(reqs.map(r => ({ txid: r.txid }))), beef: new Beef(), log: '' }
    }
    return await super.attemptToPostReqsToNetwork(reqs, trx, logger)
  }
```

Note: `holdReqsOffline` takes the plain `{ txid }` shape rather than `EntityProvenTxReq` so it is callable from Task 11's payer path too.

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npx jest && npm run fix`
Expected: clean. If `super.attemptToPostReqsToNetwork` is not visible on the type, import `PostReqsToNetworkResult` from `@bsv/wallet-toolbox-mobile/out/src/storage/methods/attemptToPostReqsToNetwork` and use it as the return type instead of `any`.

- [ ] **Step 7: Commit**

```bash
git add utils/offline/hold.ts __tests__/offlineHold.test.ts storage/StorageExpoSQLite.ts
git commit -m "feat(offline): hold the forced internalize broadcast when offline"
```

---

### Task 9: The ordered release engine

**Files:**
- Create: `utils/offline/plan.ts`, `storage/methods/processOfflineActions.ts`
- Test: `__tests__/offlinePlan.test.ts`

**Interfaces:**
- Consumes: `releaseOrder`, `descendantsOf`, `OrderableTx` (Task 7); `OfflineActionRow`, `findOfflineActions`, `updateOfflineAction`, `OfflineDb` (Task 6).
- Produces:
  - `type PostOutcome = 'success' | 'serviceError' | 'invalidTx' | 'doubleSpend'`
  - `planRelease(args: { rows: OfflineActionRow[]; txs: OrderableTx[] }): { txid: string; owned: boolean }[]`
  - `applyOutcome(args: { txid: string; outcome: PostOutcome; txs: OrderableTx[]; rows: OfflineActionRow[] }): { stop: boolean; sent: string[]; rejected: { txid: string; reason: string; poisonedByTxid: string }[] }`
  - `processOfflineActions(args): Promise<{ sent: number; rejected: number; stopped: boolean }>`

- [ ] **Step 1: Write the failing test**

Create `__tests__/offlinePlan.test.ts`:

```ts
import { applyOutcome, planRelease } from '@/utils/offline/plan'
import type { OrderableTx } from '@/utils/offline/order'
import type { OfflineActionRow } from '@/storage/methods/offlineActions'

const tx = (txid: string, inputTxids: string[] = [], extra: Partial<OrderableTx> = {}): OrderableTx => ({
  txid,
  hasProof: false,
  isTxidOnly: false,
  inputTxids,
  ...extra
})

const row = (txid: string, over: Partial<OfflineActionRow> = {}): OfflineActionRow => ({
  offlineActionId: 1,
  created_at: '2026-07-28T00:00:00.000Z',
  updated_at: '2026-07-28T00:00:00.000Z',
  userId: 1,
  txid,
  seq: 1,
  role: 'received',
  senderIdentityKey: '02'.padEnd(66, 'c'),
  receivedVia: 'awdl',
  status: 'queued',
  rejectedReason: null,
  poisonedByTxid: null,
  ...over
})

describe('planRelease', () => {
  it('orders parents first and marks which transactions we own', () => {
    const plan = planRelease({ rows: [row('B')], txs: [tx('B', ['A']), tx('A')] })
    expect(plan).toEqual([
      { txid: 'A', owned: false },
      { txid: 'B', owned: true }
    ])
  })

  it('includes a foreign ancestor that was never in the queue', () => {
    // C paid B underground, B pays us: C's transaction is in our BEEF but was
    // never our queue row, and it must still go out first.
    const plan = planRelease({ rows: [row('A')], txs: [tx('A', ['B']), tx('B', ['C']), tx('C')] })
    expect(plan.map(p => p.txid)).toEqual(['C', 'B', 'A'])
    expect(plan.map(p => p.owned)).toEqual([false, false, true])
  })

  it('skips already-sent rows', () => {
    const plan = planRelease({ rows: [row('A', { status: 'sent' })], txs: [tx('A')] })
    expect(plan.map(p => p.txid)).toEqual(['A'])
    expect(plan[0].owned).toBe(false)
  })

  it('excludes mined transactions', () => {
    const plan = planRelease({ rows: [row('B')], txs: [tx('A', [], { hasProof: true }), tx('B', ['A'])] })
    expect(plan.map(p => p.txid)).toEqual(['B'])
  })
})

describe('applyOutcome', () => {
  it('marks a success sent and keeps going', () => {
    const r = applyOutcome({ txid: 'A', outcome: 'success', txs: [tx('A')], rows: [row('A')] })
    expect(r).toEqual({ stop: false, sent: ['A'], rejected: [] })
  })

  it('stops the run on a service error without rejecting anything', () => {
    const r = applyOutcome({ txid: 'A', outcome: 'serviceError', txs: [tx('A')], rows: [row('A')] })
    expect(r.stop).toBe(true)
    expect(r.sent).toEqual([])
    expect(r.rejected).toEqual([])
  })

  it('rejects the transaction and every descendant on invalidTx', () => {
    const txs = [tx('A'), tx('B', ['A']), tx('C', ['B'])]
    const r = applyOutcome({ txid: 'A', outcome: 'invalidTx', txs, rows: [row('A'), row('B'), row('C')] })
    expect(r.stop).toBe(true)
    expect(r.rejected.map(x => x.txid).sort()).toEqual(['A', 'B', 'C'])
    expect(r.rejected.every(x => x.poisonedByTxid === 'A')).toBe(true)
  })

  it('names the reason on a double spend', () => {
    const r = applyOutcome({ txid: 'A', outcome: 'doubleSpend', txs: [tx('A')], rows: [row('A')] })
    expect(r.rejected[0].reason).toMatch(/double spend/i)
  })

  it('rejects descendants that have no queue row of their own', () => {
    const txs = [tx('A'), tx('B', ['A'])]
    const r = applyOutcome({ txid: 'A', outcome: 'invalidTx', txs, rows: [row('A')] })
    expect(r.rejected.map(x => x.txid).sort()).toEqual(['A', 'B'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest offlinePlan`
Expected: FAIL — `Cannot find module '@/utils/offline/plan'`

- [ ] **Step 3: Write the pure decisions**

Create `utils/offline/plan.ts`:

```ts
/**
 * What to release, in what order, and what a broadcast result means.
 *
 * Split from the driver so the two decisions that can lose money — ordering and
 * cascading — are unit-testable without a database or a network.
 */
import { descendantsOf, releaseOrder, type OrderableTx } from './order'
import type { OfflineActionRow } from '@/storage/methods/offlineActions'

export type PostOutcome = 'success' | 'serviceError' | 'invalidTx' | 'doubleSpend'

/**
 * Dependency-ordered release list.
 *
 * `owned` distinguishes a transaction this wallet has a request for — post it
 * through `attemptToPostReqsToNetwork` so the toolbox does its own status
 * bookkeeping — from a foreign ancestor that arrived inside somebody's BEEF and
 * has no request here, which must be posted directly. Getting this wrong is how
 * a child becomes an orphan: EF carries input scripts but not parent
 * transactions, so an unbroadcast ancestor has to go out on its own first.
 */
export function planRelease(args: { rows: OfflineActionRow[]; txs: OrderableTx[] }): { txid: string; owned: boolean }[] {
  const owned = new Set(args.rows.filter(r => r.status !== 'sent').map(r => r.txid))
  return releaseOrder(args.txs).map(txid => ({ txid, owned: owned.has(txid) }))
}

/**
 * Turn one broadcast result into state changes.
 *
 *  · success      — this transaction is out; continue down the list.
 *  · serviceError — no evidence of invalidity, only of no network. Stop the run
 *                   and leave everything queued. Never reject on this.
 *  · invalidTx /
 *    doubleSpend  — the network refuses it, so no descendant of it can ever be
 *                   valid. Reject it and every descendant, and stop, because
 *                   anything later in the order may depend on it.
 */
export function applyOutcome(args: {
  txid: string
  outcome: PostOutcome
  txs: OrderableTx[]
  rows: OfflineActionRow[]
}): {
  stop: boolean
  sent: string[]
  rejected: { txid: string; reason: string; poisonedByTxid: string }[]
} {
  const { txid, outcome, txs } = args
  if (outcome === 'success') return { stop: false, sent: [txid], rejected: [] }
  if (outcome === 'serviceError') return { stop: true, sent: [], rejected: [] }

  const reason =
    outcome === 'doubleSpend'
      ? 'the network reported a double spend of an input'
      : 'the network rejected the transaction as invalid'
  const rejected = [txid, ...descendantsOf(txid, txs)].map(t => ({
    txid: t,
    reason: t === txid ? reason : `an ancestor was rejected: ${reason}`,
    poisonedByTxid: txid
  }))
  return { stop: true, sent: [], rejected }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest offlinePlan`
Expected: PASS, 10 tests

- [ ] **Step 5: Write the driver**

Create `storage/methods/processOfflineActions.ts`:

```ts
/**
 * Releases held transactions to the network, parents first.
 *
 * The order comes from the BEEF, not from the queue: a received transaction's
 * ancestry can contain other people's unbroadcast transactions that were never
 * our queue rows, and those must go out before ours. Every held request stores
 * the full AtomicBEEF it arrived in (`proven_tx_reqs.inputBEEF`, written at
 * `storage/methods/internalizeAction.js:519`), so merging those beefs gives the
 * whole dependency graph.
 *
 * Transactions we own are posted through the toolbox's own
 * `attemptToPostReqsToNetwork`, which handles status transitions, history notes
 * and `markStaleInputsAsSpent`. Foreign ancestors have no request here, so they
 * are posted directly through `services.postBeef`.
 */
import { Beef } from '@bsv/sdk'
import { attemptToPostReqsToNetwork } from '@bsv/wallet-toolbox-mobile/out/src/storage/methods/attemptToPostReqsToNetwork'
import { EntityProvenTxReq } from '@bsv/wallet-toolbox-mobile/out/src/storage/schema/entities'
import type { StorageExpoSQLite } from '../StorageExpoSQLite'
import { findOfflineActions, updateOfflineAction, type OfflineActionRow } from './offlineActions'
import { applyOutcome, planRelease, type PostOutcome } from '../../utils/offline/plan'
import type { OrderableTx } from '../../utils/offline/order'

export interface ProcessOfflineActionsResult {
  sent: number
  rejected: number
  stopped: boolean
}

export async function processOfflineActions(args: {
  storage: StorageExpoSQLite
  services: {
    postBeef(beef: Beef, txids: string[]): Promise<{ status: string; txidResults: any[] }[]>
  }
}): Promise<ProcessOfflineActionsResult> {
  const { storage, services } = args
  const db = storage.sqliteDb
  if (!db) return { sent: 0, rejected: 0, stopped: true }

  const rows = await findOfflineActions(db, { status: ['queued', 'posting'] })
  if (rows.length === 0) return { sent: 0, rejected: 0, stopped: false }

  // Merge every held request's BEEF into one graph.
  const merged = new Beef()
  const reqByTxid = new Map<string, EntityProvenTxReq>()
  for (const row of rows) {
    const found = await storage.findProvenTxReqs({ partial: { txid: row.txid } })
    const api = found[0]
    if (!api) continue
    const entity = new EntityProvenTxReq(api)
    reqByTxid.set(row.txid, entity)
    if (api.inputBEEF) merged.mergeBeef(Array.from(api.inputBEEF as unknown as Uint8Array))
    if (api.rawTx) merged.mergeRawTx(Array.from(api.rawTx as unknown as Uint8Array))
  }

  const txs = merged.txs as unknown as OrderableTx[]
  const plan = planRelease({ rows, txs })

  let sent = 0
  let rejected = 0
  for (const step of plan) {
    await updateOfflineAction(db, step.txid, { status: 'posting' })
    const outcome = step.owned
      ? await postOwned(storage, reqByTxid.get(step.txid))
      : await postForeign(services, merged, step.txid)

    const result = applyOutcome({ txid: step.txid, outcome, txs, rows })

    for (const txid of result.sent) {
      await updateOfflineAction(db, txid, { status: 'sent' })
      sent++
    }
    for (const r of result.rejected) {
      await rejectOne(storage, db, rows, r)
      rejected++
    }
    if (result.stop) {
      // Leave anything still 'posting' back at 'queued' so the next run retries.
      for (const remaining of plan) {
        if (!result.sent.includes(remaining.txid) && !result.rejected.some(x => x.txid === remaining.txid)) {
          await updateOfflineAction(db, remaining.txid, { status: 'queued' })
        }
      }
      return { sent, rejected, stopped: true }
    }
  }
  return { sent, rejected, stopped: false }
}

/**
 * Post a transaction this wallet owns, reusing the toolbox's bookkeeping.
 *
 * The request has to leave 'nosend' for the post — `attemptToPostReqsToNetwork`
 * only acts on a sendable status — and it has to go BACK to 'nosend' if the post
 * did not succeed. On a service error the toolbox leaves it at 'sending' with
 * `attempts` incremented, which is exactly the state `TaskSendWaiting` picks up
 * every five minutes and `applyProofTimeout` eventually marks 'invalid'
 * (`EntityProvenTxReq.js:426-433`). Leaving it there would hand blocker 4 back
 * to us on the first failed release attempt, and out of dependency order at
 * that. Restoring the hold keeps release ordered and keeps `attempts` still.
 *
 * The module function is imported directly rather than called as
 * `storage.attemptToPostReqsToNetwork`, so Task 8's offline override does not
 * intercept it — by the time this runs we are online by definition.
 */
async function postOwned(storage: StorageExpoSQLite, req: EntityProvenTxReq | undefined): Promise<PostOutcome> {
  if (!req) return 'invalidTx'
  await storage.updateProvenTxReq(req.id, { status: 'unsent' })
  req.status = 'unsent'
  const r = await storage.runAsStorageProvider(async (sp: any) => await attemptToPostReqsToNetwork(sp, [req]))
  const status = r.details.find((d: any) => d.txid === req.txid)?.status
  if (status === 'success') return 'success'
  if (status === 'doubleSpend') return 'doubleSpend'
  if (status === 'invalidTx' || status === 'invalid') return 'invalidTx'

  // Service error: re-hold, and put the transaction back to 'unproven' so the
  // outputs stay spendable and nothing sweeps it while we wait for signal.
  await storage.updateProvenTxReq(req.id, { status: 'nosend' })
  for (const transactionId of req.notify.transactionIds ?? []) {
    await storage.updateTransactionStatus('unproven', transactionId)
  }
  return 'serviceError'
}

/** Post a foreign ancestor that arrived inside someone's BEEF. */
async function postForeign(
  services: { postBeef(beef: Beef, txids: string[]): Promise<{ status: string; txidResults: any[] }[]> },
  merged: Beef,
  txid: string
): Promise<PostOutcome> {
  try {
    const atomic = Beef.fromBinary(merged.toBinaryAtomic(txid))
    const results = await services.postBeef(atomic, [txid])
    for (const r of results) {
      const tr = r.txidResults.find((t: any) => t.txid === txid)
      if (tr?.status === 'success') return 'success'
      if (tr?.doubleSpend) return 'doubleSpend'
    }
    // No success and no double-spend evidence: treat as retryable, never as a
    // rejection. Rejecting a foreign ancestor on thin evidence would cascade
    // into money the user legitimately holds.
    return 'serviceError'
  } catch {
    return 'serviceError'
  }
}

async function rejectOne(
  storage: StorageExpoSQLite,
  db: NonNullable<StorageExpoSQLite['sqliteDb']>,
  rows: OfflineActionRow[],
  r: { txid: string; reason: string; poisonedByTxid: string }
): Promise<void> {
  const row = rows.find(x => x.txid === r.txid)
  const found = await storage.findProvenTxReqs({ partial: { txid: r.txid } })
  const api = found[0]
  if (api) {
    const entity = new EntityProvenTxReq(api)
    // The attribution record: who handed us the poisoned transaction, over what
    // transport, and when. This is the only durable evidence the user will have.
    entity.addHistoryNote({
      when: new Date().toISOString(),
      what: 'offlineRejected',
      poisonedBy: r.poisonedByTxid,
      reason: r.reason,
      senderIdentityKey: row?.senderIdentityKey ?? 'unknown',
      receivedVia: row?.receivedVia ?? 'unknown',
      receivedAt: row?.created_at ?? 'unknown'
    })
    entity.status = 'invalid'
    await entity.updateStorageDynamicProperties(storage as any)
    for (const transactionId of entity.notify.transactionIds ?? []) {
      // 'failed' releases allocated inputs and marks the outputs not spendable
      // (StorageProvider.js:421-424) — the money must stop being spendable.
      await storage.updateTransactionStatus('failed', transactionId)
    }
  }
  if (row) {
    await updateOfflineAction(db, r.txid, {
      status: 'rejected',
      rejectedReason: r.reason,
      poisonedByTxid: r.poisonedByTxid
    })
  }
}
```

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npx jest && npm run fix`
Expected: clean. If `EntityProvenTxReq` is not exported from that path, import it from `@bsv/wallet-toolbox-mobile/out/src/storage/schema/entities/EntityProvenTxReq` instead.

- [ ] **Step 7: Commit**

```bash
git add utils/offline/plan.ts storage/methods/processOfflineActions.ts __tests__/offlinePlan.test.ts
git commit -m "feat(offline): ordered release with cascading rejection and attribution"
```

---

### Task 10: `TaskSendOffline`

**Files:**
- Create: `utils/monitor/TaskSendOffline.ts`
- Modify: `context/WalletContext.tsx` (monitor block around `:833-870`, and the reconnect listener)
- Test: `__tests__/taskSendOffline.test.ts`

**Interfaces:**
- Consumes: `processOfflineActions` (Task 9), `subscribeOnline` (Task 1).
- Produces: `class TaskSendOffline` with `static taskName = 'SendOffline'`, `static checkNow: boolean`, `trigger(now): { run: boolean }`, `runTask(): Promise<string>`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/taskSendOffline.test.ts`:

```ts
import { TaskSendOffline } from '@/utils/monitor/TaskSendOffline'

function task(run: jest.Mock) {
  const t = new TaskSendOffline({ name: 'SendOffline' } as never, run as never)
  return t
}

describe('TaskSendOffline', () => {
  beforeEach(() => {
    TaskSendOffline.checkNow = false
  })

  it('does not run until checkNow is set', () => {
    const t = task(jest.fn())
    expect(t.trigger(Date.now()).run).toBe(false)
  })

  it('runs once checkNow is set', () => {
    TaskSendOffline.checkNow = true
    const t = task(jest.fn())
    expect(t.trigger(Date.now()).run).toBe(true)
  })

  it('clears checkNow so one reconnect causes one pass', async () => {
    TaskSendOffline.checkNow = true
    const run = jest.fn().mockResolvedValue({ sent: 1, rejected: 0, stopped: false })
    const t = task(run)
    await t.runTask()
    expect(TaskSendOffline.checkNow).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('reports what happened', async () => {
    const run = jest.fn().mockResolvedValue({ sent: 2, rejected: 1, stopped: true })
    const log = await task(run).runTask()
    expect(log).toMatch(/sent 2/)
    expect(log).toMatch(/rejected 1/)
    expect(log).toMatch(/stopped/)
  })

  it('returns an empty log when there was nothing to do', async () => {
    const run = jest.fn().mockResolvedValue({ sent: 0, rejected: 0, stopped: false })
    expect(await task(run).runTask()).toBe('')
  })

  it('swallows a failure so the monitor loop survives', async () => {
    const run = jest.fn().mockRejectedValue(new Error('boom'))
    const log = await task(run).runTask()
    expect(log).toMatch(/boom/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest taskSendOffline`
Expected: FAIL — `Cannot find module '@/utils/monitor/TaskSendOffline'`

- [ ] **Step 3: Write minimal implementation**

Create `utils/monitor/TaskSendOffline.ts`:

```ts
/**
 * Releases held offline transactions when the device has signal again.
 *
 * Manually triggered, the same way `TaskCheckForProofs` and `TaskCheckNoSends`
 * are: `trigger` returns true only when `checkNow` has been set, so the task
 * costs nothing while underground and fires promptly on reconnect. The release
 * itself is injected rather than reached through the monitor, which keeps the
 * task testable and keeps the storage wiring in one place.
 */
import { WalletMonitorTask } from '@bsv/wallet-toolbox-mobile/out/src/monitor/tasks/WalletMonitorTask'
import type { Monitor } from '@bsv/wallet-toolbox-mobile'
import type { ProcessOfflineActionsResult } from '@/storage/methods/processOfflineActions'

export class TaskSendOffline extends WalletMonitorTask {
  static taskName = 'SendOffline'
  /** Set by the reconnect listener, and by a manual "send now" control. */
  static checkNow = false

  constructor(
    monitor: Monitor,
    private readonly release: () => Promise<ProcessOfflineActionsResult>
  ) {
    super(monitor, TaskSendOffline.taskName)
  }

  trigger(_nowMsecsSinceEpoch: number): { run: boolean } {
    return { run: TaskSendOffline.checkNow }
  }

  async runTask(): Promise<string> {
    TaskSendOffline.checkNow = false
    try {
      const r = await this.release()
      if (r.sent === 0 && r.rejected === 0) return ''
      return `sent ${r.sent}, rejected ${r.rejected}${r.stopped ? ', stopped early' : ''}\n`
    } catch (e) {
      // A throw here would take down the monitor's whole run loop.
      return `SendOffline failed: ${e instanceof Error ? e.message : String(e)}\n`
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest taskSendOffline`
Expected: PASS, 6 tests

- [ ] **Step 5: Register the task and trigger it on reconnect**

In `context/WalletContext.tsx`, add imports:

```ts
import { TaskSendOffline } from '@/utils/monitor/TaskSendOffline'
import { processOfflineActions } from '@/storage/methods/processOfflineActions'
```

Inside the monitor block, immediately after `monitor.addDefaultTasks()`:

```ts
          // Release held offline transactions when signal returns. Registered
          // after the defaults so it sits last in the run order — the header
          // window is topped up by then.
          if (phoneStorage) {
            monitor.addTask(
              new TaskSendOffline(monitor, () =>
                processOfflineActions({ storage: phoneStorage as any, services: services as any })
              )
            )
          }
```

Add the trigger next to the header top-up effect from Task 5:

```ts
  // One reconnect, one release pass.
  useEffect(() => {
    if (!walletBuilt) return
    return subscribeOnline(online => {
      if (online) TaskSendOffline.checkNow = true
    })
  }, [walletBuilt])
```

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npx jest && npm run fix`
Expected: clean. If `monitor.addTask` rejects the instance on a name clash, confirm no default task is called `SendOffline` (`grep -rn "taskName = '" node_modules/@bsv/wallet-toolbox-mobile/out/src/monitor/tasks/`).

- [ ] **Step 7: Commit**

```bash
git add utils/monitor/TaskSendOffline.ts __tests__/taskSendOffline.test.ts context/WalletContext.tsx
git commit -m "feat(offline): TaskSendOffline releases the queue on reconnect"
```

---

### Task 11: The payer enqueues instead of broadcasting

**Files:**
- Modify: `utils/localpay/build.ts:252-279`, `utils/pay/rails/nearby.ts`
- Test: `__tests__/localpayBuild.test.ts` (extend the existing file)

**Interfaces:**
- Consumes: `holdReqsOffline` (Task 8), `getOnline` (Task 1).
- Produces: `finalizeDelivery(wallet, built, ack, originator, deps?: { online?: () => Promise<boolean>; hold?: (txid: string) => Promise<void> })` — same return type as today, `DeliveryOutcome`.

`buildPaymentFrame` already passes `noSend: true`, which `determineReqTxStatus`
(`storage/methods/processAction.js:150`) maps to transaction status `nosend` —
excluded from `allocateChangeInput`'s `['completed','unproven','sending']` at
`storage/StorageExpoSQLite.ts:1278`. So the payer's change from a first offline
payment is unspendable until the transaction is promoted to `unproven`. That
promotion is a pure status write (`StorageProvider.js:397-436`; only `failed`
has side-effects).

- [ ] **Step 1: Write the failing test**

Append to `__tests__/localpayBuild.test.ts`:

```ts
import { finalizeDelivery } from '@/utils/localpay/build'

describe('finalizeDelivery when offline', () => {
  const built = { frame: {} as never, reference: 'ref-1', txid: 'aa'.repeat(32) }

  it('enqueues instead of broadcasting and reports pending', async () => {
    const wallet = {
      createAction: jest.fn(),
      abortAction: jest.fn(),
      getPublicKey: jest.fn(),
      signAction: jest.fn()
    }
    const hold = jest.fn().mockResolvedValue(undefined)
    const r = await finalizeDelivery(wallet as never, built, { ok: true }, 'admin.com', {
      online: async () => false,
      hold
    })
    expect(r).toEqual({ kind: 'sent', broadcast: 'pending', detail: expect.stringMatching(/offline/i) })
    expect(hold).toHaveBeenCalledWith('aa'.repeat(32))
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('still broadcasts when online', async () => {
    const wallet = {
      createAction: jest.fn().mockResolvedValue({ sendWithResults: [{ txid: built.txid, status: 'sending' }] }),
      abortAction: jest.fn(),
      getPublicKey: jest.fn(),
      signAction: jest.fn()
    }
    const hold = jest.fn()
    const r = await finalizeDelivery(wallet as never, built, { ok: true }, 'admin.com', {
      online: async () => true,
      hold
    })
    expect(r).toEqual({ kind: 'sent', broadcast: 'ok' })
    expect(hold).not.toHaveBeenCalled()
  })

  it('still aborts on a negative ack while offline', async () => {
    const wallet = {
      createAction: jest.fn(),
      abortAction: jest.fn().mockResolvedValue({ aborted: true }),
      getPublicKey: jest.fn(),
      signAction: jest.fn()
    }
    const hold = jest.fn()
    const r = await finalizeDelivery(wallet as never, built, { ok: false, error: 'declined' }, 'admin.com', {
      online: async () => false,
      hold
    })
    expect(r).toEqual({ kind: 'declined', reason: 'declined' })
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, 'admin.com')
    expect(hold).not.toHaveBeenCalled()
  })

  it('reports pending when the enqueue itself fails', async () => {
    const wallet = {
      createAction: jest.fn(),
      abortAction: jest.fn(),
      getPublicKey: jest.fn(),
      signAction: jest.fn()
    }
    const hold = jest.fn().mockRejectedValue(new Error('db locked'))
    const r = await finalizeDelivery(wallet as never, built, { ok: true }, 'admin.com', {
      online: async () => false,
      hold
    })
    expect(r.kind).toBe('sent')
    expect((r as { broadcast: string }).broadcast).toBe('pending')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest localpayBuild`
Expected: FAIL — `finalizeDelivery` ignores the fifth argument and calls `createAction`.

- [ ] **Step 3: Write minimal implementation**

In `utils/localpay/build.ts`, add the import and extend `finalizeDelivery`:

```ts
import { getOnline } from '@/utils/net/online'
```

Replace the body of `finalizeDelivery` (keeping its existing doc comment and adding to it):

```ts
/**
 * ... existing comment ...
 *
 * OFFLINE: with no network there is nothing to broadcast to, so a positive ack
 * enqueues instead. The transaction is promoted from `nosend` to `unproven` by
 * the hold, which is what lets the payer fund a SECOND offline payment from this
 * one's change — `allocateChangeInput` excludes `nosend`
 * (storage/StorageExpoSQLite.ts:1278). The outcome is the existing
 * `broadcast: 'pending'`, which the UI already renders as "queued", so no new
 * state reaches the screens.
 */
export async function finalizeDelivery(
  wallet: PayingWallet,
  built: BuiltPayment,
  ack: Ack,
  originator: string,
  deps?: {
    online?: () => Promise<boolean>
    /** Promotes the transaction to `unproven` and queues the txid for release. */
    hold?: (txid: string) => Promise<void>
  }
): Promise<DeliveryOutcome> {
  if (!ack.ok) {
    if (built.reference) {
      await wallet
        .abortAction({ reference: built.reference }, originator)
        .catch((e: unknown) => console.warn('[localpay] abortAction failed:', messageOf(e)))
    }
    return { kind: 'declined', reason: ack.error }
  }

  if (!built.txid) {
    return { kind: 'sent', broadcast: 'pending', detail: 'the wallet returned no txid to broadcast' }
  }

  const online = deps?.online ?? getOnline
  if (!(await online())) {
    try {
      await deps?.hold?.(built.txid)
      return { kind: 'sent', broadcast: 'pending', detail: 'offline — queued until this device reconnects' }
    } catch (e) {
      // The payee holds a copy and will internalize it, so this is still a sent
      // payment. What failed is our own record of needing to broadcast it, and
      // the monitor's nosend sweep will still find the transaction.
      return { kind: 'sent', broadcast: 'pending', detail: messageOf(e) }
    }
  }

  try {
    await broadcastPayment(wallet, built.txid, originator)
    return { kind: 'sent', broadcast: 'ok' }
  } catch (e) {
    return { kind: 'sent', broadcast: 'pending', detail: messageOf(e) }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest localpayBuild`
Expected: PASS — existing tests plus 4 new ones.

- [ ] **Step 5: Provide the `hold` implementation at the call site**

Create `utils/offline/payerHold.ts`:

```ts
/**
 * The payer's side of the offline queue: promote the withheld transaction so
 * its change is spendable, then record that it still needs broadcasting.
 */
import { insertOfflineAction } from '@/storage/methods/offlineActions'
import type { StorageExpoSQLite } from '@/storage/StorageExpoSQLite'

export async function holdSentPaymentOffline(args: {
  storage: StorageExpoSQLite
  txid: string
}): Promise<void> {
  const { storage, txid } = args
  const db = storage.sqliteDb
  const found = await storage.findProvenTxReqs({ partial: { txid } })
  const req = found[0]
  if (req) {
    // Held, not swept, still releasable via sendWith.
    await storage.updateProvenTxReq(req.provenTxReqId, { status: 'nosend' })
    for (const transactionId of (req.notify as any)?.transactionIds ?? []) {
      // nosend -> unproven is a pure status write; it is what makes this
      // payment's change usable for the next offline payment.
      await storage.updateTransactionStatus('unproven', transactionId)
    }
  }
  const txRows = await storage.findTransactions({ partial: { txid }, noRawTx: true })
  const userId = txRows[0]?.userId ?? 0
  if (db) await insertOfflineAction(db, { userId, txid, role: 'sent' })
}
```

Then in `components/pay/NearbyFlow.tsx`, at the `finalizeDelivery(...)` call site, pass the dependency:

```ts
      const outcome = await finalizeDelivery(wallet as never, built, ack, adminOriginator, {
        hold: async txid => await holdSentPaymentOffline({ storage: storage as never, txid })
      })
```

Add `import { holdSentPaymentOffline } from '@/utils/offline/payerHold'` and make sure `storage` is in scope from `useWallet()` (it already is — `NearbyFlow` reads it for `savePending`).

- [ ] **Step 6: Re-export from the rail**

In `utils/pay/rails/nearby.ts`, add to the exports:

```ts
export { holdSentPaymentOffline } from '@/utils/offline/payerHold'
```

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit && npx jest && npm run fix`
Expected: clean, `payNearbyRail` and `payRails` still green.

- [ ] **Step 8: Commit**

```bash
git add utils/localpay/build.ts utils/offline/payerHold.ts utils/pay/rails/nearby.ts components/pay/NearbyFlow.tsx __tests__/localpayBuild.test.ts
git commit -m "feat(pay): payer queues an offline payment instead of broadcasting"
```

---

### Task 12: The offline interface

**Files:**
- Create: `components/pay/OfflineNotice.tsx`
- Modify: `components/pay/PayCellRow.tsx`, `app/pay.tsx:146-183`, `components/pay/ReceivedOverlay.tsx`, `context/i18n/translations.tsx`
- Test: `__tests__/payScreen.test.tsx` (extend), `__tests__/offlineNotice.test.tsx`

**Interfaces:**
- Consumes: `useOnline` (Task 1), `findOfflineActions` + `OfflineActionRow` (Task 6).
- Produces: `<OfflineNotice queued={number} rejected={OfflineActionRow[]} online={boolean} />`; `PayCellRowProps` gains `disabled?: boolean`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/offlineNotice.test.tsx`:

```tsx
import React from 'react'
import { render } from '@testing-library/react-native'
import OfflineNotice from '@/components/pay/OfflineNotice'

const row = (txid: string) => ({
  offlineActionId: 1,
  created_at: '2026-07-28T00:00:00.000Z',
  updated_at: '2026-07-28T00:00:00.000Z',
  userId: 1,
  txid,
  seq: 1,
  role: 'received' as const,
  senderIdentityKey: '02'.padEnd(66, 'c'),
  receivedVia: 'awdl',
  status: 'rejected' as const,
  rejectedReason: 'the network rejected the transaction as invalid',
  poisonedByTxid: txid
})

describe('OfflineNotice', () => {
  it('renders nothing when online with an empty queue', () => {
    const { toJSON } = render(<OfflineNotice online queued={0} rejected={[]} />)
    expect(toJSON()).toBeNull()
  })

  it('says it is offline', () => {
    const { getByText } = render(<OfflineNotice online={false} queued={0} rejected={[]} />)
    expect(getByText(/offline/i)).toBeTruthy()
  })

  it('reports the queued count while offline', () => {
    const { getByText } = render(<OfflineNotice online={false} queued={2} rejected={[]} />)
    expect(getByText(/2/)).toBeTruthy()
  })

  it('shows a rejection with its sender even when back online', () => {
    const { getByText } = render(<OfflineNotice online queued={0} rejected={[row('aa'.repeat(32))]} />)
    expect(getByText(/02cccc/i)).toBeTruthy()
    expect(getByText(/rejected/i)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest offlineNotice`
Expected: FAIL — `Cannot find module '@/components/pay/OfflineNotice'`

- [ ] **Step 3: Write the component**

Create `components/pay/OfflineNotice.tsx`:

```tsx
/**
 * Two things the user must be told, in one place.
 *
 * While offline: which rails still work and how many payments are waiting to be
 * broadcast. After a rejection: which payment the network refused and who
 * handed it over — that identity key is the only recourse the user has, so the
 * row persists rather than toasting away.
 *
 * It never claims settlement. A payment nobody has broadcast can still be
 * double-spent by the payer once they reconnect; no header check closes that,
 * so the copy says "not yet broadcast", never "received".
 */
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/theme/ThemeContext'
import { radii, spacing, typography } from '@/context/theme/tokens'
import type { OfflineActionRow } from '@/storage/methods/offlineActions'

export interface OfflineNoticeProps {
  online: boolean
  queued: number
  rejected: OfflineActionRow[]
}

export default function OfflineNotice({ online, queued, rejected }: OfflineNoticeProps) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  if (online && rejected.length === 0) return null

  return (
    <View style={styles.wrap}>
      {!online && (
        <View style={[styles.card, { backgroundColor: colors.fillTertiary, borderColor: colors.separator }]}>
          <Ionicons name="cloud-offline-outline" size={18} color={colors.textSecondary} />
          <View style={styles.text}>
            <Text style={[styles.title, { color: colors.textPrimary }]}>{t('pay_offline_title')}</Text>
            <Text style={[styles.body, { color: colors.textSecondary }]}>
              {queued > 0 ? t('pay_offline_queued', { count: queued }) : t('pay_offline_body')}
            </Text>
          </View>
        </View>
      )}
      {rejected.map(r => (
        <View
          key={r.txid}
          style={[styles.card, { backgroundColor: colors.fillTertiary, borderColor: colors.separator }]}
        >
          <Ionicons name="alert-circle-outline" size={18} color={colors.textSecondary} />
          <View style={styles.text}>
            <Text style={[styles.title, { color: colors.textPrimary }]}>{t('pay_offline_rejected_title')}</Text>
            <Text style={[styles.body, { color: colors.textSecondary }]}>
              {t('pay_offline_rejected_body', {
                sender: r.senderIdentityKey ? `${r.senderIdentityKey.slice(0, 8)}…` : t('pay_offline_unknown_sender'),
                via: r.receivedVia ?? t('pay_offline_unknown_sender'),
                when: r.created_at.slice(0, 10)
              })}
            </Text>
          </View>
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  // No horizontal padding: this mounts inside the grid, which already supplies
  // spacing.lg on both sides. Adding it here would double-indent the cards
  // relative to the cell rows below them.
  wrap: { paddingBottom: spacing.md, gap: spacing.sm },
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth
  },
  text: { flex: 1, gap: 2 },
  title: { ...typography.subhead, fontWeight: '600' },
  body: { ...typography.footnote }
})
```

- [ ] **Step 4: Add the i18n keys in all five locales**

In `context/i18n/translations.tsx`, add these keys to the English block near the existing `pay_cell_*` keys (around `:341`), then mirror them into the four other locale blocks (`zh` ~`:638`, `hi` ~`:938`, `es` ~`:1239`, `fr` ~`:1534`) — translated, not copied:

```ts
      pay_offline_title: 'No internet',
      pay_offline_body: 'Only nearby payments work right now. They will be broadcast when you reconnect.',
      pay_offline_queued: '{{count}} payment(s) waiting to be broadcast when you reconnect.',
      pay_offline_needs_internet: 'Needs internet',
      pay_offline_rejected_title: 'A payment was rejected',
      pay_offline_rejected_body: 'The network refused a payment received from {{sender}} over {{via}} on {{when}}.',
      pay_offline_unknown_sender: 'an unknown sender',
      pay_received_not_broadcast: 'Received offline · not yet broadcast',
```

- [ ] **Step 5: Add `disabled` to `PayCellRow`**

In `components/pay/PayCellRow.tsx`, extend the props and honour them:

```tsx
export interface PayCellRowProps {
  title: string
  subtitle: string
  icon: keyof typeof Ionicons.glyphMap
  onPress: () => void
  /** Dimmed and unpressable — used for rails that need internet. */
  disabled?: boolean
}

export default function PayCellRow({ title, subtitle, icon, onPress, disabled = false }: PayCellRowProps) {
  const { colors } = useTheme()
  return (
    <PressableScale
      onPress={disabled ? () => {} : onPress}
      haptic={disabled ? undefined : 'tap'}
      scaleTo={disabled ? 1 : 0.98}
      disabled={disabled}
      style={[
        styles.row,
        { backgroundColor: colors.backgroundElevated, borderColor: colors.separator },
        disabled && styles.disabled
      ]}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityLabel={`${title}. ${subtitle}`}
    >
```

and add to the stylesheet:

```ts
  disabled: { opacity: 0.4 },
```

Keep the rest of the component unchanged. If `PressableScale` does not accept `disabled`, wrap the row in a `View` with `pointerEvents={disabled ? 'none' : 'auto'}` instead of adding the prop.

- [ ] **Step 6: Gate the grid and mount the notice**

In `app/pay.tsx`, add imports:

```ts
import { useOnline } from '@/hooks/useOnline'
import OfflineNotice from '@/components/pay/OfflineNotice'
import { findOfflineActions, type OfflineActionRow } from '@/storage/methods/offlineActions'
```

Inside `PayScreen`, add state and a load:

```ts
  const online = useOnline()
  const { walletBuilding, walletBuilt, storage } = useWallet()
  const [queued, setQueued] = useState(0)
  const [rejected, setRejected] = useState<OfflineActionRow[]>([])

  // Refreshed on focus and on connectivity change: the queue only moves when
  // the network state does.
  useEffect(() => {
    if (!walletBuilt) return
    let cancelled = false
    void (async () => {
      try {
        const db = (storage as any)?.sqliteDb
        if (!db) return
        const rows = await findOfflineActions(db, { status: ['queued', 'posting', 'rejected'] })
        if (cancelled) return
        setQueued(rows.filter(r => r.status !== 'rejected').length)
        setRejected(rows.filter(r => r.status === 'rejected'))
      } catch {
        // The banner is advisory. A read failure must not break the screen.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [walletBuilt, storage, online])
```

Change the grid to disable the online-only cells and render the notice:

```tsx
  const grid = () => (
    <View style={styles.grid}>
      <OfflineNotice online={online} queued={queued} rejected={rejected} />
      {/* Direction first: it is what the user already knows. */}
      <View style={[styles.segment, { backgroundColor: colors.fillTertiary }]}>
        {/* ...unchanged... */}
      </View>

      <View style={styles.rows}>
        {CELLS[direction].map(spec => {
          // Handle needs a message box and address needs an overlay lookup;
          // neither works underground. Nearby is the whole point of offline.
          const needsInternet = !spec.cell.endsWith('nearby')
          const disabled = !online && needsInternet
          return (
            <PayCellRow
              key={spec.cell}
              title={t(spec.titleKey)}
              subtitle={disabled ? t('pay_offline_needs_internet') : t(spec.subtitleKey)}
              icon={spec.icon}
              disabled={disabled}
              onPress={() => setCell(spec.cell)}
            />
          )
        })}
      </View>
    </View>
  )
```

`<OfflineNotice>` is the first child of `styles.grid`, above the segmented control, so it inherits the grid's horizontal padding and needs none of its own.

- [ ] **Step 7: Update the receipt copy**

In `components/pay/ReceivedOverlay.tsx`, extend the props (currently at `:37-45`) and render the extra line. The overlay is presentational — it decides nothing — so this is a pure display change:

```tsx
export interface ReceivedOverlayProps {
  /** Total satoshis credited in this event. */
  amount: number
  /** How many payments made up that total. Only shown when it is more than one. */
  count?: number
  /**
   * False when the payment was accepted with no network and has not reached a
   * broadcaster yet. The money is credited and spendable either way; what is
   * unsettled is whether anyone but these two devices has seen it, and the
   * payee is entitled to know that before treating it as final.
   */
  broadcast?: boolean
  /** Acknowledged. The only way this screen closes. */
  onDismiss: () => void
}

export default function ReceivedOverlay({ amount, count = 1, broadcast = true, onDismiss }: ReceivedOverlayProps) {
```

Then, directly beneath the existing amount block inside the modal, add:

```tsx
      {!broadcast && (
        <Text style={[styles.pending, { color: colors.textSecondary }]}>{t('pay_received_not_broadcast')}</Text>
      )}
```

and to the stylesheet:

```ts
  pending: { ...typography.footnote, textAlign: 'center', marginTop: spacing.xs },
```

In `components/pay/NearbyFlow.tsx`, capture connectivity at the moment the payment is persisted and pass it down:

```ts
  const [receivedBroadcast, setReceivedBroadcast] = useState(true)
  // ...where savePending resolves on the payee path:
  setReceivedBroadcast(await getOnline())
  // ...and at the ReceivedOverlay call site:
  <ReceivedOverlay amount={total} count={count} broadcast={receivedBroadcast} onDismiss={...} />
```

Add `import { getOnline } from '@/utils/net/online'`. If `ReceivedOverlay` is instead mounted from `app/_layout.tsx` via the global notification path, thread `broadcast` through the same state that carries `amount` there.

- [ ] **Step 8: Extend the pay-screen test**

`__tests__/payScreen.test.tsx` mocks every native dependency and resolves `t` to the key itself, so assertions name keys. Add `useOnline` to its mock block — without it the real hook pulls in NetInfo, which has no native module under jest — using a `mock`-prefixed variable so `babel-plugin-jest-hoist` allows the reference:

```tsx
let mockOnline = true
jest.mock('@/hooks/useOnline', () => ({ useOnline: () => mockOnline }))
```

Reset it in a `beforeEach` alongside the existing setup:

```tsx
beforeEach(() => {
  mockOnline = true
})
```

Then add the test. The existing `useWallet` mock returns only `walletBuilding` and `walletBuilt`, so `storage` is undefined and the queue effect returns early — which is what we want here; this test is about the grid:

```tsx
  it('disables the handle and address cells while offline', () => {
    mockOnline = false
    const { getByLabelText } = draw()
    // `t` returns the key, and PayCellRow's label is `${title}. ${subtitle}`.
    expect(getByLabelText('pay_cell_nearby_pay. pay_cell_nearby_pay_sub').props.accessibilityState.disabled).toBe(false)
    expect(
      getByLabelText('pay_cell_handle_pay. pay_offline_needs_internet').props.accessibilityState.disabled
    ).toBe(true)
    expect(
      getByLabelText('pay_cell_address_pay. pay_offline_needs_internet').props.accessibilityState.disabled
    ).toBe(true)
  })

  it('leaves every cell enabled while online', () => {
    const { getByLabelText } = draw()
    expect(
      getByLabelText('pay_cell_handle_pay. pay_cell_handle_pay_sub').props.accessibilityState.disabled
    ).toBe(false)
  })
```

If `accessibilityState` is not on the queried node (because `PressableScale` forwards props differently), assert on the subtitle text instead: `expect(getByText('pay_offline_needs_internet')).toBeTruthy()`.

- [ ] **Step 9: Verify**

Run: `npx jest && npx tsc --noEmit && npm run fix`
Expected: all tests pass, including `offlineNotice` (4 new) and `payScreen` (2 new on top of its existing cases).

- [ ] **Step 10: Commit**

```bash
git add components/pay/OfflineNotice.tsx components/pay/PayCellRow.tsx components/pay/ReceivedOverlay.tsx app/pay.tsx context/i18n/translations.tsx __tests__/offlineNotice.test.tsx __tests__/payScreen.test.tsx
git commit -m "feat(pay): offline notice, gated rails, and honest receipt copy"
```

---

### Task 13: Device validation

**Files:**
- Modify: `docs/superpowers/specs/2026-07-28-offline-nearby-payments-design.md` (record results)
- Test: two physical iPhones, airplane mode

No unit test replaces this. Tasks 6, 8, 9, and 11 touch SQL and toolbox internals that have no jest harness in this repo, and the whole feature's premise — that a wallet can accept and re-spend money with no network — is only true if it happens on hardware.

- [ ] **Step 1: Build and install on two devices**

```bash
npm run ios-dev-physical
```

Install on both phones and let each finish its first header sync while online. Confirm in the logs: `Header prewarm: N roots from proven_txs` and `Header sync: +N to <tip>/<present>`.

- [ ] **Step 2: Confirm the store on disk**

With both devices online and synced, check that the window reaches the tip and that its size matches expectation (~4.2 MB for a year of mainnet, ~2.2 MB for the whole ttn chain). A window that stops short means `syncHeaders` threw — read the warning.

- [ ] **Step 3: Offline receive**

Airplane mode on both. Fund nothing on the payee. Pay A → B over AWDL. Expected: B's balance rises, B's history shows the payment, the receipt reads "Received offline · not yet broadcast", and `/pay` shows the offline banner with a queued count of 1.

- [ ] **Step 4: Offline re-spend from zero**

Still offline, B pays A (or a third device) from the funds just received. Expected: the payment builds and delivers. This is the case the `unproven` transaction status exists for — if `createAction` reports insufficient funds, the received output was not spendable and Task 8 is wrong.

- [ ] **Step 5: Offline chained spend from change**

Still offline, A makes a second payment funded by the change from step 3. Expected: it builds. If it reports insufficient funds, the `nosend → unproven` promotion in `holdSentPaymentOffline` did not run.

- [ ] **Step 6: Ordered release on one device**

Restore network on one device only. Expected: `TaskSendOffline` fires within one monitor cycle, the log reads `sent N`, every transaction is accepted, and the queue empties. Check the ARC responses: a `SEEN_IN_ORPHAN_MEMPOOL` on any transaction means the ordering is wrong.

- [ ] **Step 7: Idempotency on the second device**

Restore network on the other device. Expected: the transactions it also holds are already in the mempool and are treated as success, not as failures. `arcadeBroadcastProvider.ts` already maps "already in the mempool" to success for WoC; confirm the ARC path does the same and fix it there if not.

- [ ] **Step 8: Long-offline soak**

Leave one device offline for more than twelve hours with a queued payment, then reconnect. Expected: nothing reached `invalid`. This is the check on blocker 4 — `nosend` should have kept `attempts` at zero throughout.

- [ ] **Step 9: Rejection cascade**

Force a rejection (for example, double-spend the payer's input from another wallet while both are offline, then reconnect). Expected: the rejected transaction and every descendant move to `rejected`, `/pay` shows the attribution row naming the sender's identity key and transport, and the spent outputs are no longer spendable.

- [ ] **Step 10: Record the results and commit**

Append a "Device validation" section to the design doc with what passed, what failed, and any deferrals.

```bash
git add docs/superpowers/specs/2026-07-28-offline-nearby-payments-design.md
git commit -m "docs(pay): record offline nearby payment device validation"
```

---

## Deviations from the spec, for review

**Two spec unit tests became device checks.** The spec's testing section asked for jest coverage of "`offline_actions` CRUD and the `CREATE TABLE IF NOT EXISTS` upgrade path from a pre-existing database" and of "transaction/req status pairs after each transition". Both need a real SQLite engine, and this repo has no storage test harness — `ls __tests__` shows 36 files, none of them touching `storage/`. Standing one up is a larger piece of work than this feature. Instead: every decision those tests would have protected is extracted into a pure module that *is* unit-tested (`utils/offline/order.ts`, `utils/offline/plan.ts`, `utils/offline/hold.ts`), the SQL layer is kept logic-free, and the status pairs are verified on hardware in Task 13 steps 3-5 and 8. If that trade is not acceptable, the fix is a separate task adding a SQLite harness before Task 6.

**The internalize seam changed.**

The spec's API-surface section proposed `StorageProvider.internalizeActionOffline(auth, args)` — a parallel copy of `internalizeAction` differing only in its broadcast branch. Research while writing this plan found a better seam, and Task 8 uses it instead:

`internalizeAction`'s forced broadcast reaches exactly one overridable thing — `storage.attemptToPostReqsToNetwork(...)` at `storage/methods/processAction.js:146`, a public method declared at `StorageProvider.d.ts:111`. Overriding that holds the broadcast without duplicating ~400 lines of money-critical logic (proven-tx insertion, target-transaction merge, `markInputsSpent`, BRC-29 payment records, labels, baskets), and `TaskSendWaiting` is unaffected because it calls the module function directly at `TaskSendWaiting.js:180`.

The public, upstream-shaped method becomes `holdReqsOffline(reqs, userId)` rather than `internalizeActionOffline`. Everything else in the spec — the two status levers, the `offline_actions` table, BEEF-derived ordering, EF posting parent-first, the cascade with attribution, `TaskSendOffline` — is unchanged.
