# Disk Pressure, Typed Storage Errors and Reclaim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn "the disk is full" from an opaque SQLite failure into a typed error the UI can act on, and give the user a measured, safe way to reclaim space.

**Architecture:** A free-space probe and an error classifier, both pure and testable, wired into the single method every wallet write funnels through. Reclaiming is measure-first: a read-only report ships before anything destructive, and the only destructive operation is nulling one column that nothing reads for BEEF.

**Tech Stack:** TypeScript, expo-file-system 55.0.22, expo-sqlite, Jest, `node:sqlite` (test-only).

**Spec:** [docs/superpowers/specs/2026-08-19-tx-size-limits-and-blob-compression-design.md](../specs/2026-08-19-tx-size-limits-and-blob-compression-design.md) Part 3 (§6).

## Global Constraints

- Free space is `Paths.availableDiskSpace` — a **synchronous getter**, `import { Paths } from 'expo-file-system'`. `getFreeDiskStorageAsync` from the bare specifier **throws at runtime**; the only valid async form is the `expo-file-system/legacy` subpath.
- The getter is `Int64?` natively and returns nil on failure while TypeScript claims `number`. An unguarded comparison fails **open**.
- **Absolute thresholds only.** `Paths.totalDiskSpace` returns free space on iOS (upstream bug), so any percentage never fires there. Warn under 200 MB, block non-essential writes under 50 MB.
- Every SQLite failure carries `code === 'ERR_INTERNAL_SQLITE_ERROR'`. Classify on **message text**, unanchored, and **exclude** `database is locked` — a known live false-positive source on this project.
- Do not parse a numeric code out of the message: Android appends it as a raw control character, so SQLITE_FULL renders as `Error code \r: database or disk is full`.
- **WAL is not enabled.** The companion file is a transient `-journal`.
- Reclaiming is never triggered by low disk (the rollback journal for a large UPDATE can itself fail with `SQLITE_FULL`, and with no `auto_vacuum` the file does not shrink).
- Row deletion does not ship. Spent-ness is reversible and the backup delta protocol carries no deletes.
- Commit after every task.

---

### Task 1: Typed storage errors

**Files:**
- Create: `storage/errors.ts`
- Create: `__tests__/storage/errors.test.ts`

**Interfaces:**
- Produces: `type StorageErrorCode = 'disk-full' | 'disk-io' | 'locked' | 'unknown'`
- Produces: `class StorageError extends Error { code: StorageErrorCode; cause?: unknown }`
- Produces: `storageErrorFromSqlite(e: unknown): StorageError | null` — null when the failure is not recognisably a storage-pressure problem.

Modelled on [services/vault/types.ts:6-82](../../../services/vault/types.ts) and its message-regex reclassifier, which is the established pattern in this repo for turning a native error string into a branded code.

- [ ] **Step 1: Write the failing test**

```ts
import { StorageError, storageErrorFromSqlite } from '@/storage/errors'

const sqliteError = (message: string) => Object.assign(new Error(message), { code: 'ERR_INTERNAL_SQLITE_ERROR' })

describe('storageErrorFromSqlite', () => {
  it('classifies a full disk from the iOS message form', () => {
    const e = storageErrorFromSqlite(sqliteError('database or disk is full'))
    expect(e).toBeInstanceOf(StorageError)
    expect(e!.code).toBe('disk-full')
  })

  it('classifies the Android message form, whose prefix is corrupt', () => {
    // Android builds the prefix with `result += code` on an int, so the code
    // renders as a raw control character. Matching the sqlite text rather than
    // the prefix is what survives that — and survives it being fixed upstream.
    expect(storageErrorFromSqlite(sqliteError('Error code \r: database or disk is full'))!.code).toBe('disk-full')
    expect(storageErrorFromSqlite(sqliteError('Error code 13: database or disk is full'))!.code).toBe('disk-full')
  })

  it('classifies an I/O error', () => {
    expect(storageErrorFromSqlite(sqliteError('disk I/O error'))!.code).toBe('disk-io')
  })

  it('does NOT classify a locked database as storage pressure', () => {
    // Every sqlite failure shares one code, and this project already has a
    // storage-lock stall issue, so a handler that treated SQLITE_BUSY as a full
    // disk would tell users to free space over a contended reader lock.
    expect(storageErrorFromSqlite(sqliteError('database is locked'))!.code).toBe('locked')
  })

  it('returns null for failures that are not about storage at all', () => {
    expect(storageErrorFromSqlite(sqliteError('no such column: bogus'))).toBeNull()
    expect(storageErrorFromSqlite(new Error('network request failed'))).toBeNull()
    expect(storageErrorFromSqlite('a string')).toBeNull()
    expect(storageErrorFromSqlite(undefined)).toBeNull()
  })

  it('keeps the original error reachable', () => {
    const original = sqliteError('database or disk is full')
    expect(storageErrorFromSqlite(original)!.cause).toBe(original)
  })
})
```

