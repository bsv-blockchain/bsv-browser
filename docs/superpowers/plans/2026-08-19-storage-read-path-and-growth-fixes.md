# Storage Read Path and Unbounded Growth Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the wallet reading and expanding megabyte BLOBs it immediately discards, serve byte-range reads in SQL, and bound the two columns that grow without limit.

**Architecture:** All changes are local to `storage/`, `utils/` and `services/vault/`. No codec, no schema change, no toolbox patch. Each task extracts a pure, testable helper and wires it into an existing method, so behaviour is verified without a device.

**Tech Stack:** TypeScript, expo-sqlite, `@bsv/wallet-toolbox-mobile`, Jest, `node:sqlite` (test-only, verified available on Node v24.15.0).

**Spec:** [docs/superpowers/specs/2026-08-19-tx-size-limits-and-blob-compression-design.md](../specs/2026-08-19-tx-size-limits-and-blob-compression-design.md) §7 and §4.5 B0.

## Global Constraints

- No schema migration. No change to any column type or nullability.
- No behavioural change visible to the toolbox: every method keeps its existing signature and return type (`number[]`, not `Uint8Array`, at the storage boundary).
- `maxOutputScript = 1024` — vault outputs store `scriptOffset`/`scriptLength` and NOT the script, so the range-read path is live and vault-only.
- SQLite `substr` on a BLOB is byte-based and **1-indexed**: a JS offset `n` maps to `substr(col, n + 1, len)`.
- Commit after every task.

---

### Task 1: Column projection in `sqlFind`, making `noRawTx`/`noScript` real

**Files:**
- Create: `storage/methods/findSql.ts`
- Create: `__tests__/storage/findSql.test.ts`
- Modify: `storage/StorageExpoSQLite.ts` (`sqlFind` :322-355, `findOutputs` :736, `findTransactions` :807, `findProvenTxs` :919, `findProvenTxReqs` :896)

**Interfaces:**
- Produces: `buildFindSql(opts: { table: string; whereSql: string; hasSince: boolean; extraConditions?: string[]; pkCol: string; orderDescending?: boolean; limit?: number; offset?: number; columns?: string[] }): string`
- Produces: `BLOB_COLUMNS: Record<string, string[]>` mapping table name → blob column names.
- Produces: `columnsExcluding(table: string, exclude: string[]): string[] | undefined` — `undefined` means "all columns" (`SELECT *`).

**Why:** `sqlFind` always emits `SELECT *`, so `validateEntity` `Array.from`s every BLOB (~8× heap under Hermes) and `findOutputs`/`findTransactions` then throw the value away. Five callers already ask for the cheap path and pay full price.

- [ ] **Step 1: Write the failing test**

```ts
import { BLOB_COLUMNS, buildFindSql, columnsExcluding } from '@/storage/methods/findSql'

describe('columnsExcluding', () => {
  it('returns undefined when nothing is excluded, meaning SELECT *', () => {
    expect(columnsExcluding('outputs', [])).toBeUndefined()
  })

  it('names every non-excluded column so the blob is never read', () => {
    const cols = columnsExcluding('outputs', ['lockingScript'])!
    expect(cols).not.toContain('lockingScript')
    expect(cols).toContain('outputId')
    expect(cols).toContain('scriptOffset')
    expect(cols).toContain('scriptLength')
  })

  it('knows the blob columns of every table it projects', () => {
    expect(BLOB_COLUMNS.outputs).toEqual(['lockingScript'])
    expect(BLOB_COLUMNS.transactions).toEqual(['rawTx', 'inputBEEF'])
    expect(BLOB_COLUMNS.proven_txs).toEqual(['rawTx', 'merklePath'])
    expect(BLOB_COLUMNS.proven_tx_reqs).toEqual(['rawTx', 'inputBEEF'])
  })
})

describe('buildFindSql', () => {
  it('emits SELECT * when no column list is given', () => {
    const sql = buildFindSql({ table: 'outputs', whereSql: '', hasSince: false, pkCol: 'outputId' })
    expect(sql).toContain('SELECT * FROM "outputs"')
  })

  it('emits an explicit projection that does not name the blob column', () => {
    const sql = buildFindSql({
      table: 'outputs',
      whereSql: 'WHERE "spendable" = ?',
      hasSince: false,
      pkCol: 'outputId',
      columns: columnsExcluding('outputs', ['lockingScript'])
    })
    expect(sql).not.toMatch(/lockingScript/)
    expect(sql).toMatch(/^SELECT "outputId"/)
    expect(sql).toContain('WHERE "spendable" = ?')
    expect(sql).toContain('ORDER BY "outputId" ASC')
  })

  it('preserves since, extra conditions, order and paging exactly as before', () => {
    const sql = buildFindSql({
      table: 'transactions',
      whereSql: 'WHERE "userId" = ?',
      hasSince: true,
      extraConditions: ['status IN (?,?)'],
      pkCol: 'transactionId',
      orderDescending: true,
      limit: 10,
      offset: 5
    })
    expect(sql).toContain('AND updated_at >= ?')
    expect(sql).toContain('AND status IN (?,?)')
    expect(sql).toContain('ORDER BY "transactionId" DESC')
    expect(sql).toContain('LIMIT 10')
    expect(sql).toContain('OFFSET 5')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest __tests__/storage/findSql.test.ts`