- [ ] **Step 2: Run to verify it fails, implement, verify it passes**

Run: `npx jest __tests__/storage/errors.test.ts`

- [ ] **Step 3: Commit**

```bash
git add storage/errors.ts __tests__/storage/errors.test.ts
git commit -m "feat(storage): typed storage errors classified from sqlite message text"
```

---

### Task 2: The free-space probe

**Files:**
- Create: `utils/diskSpace.ts`
- Create: `__tests__/diskSpace.test.ts`

**Interfaces:**
- Produces: `DISK_WARN_BYTES = 200 * 1024 * 1024`, `DISK_BLOCK_BYTES = 50 * 1024 * 1024`
- Produces: `type DiskPressure = 'ok' | 'warn' | 'block' | 'unknown'`
- Produces: `availableDiskBytes(): number | null` — null when the native getter gives nothing usable.
- Produces: `diskPressure(free?: number | null): DiskPressure`

`expo-file-system` is a native module, so the import must be lazy for the same reason `capWalletArgs` reads the device tier lazily: a pure helper must not require the native side to exist.

- [ ] **Step 1: Write the failing test**

```ts
import { DISK_BLOCK_BYTES, DISK_WARN_BYTES, diskPressure } from '@/utils/diskSpace'

describe('diskPressure', () => {
  it('reports ok well above the warn threshold', () => {
    expect(diskPressure(5 * 1024 * 1024 * 1024)).toBe('ok')
  })

  it('warns below the warn threshold', () => {
    expect(diskPressure(DISK_WARN_BYTES - 1)).toBe('warn')
  })

  it('blocks below the block threshold', () => {
    expect(diskPressure(DISK_BLOCK_BYTES - 1)).toBe('block')
  })

  it('treats an unreadable value as unknown, never as pressure', () => {
    // The native getter is Int64? and returns nil on failure while TypeScript
    // claims number. Failing open is deliberate: refusing writes because we
    // could not read the disk would be worse than the problem.
    expect(diskPressure(null)).toBe('unknown')
    expect(diskPressure(undefined)).toBe('unknown')
    expect(diskPressure(Number.NaN)).toBe('unknown')
    expect(diskPressure(-1)).toBe('unknown')
  })

  it('uses absolute bytes, not a percentage', () => {
    // Paths.totalDiskSpace returns FREE space on iOS in expo-file-system
    // 55.0.22, so available/total reads ~1.0 regardless of state and any
    // percentage threshold silently never fires.
    expect(DISK_WARN_BYTES).toBe(200 * 1024 * 1024)
    expect(DISK_BLOCK_BYTES).toBe(50 * 1024 * 1024)
  })
})
```

- [ ] **Step 2: Run to verify it fails, implement, verify it passes, commit**

```bash
git add utils/diskSpace.ts __tests__/diskSpace.test.ts
git commit -m "feat(storage): absolute-threshold disk-space probe that fails open"
```

---

### Task 3: Wire both into the single write choke point

**Files:**
- Modify: `storage/StorageExpoSQLite.ts` (`transaction()` :147-170)

**Interfaces:**
- Consumes: `storageErrorFromSqlite` (Task 1), `availableDiskBytes`/`diskPressure` (Task 2).

Every wallet write funnels through `transaction()`, so one wrapper covers `createAction`, `internalizeAction` and all CRUD without touching call sites.

**Pre-emptive checking is not optional.** `withExclusiveTransactionAsync` awaits ROLLBACK inside its catch *before* assigning the error, so a rollback that also fails under disk pressure propagates instead and the original diagnosis is destroyed. A space check before BEGIN is the only way to be sure what happened.

- [ ] **Step 1: Add the pre-write gate and the post-failure classifier**

Before BEGIN: read pressure once; on `block`, throw `StorageError('disk-full')` without opening a transaction. On failure: run the classifier and rethrow the typed error when it matches, otherwise rethrow untouched.

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit && npx jest`

- [ ] **Step 3: Commit**

```bash
git add storage/StorageExpoSQLite.ts
git commit -m "feat(storage): refuse writes on a full disk and classify the failures"
```

---

### Task 4: The read-only reclaim report

**Files:**
- Create: `storage/methods/reclaim.ts`
- Create: `__tests__/storage/reclaim.test.ts`
- Modify: `storage/StorageExpoSQLite.ts` (add `reclaimReport()`)

**Interfaces:**
- Produces: `RECLAIM_CANDIDATES_SQL`, `RECLAIM_SIZES_SQL`
- Produces: `interface ReclaimReport { dbBytes: number | null; perTable: { table: string; blobBytes: number; rows: number }[]; inputBEEF: { rows: number; bytes: number }; excluded: { reason: string; rows: number }[] }`
- Produces: `reclaimReport(): Promise<ReclaimReport>` on `StorageExpoSQLite`.

Measure before writing anything destructive. Real device numbers decide whether the destructive half is worth any risk at all — and the prediction on record is that nearly all of it is `transactions.inputBEEF` plus duplicated vault blobs, in which case Task 5 plus the codec work is the whole feature.

The report must also count what each guard **excluded**, so a near-miss is visible rather than silently absent.

- [ ] **Step 1: Write the failing test** (real SQLite, real schema shape)

```ts
import { DatabaseSync } from 'node:sqlite'
import { RECLAIM_CANDIDATES_SQL, RECLAIM_SIZES_SQL } from '@/storage/methods/reclaim'

const db = () => {
  const d = new DatabaseSync(':memory:')
  d.exec(`CREATE TABLE transactions (transactionId INTEGER PRIMARY KEY, updated_at TEXT, status TEXT,
    provenTxId INTEGER, txid TEXT, inputBEEF BLOB, rawTx BLOB)`)
  d.exec('CREATE TABLE proven_txs (provenTxId INTEGER PRIMARY KEY, txid TEXT, height INTEGER, rawTx BLOB, merklePath BLOB)')
  d.exec('CREATE TABLE proven_tx_reqs (provenTxReqId INTEGER PRIMARY KEY, txid TEXT, status TEXT, rawTx BLOB, inputBEEF BLOB)')
  d.exec('CREATE TABLE offline_actions (id INTEGER PRIMARY KEY, txid TEXT, status TEXT)')
  return d
}

it('counts reclaimable inputBEEF bytes and reports what was excluded', () => {
  const d = db()
  // Reclaimable: completed, proven, deep enough, no pending req or queued action.
  d.prepare('INSERT INTO proven_txs VALUES (?,?,?,?,?)').run(1, 'aa', 100, new Uint8Array(10), new Uint8Array(10))
  d.prepare(`INSERT INTO transactions (transactionId, updated_at, status, provenTxId, txid, inputBEEF)
    VALUES (?,?,?,?,?,?)`).run(1, '2026-01-01', 'completed', 1, 'aa', new Uint8Array(5000))
  // Excluded: a proven_tx_reqs row that is not completed.
  d.prepare('INSERT INTO proven_txs VALUES (?,?,?,?,?)').run(2, 'bb', 100, new Uint8Array(10), new Uint8Array(10))
  d.prepare(`INSERT INTO transactions (transactionId, updated_at, status, provenTxId, txid, inputBEEF)
    VALUES (?,?,?,?,?,?)`).run(2, '2026-01-01', 'completed', 2, 'bb', new Uint8Array(9000))
  d.prepare('INSERT INTO proven_tx_reqs VALUES (?,?,?,?,?)').run(1, 'bb', 'sending', null, null)

  const rows = d.prepare(RECLAIM_CANDIDATES_SQL).all(1000, '2027-01-01') as { txid: string; bytes: number }[]
  expect(rows.map(r => r.txid)).toEqual(['aa'])
  expect(rows[0].bytes).toBe(5000)
})

it('sums blob bytes per table without loading them', () => {
  const d = db()
  d.prepare('INSERT INTO proven_txs VALUES (?,?,?,?,?)').run(1, 'aa', 1, new Uint8Array(960_000), new Uint8Array(1000))
  const rows = d.prepare(RECLAIM_SIZES_SQL).all() as { table: string; blobBytes: number }[]
  const proven = rows.find(r => r.table === 'proven_txs')!
  expect(proven.blobBytes).toBe(961_000)
})
```

- [ ] **Step 2: Run to verify it fails, implement, verify it passes**

Use `length(inputBEEF)` and `sum(length(col))` — SQLite returns byte length for a BLOB without materialising it.

- [ ] **Step 3: Commit**

```bash
git add storage/methods/reclaim.ts __tests__/storage/reclaim.test.ts storage/StorageExpoSQLite.ts
git commit -m "feat(storage): read-only reclaim report, measured before anything destructive"
```

---

### Task 5: Null `transactions.inputBEEF`, and nothing else

**Files:**
- Modify: `storage/methods/reclaim.ts` (add the UPDATE)
- Modify: `storage/StorageExpoSQLite.ts` (add `reclaimInputBeef()`)
- Modify: `__tests__/storage/reclaim.test.ts`

**Interfaces:**
- Produces: `RECLAIM_INPUT_BEEF_SQL`
- Produces: `reclaimInputBeef(opts: { tipHeight: number; cutoff: string }): Promise<{ rows: number }>`

`transactions.inputBEEF` is the only blob whose clearing is both safe and effective: `getProvenOrRawTx` reads `proven_txs` then `proven_tx_reqs` and never touches it, and `processAction` already declares the intent to clear it after signing. Note the deliberate **absence of any spent-ness term** — nothing reads this column for BEEF, which is precisely why it is the safe target and why the dangerous predicates are unnecessary.

Needs raw `db.runAsync`: `updateTransaction` cannot write NULL, because `sqlUpdate` skips `undefined` values.

- [ ] **Step 1: Write the failing tests**

```ts
it('nulls only the rows the predicate allows', () => { /* as above, then assert */ })