Expected: FAIL — cannot find module `@/storage/methods/findSql`.

- [ ] **Step 3: Implement `storage/methods/findSql.ts`**

Copy the clause order from `sqlFind` verbatim (`WHERE` → `since` → extra conditions → `ORDER BY` → `LIMIT`/`OFFSET`), because the `AND`/`WHERE` choice depends on what came before. Column names come from `storage/schema/createTables.ts` — read them from the file, do not invent them.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest __tests__/storage/findSql.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `sqlFind` and the four finders**

`sqlFind` takes an optional `columns?: string[]` and delegates its query building to `buildFindSql`. `findOutputs` passes `columnsExcluding('outputs', ['lockingScript'])` when `args.noScript`; `findTransactions` passes `columnsExcluding('transactions', ['rawTx', 'inputBEEF'])` when `args.noRawTx`. Keep the existing post-hoc `o.lockingScript = undefined` / `t.rawTx = undefined` assignments — with the projection they are no-ops, and leaving them means a future caller that forgets the projection still gets the documented shape.

- [ ] **Step 6: Verify nothing regressed**

Run: `npx tsc --noEmit` (expect only the two pre-existing `funding-app/vite.config.ts` errors) then `npx jest`.
Expected: all suites pass.

- [ ] **Step 7: Commit**

```bash
git add storage/methods/findSql.ts __tests__/storage/findSql.test.ts storage/StorageExpoSQLite.ts
git commit -m "perf(storage): project columns so noRawTx/noScript stop reading blobs"
```

---

### Task 2: Serve byte-range reads in SQL

**Files:**
- Modify: `storage/StorageExpoSQLite.ts` (`getRawTxOfKnownValidTransaction` :1235-1250)
- Create: `__tests__/storage/rangeRead.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: no new exports; `getRawTxOfKnownValidTransaction(txid, offset, length, trx)` keeps its signature and `number[] | undefined` return.

**Why:** today the method loads the entire rawTx (a whole vault transaction, ~960 KB, `Array.from`-ed to a 960 K-element array) and then `.slice()`s ~960 KB out of it. `substr` in SQLite reads only the requested bytes. This is also the path the spec's §2.2 silent-fund-eviction failure runs through, so it needs a byte-exactness test of its own.

The existing semantics must be preserved exactly: `proven_txs` is consulted first; only if there is no proven row is `proven_tx_reqs` used, and then **only** when `status` is one of `unsent`, `unmined`, `unconfirmed`, `sending`, `nosend`, `completed`.

- [ ] **Step 1: Write the failing test** (uses `node:sqlite` directly against the real schema)

```ts
import { DatabaseSync } from 'node:sqlite'
import { rangeReadSql } from '@/storage/methods/findSql'

const RAW = Array.from({ length: 300 }, (_, i) => i % 256)

function db (): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  d.exec('CREATE TABLE proven_txs (txid TEXT, rawTx BLOB NOT NULL)')
  d.exec("CREATE TABLE proven_tx_reqs (txid TEXT, status TEXT, rawTx BLOB)")
  d.prepare('INSERT INTO proven_txs (txid, rawTx) VALUES (?, ?)').run('aa', Buffer.from(RAW))
  d.prepare('INSERT INTO proven_tx_reqs (txid, status, rawTx) VALUES (?, ?, ?)')
    .run('bb', 'completed', Buffer.from(RAW))
  d.prepare('INSERT INTO proven_tx_reqs (txid, status, rawTx) VALUES (?, ?, ?)')
    .run('cc', 'invalid', Buffer.from(RAW))
  return d
}

describe('rangeReadSql', () => {
  it('reads an exact byte range from proven_txs, 1-indexed conversion included', () => {
    const row: any = db().prepare(rangeReadSql('proven_txs')).get(41, 10, 'aa')
    expect(Array.from(row.chunk as Uint8Array)).toEqual(RAW.slice(40, 50))
  })

  it('matches a full-array slice byte for byte at a large offset', () => {
    const row: any = db().prepare(rangeReadSql('proven_txs')).get(251, 49, 'aa')
    expect(Array.from(row.chunk as Uint8Array)).toEqual(RAW.slice(250, 299))
  })

  it('reads from proven_tx_reqs only for usable statuses', () => {
    const d = db()
    const ok: any = d.prepare(rangeReadSql('proven_tx_reqs')).get(1, 4, 'bb')
    expect(Array.from(ok.chunk as Uint8Array)).toEqual(RAW.slice(0, 4))
    const bad = d.prepare(rangeReadSql('proven_tx_reqs')).get(1, 4, 'cc')
    expect(bad).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest __tests__/storage/rangeRead.test.ts`
Expected: FAIL — `rangeReadSql` is not exported.

- [ ] **Step 3: Add `rangeReadSql` and use it**

```ts
/** Byte-range read. substr() on a BLOB is byte-based and 1-indexed, so a JS
 * offset n is passed as n + 1. Reading the range in SQL avoids materialising a
 * whole ~960 KB vault transaction to slice a script out of it. */
export function rangeReadSql (table: 'proven_txs' | 'proven_tx_reqs'): string {
  const usable = "AND status IN ('unsent','unmined','unconfirmed','sending','nosend','completed')"
  return `SELECT substr(rawTx, ?, ?) AS chunk FROM "${table}" WHERE txid = ? ${
    table === 'proven_tx_reqs' ? usable : ''
  }`
}
```

In `getRawTxOfKnownValidTransaction`, when `offset` and `length` are both integers, query `proven_txs` first and fall through to `proven_tx_reqs`; otherwise keep the existing `getProvenOrRawTx` path untouched. Return `Array.from(chunk)` to preserve the `number[]` contract.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest __tests__/storage/rangeRead.test.ts`
Expected: PASS.

- [ ] **Step 5: Full verification**

Run: `npx tsc --noEmit && npx jest`
Expected: clean; all suites pass.

- [ ] **Step 6: Commit**

```bash
git add storage/StorageExpoSQLite.ts storage/methods/findSql.ts __tests__/storage/rangeRead.test.ts
git commit -m "perf(storage): read byte ranges with substr instead of loading whole rawTx"
```

---

### Task 3: Cap `proven_tx_reqs.history` note values

**Files:**
- Create: `storage/methods/historyNotes.ts`
- Create: `__tests__/storage/historyNotes.test.ts`
- Modify: `services/arcadeBroadcastProvider.ts` (the note-producing result objects)
- Modify: `storage/StorageExpoSQLite.ts` (override `updateProvenTxReqDynamics`)

**Interfaces:**
- Produces: `NOTE_VALUE_MAX = 256`
- Produces: `scrubNoteValues<T>(note: T): T` — returns a copy with every string property longer than `NOTE_VALUE_MAX` truncated to `NOTE_VALUE_MAX - 1` characters plus `…`.

**Why:** provider error notes capture full EF/rawTx hex, `transferNotesToReqHistories` copies them verbatim into a TEXT column with no truncation, and `addHistoryNote`'s dedup does full string equality against every existing note. One failing vault broadcast writes multi-megabyte hex; the second failure compares megabyte strings. Quadratic, and triggered exactly when things go wrong — a direct violation of "stored compressed everywhere" that no rawTx codec touches.

- [ ] **Step 1: Write the failing test**

```ts
import { NOTE_VALUE_MAX, scrubNoteValues } from '@/storage/methods/historyNotes'

describe('scrubNoteValues', () => {
  it('truncates a megabyte of hex to the cap', () => {
    const note = { what: 'postBeef', rawTx: 'ab'.repeat(500_000) }
    const out = scrubNoteValues(note)
    expect(out.rawTx.length).toBe(NOTE_VALUE_MAX)
    expect(out.rawTx.endsWith('…')).toBe(true)
    expect(out.what).toBe('postBeef')
  })

  it('leaves short values untouched and does not mutate the input', () => {
    const note = { what: 'ok', detail: 'short' }
    const out = scrubNoteValues(note)
    expect(out).toEqual(note)
    expect(out).not.toBe(note)
  })

  it('scrubs nested objects and arrays of strings', () => {
    const out = scrubNoteValues({ what: 'x', nested: { hex: 'c'.repeat(9999) }, list: ['d'.repeat(9999)] })
    expect((out.nested as any).hex.length).toBe(NOTE_VALUE_MAX)
    expect((out.list as any)[0].length).toBe(NOTE_VALUE_MAX)
  })

  it('preserves non-string values', () => {
    const out = scrubNoteValues({ what: 'x', code: 429, ok: false, when: null })
    expect(out).toEqual({ what: 'x', code: 429, ok: false, when: null })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest __tests__/storage/historyNotes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement, then apply at both ends**

Implement `scrubNoteValues` as a recursive copy. Then apply it in `services/arcadeBroadcastProvider.ts` wherever a note/detail object is built, and override `updateProvenTxReqDynamics` in `StorageExpoSQLite` to scrub `history` before it is written — the override is the backstop that also covers notes produced inside the toolbox's own providers.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest __tests__/storage/historyNotes.test.ts`
Expected: PASS.

- [ ] **Step 5: Full verification and commit**

```bash
npx tsc --noEmit && npx jest
git add storage/methods/historyNotes.ts __tests__/storage/historyNotes.test.ts services/arcadeBroadcastProvider.ts storage/StorageExpoSQLite.ts
git commit -m "fix(storage): cap history note values so a failed broadcast cannot write megabytes"
```

---

### Task 4: `exportTransactionsAsCsv` height map via direct SQL

**Files:**
- Modify: `utils/exportTransactions.ts:48-54`
- Modify: `storage/StorageExpoSQLite.ts` (add `getProvenTxHeights`)
- Create: `__tests__/exportTransactionsHeights.test.ts`

**Interfaces:**
- Produces: `getProvenTxHeights(): Promise<Map<string, number>>` on `StorageExpoSQLite`.

**Why:** `findProvenTxs({ partial: {} })` is an unbounded `SELECT * FROM proven_txs` that reads and `Array.from`-expands **every rawTx and merklePath in the wallet** purely to build a `txid → height` map. On a wallet with vault history that is hundreds of megabytes of transient heap for two columns.

- [ ] **Step 1: Write the failing test**

```ts
import { DatabaseSync } from 'node:sqlite'
import { PROVEN_HEIGHTS_SQL } from '@/storage/methods/findSql'

it('selects only txid and height', () => {
  expect(PROVEN_HEIGHTS_SQL).toBe('SELECT txid, height FROM proven_txs')
  const d = new DatabaseSync(':memory:')
  d.exec('CREATE TABLE proven_txs (txid TEXT, height INTEGER, rawTx BLOB)')
  d.prepare('INSERT INTO proven_txs VALUES (?,?,?)').run('aa', 42, Buffer.alloc(1024))
  const rows = d.prepare(PROVEN_HEIGHTS_SQL).all() as any[]
  expect(rows).toEqual([{ txid: 'aa', height: 42 }])
  expect(Object.keys(rows[0])).not.toContain('rawTx')
})
```

- [ ] **Step 2: Run to verify it fails, implement, verify it passes**

Run: `npx jest __tests__/exportTransactionsHeights.test.ts`

- [ ] **Step 3: Use it in `exportTransactions.ts`**

Replace the `findProvenTxs` loop with `await storage.getProvenTxHeights()`, keeping the existing `heightMap` variable name and shape so the rest of the function is untouched.

- [ ] **Step 4: Full verification and commit**

```bash
npx tsc --noEmit && npx jest
git add utils/exportTransactions.ts storage/StorageExpoSQLite.ts storage/methods/findSql.ts __tests__/exportTransactionsHeights.test.ts
git commit -m "perf(export): read txid/height directly instead of every rawTx in the wallet"
```

---

### Task 5: Two call-site hygiene fixes

**Files:**
- Modify: `context/WalletContext.tsx:2106` (add `noRawTx: true`)
- Modify: `app/index.tsx:1185-1195` (destructure `nativeEvent` before the async handler)

**Interfaces:** none.

**Why:** the WalletContext call needs only `transactionId` and reads the full rawTx for nothing — free win now that Task 1 makes `noRawTx` real. The `app/index.tsx` handler captures the whole `WebViewMessageEvent` in its async closure, retaining the JSON string (3.6-4.0 N measured) for the entire duration of every wallet call.

- [ ] **Step 1: Apply both edits**

For `app/index.tsx`, keep `handleMessage` async but extract `const { data, url } = event.nativeEvent` in a thin non-async wrapper and pass those two values in, so the event object is not reachable from the coroutine environment.

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit && npx jest`
Expected: clean; all suites pass (`__tests__/iframeWalletRoundTrip.test.ts` and `__tests__/documentStartScript.test.ts` exercise the message path).

- [ ] **Step 3: Commit**

```bash
git add context/WalletContext.tsx app/index.tsx
git commit -m "perf(wallet): stop retaining webview message strings and reading unused rawTx"
```

---

### Task 6: `abortReservingOutpoints` via `outputs.spentBy`

**Files:**
- Modify: `services/vault/transfers.ts:214-266`
- Modify: `storage/StorageExpoSQLite.ts` (add `findSpendingTxidsForOutpoints`)
- Modify: `__tests__/vault/transfers.test.ts`

**Interfaces:**
- Produces: `findSpendingTxidsForOutpoints(outpoints: string[]): Promise<string[]>` — the txids of transactions whose `outputs.spentBy` marks them as spending any of the given outpoints.

**Why:** the current heal pages up to 25 × 200 actions with `includeInputs: true` and `stopAfter: Infinity`, purely to string-match `sourceOutpoint`. `listActionsSql` answers each page by fetching full rawTx and calling `Transaction.fromBinary` per action to read `input?.sequence` — so a vault withdrawal retry parses thousands of transactions to find one outpoint.

- [ ] **Step 1: Write the failing test in the existing vault suite**

Add a case asserting that a wedged outpoint is healed with a single query rather than a paged scan: seed the mock wallet so `listActions` would need to be called, assert `listActions` is **not** called, and assert `abortAction` is called with the reserving reference.

- [ ] **Step 2: Run to verify it fails, implement, verify it passes**

Run: `npx jest __tests__/vault/transfers.test.ts`

- [ ] **Step 3: Full verification and commit**

```bash
npx tsc --noEmit && npx jest
git add services/vault/transfers.ts storage/StorageExpoSQLite.ts __tests__/vault/transfers.test.ts
git commit -m "perf(vault): find the reserving transaction by outpoint instead of paging every action"
```

---

## Self-review

**Spec coverage (§7 + B0):** column projection → Task 1; SQL `substr` range reads → Task 2; `history` cap → Task 3; `exportTransactions` → Task 4; `noRawTx` at WalletContext and the retained event string → Task 5; `abortReservingOutpoints` → Task 6.

**Deferred from §7 with reason:** "stop `Array.from`-ing large BLOBs" is **not** in this plan. `validateEntity` converts every `Uint8Array` to `number[]` because the toolbox's entity classes and `TableOutput`/`TableTransaction` types are declared `number[]`; changing that at the storage boundary is a cross-cutting type change that belongs with spec step B1 (codec to `Uint8Array` end to end), not here. Tasks 1, 2 and 4 remove the three worst *instances* of it without touching the contract. `releaseTemplateCache` guidance is a comment-only change deferred to the codec plan, where it is testable.

**Type consistency:** `buildFindSql`, `columnsExcluding`, `BLOB_COLUMNS`, `rangeReadSql`, `PROVEN_HEIGHTS_SQL` all live in `storage/methods/findSql.ts` and are referenced by those exact names in Tasks 1, 2 and 4. `scrubNoteValues`/`NOTE_VALUE_MAX` live in `storage/methods/historyNotes.ts`. `getProvenTxHeights` and `findSpendingTxidsForOutpoints` are both methods on `StorageExpoSQLite`.

**Follow-on plans (this spec, in order):** (2) WalletInterface size caps + vault input cap + offline gate; (3) disk-space guard, typed storage errors, reclaim report; (4) the compressed-at-rest codec programme B1-B6.