it('keeps inputBEEF for a transaction with a queued offline action', () => { /* ... */ })

it('keeps inputBEEF within the 100-confirmation reorg horizon', () => { /* ... */ })

it('is a no-op on a database with nothing reclaimable', () => { /* ... */ })
```

Each assertion checks the surviving rows by txid, so a predicate that is too broad fails loudly rather than reclaiming more than intended.

- [ ] **Step 2: Run to verify they fail, implement, verify they pass**

```sql
UPDATE transactions SET inputBEEF = NULL, updated_at = :now
WHERE inputBEEF IS NOT NULL
  AND status = 'completed'
  AND provenTxId IS NOT NULL
  AND EXISTS (SELECT 1 FROM proven_txs p
              WHERE p.provenTxId = transactions.provenTxId AND p.height <= :tipHeight - 100)
  AND NOT EXISTS (SELECT 1 FROM proven_tx_reqs r
                  WHERE r.txid = transactions.txid AND r.status <> 'completed')
  AND NOT EXISTS (SELECT 1 FROM offline_actions a
                  WHERE a.txid = transactions.txid AND a.status IN ('queued','posting'))
  AND updated_at < :cutoff
```

- [ ] **Step 3: Commit**

```bash
git add storage/methods/reclaim.ts storage/StorageExpoSQLite.ts __tests__/storage/reclaim.test.ts
git commit -m "feat(storage): reclaim inputBEEF from settled transactions"
```

---

### Task 6: Surface it

**Files:**
- Modify: `app/wallet-config.tsx` (a Storage row in Data & Security)
- Modify: `context/i18n/translations.tsx` (12 locales)

**Interfaces:**
- Consumes: `reclaimReport`, `reclaimInputBeef`, `availableDiskBytes`.

Shows the database size and free space, and offers the reclaim as an explicit action with a confirmation naming what it removes. `showAlert`, not `showToast` — storage-full can cost a signed transaction, which is a decision, and Toast auto-dismisses in two seconds.

**Not wired to the low-disk trigger**, deliberately: on a nearly full volume the UPDATE's own rollback journal can fail with `SQLITE_FULL`, and with no WAL and no `auto_vacuum` the file will not shrink afterwards, so the user would see either a failed reclaim or a successful one that freed nothing visible. The copy must not promise recovered space.

- [ ] **Step 1: Add the row, the copy in 12 locales, verify, commit**

```bash
npx tsc --noEmit && npx jest && npx eslint app storage utils
git add app/wallet-config.tsx context/i18n/translations.tsx
git commit -m "feat(settings): show storage use and offer an explicit reclaim"
```

---

## Self-review

**Spec coverage (Part 3):** typed errors and the classifier → Task 1; the probe and thresholds → Task 2; the write choke point → Task 3; E1 report → Task 4; E2 `inputBEEF` nuller → Task 5; surfacing → Task 6.

**Deferred from §6 with reason:** `PRAGMA auto_vacuum = INCREMENTAL` needs to be set at database creation to have any effect, so on an existing database it is a `VACUUM` requiring free space roughly equal to the database size — exactly what is unavailable when it would be wanted. It needs its own device testing and belongs in its own change. E3 (`proven_txs.rawTx` nulling) is deliberately not implemented at all. Bounding the offline queue's attempts/expiry is a real gap named in §6 but is about the queue's own lifecycle rather than disk pressure, and belongs with the localpay follow-up.

**Type consistency:** `StorageError`, `StorageErrorCode`, `storageErrorFromSqlite` in `storage/errors.ts`; `availableDiskBytes`, `diskPressure`, `DISK_WARN_BYTES`, `DISK_BLOCK_BYTES` in `utils/diskSpace.ts`; `RECLAIM_CANDIDATES_SQL`, `RECLAIM_SIZES_SQL`, `RECLAIM_INPUT_BEEF_SQL`, `ReclaimReport` in `storage/methods/reclaim.ts`; `reclaimReport()`, `reclaimInputBeef()` on `StorageExpoSQLite`.
