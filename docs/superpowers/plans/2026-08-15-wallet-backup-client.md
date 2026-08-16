# Wallet Backup Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Continuously push the wallet database to the backup log as encrypted delta chunks, and restore a wallet from that log given only a mnemonic or recovery shares.

**Architecture:** A backup-only identity is derived from the wallet's `primaryKey`; it serves as both the AuthFetch peer identity (so the server sees a pseudonym, never the real identity key) and the encryption key (`counterparty: 'self'`, so the server cannot decrypt). Pushes run as a monitor task that reads delta `SyncChunk`s directly from the local storage provider, bypassing `WalletStorageManager` and its sync lock. Restore implements the two-method `WalletStorageSyncReader` interface and hands it to `syncFromReader`.

**Tech Stack:** TypeScript, React Native / Expo, `@bsv/sdk` **2.4.0**, `@bsv/wallet-toolbox-mobile` 2.4.3, expo-sqlite, AsyncStorage, Jest.

## Global Constraints

- **Blocked on the `@bsv/sdk` 2.4.0 upgrade plan.** Raw binary upload is impossible on 2.1.9, and there is no fallback path in this design.
- Derive the backup key from **`primaryKey` (`m/0'/0'`)**, never `rootKey`. Share-restored wallets only ever recover `primaryKey`; deriving from `rootKey` would lock exactly the cohort this feature most helps out of their own backups.
- `BACKUP_PROTOCOL` and `BACKUP_KEY_ID` are **frozen constants**. Restore has only the seed, so any per-install, per-device, or random component makes the pseudonym unrecoverable and the backup permanently dead.
- Encrypt with `counterparty: 'self'`. That single value is the entire zero-knowledge property.
- Never call `WalletStorageManager.updateBackups` / `syncToWriter` — they take the manager's sync lock via `runAsSync` and block all storage reads and writes, against the standing no->100ms-JS-block goal.
- Monitor tasks run back-to-back **with no yielding**. All work defers via `InteractionManager` and is rate-limited.
- The UI must never present the backup log as a substitute for the mnemonic. It is worthless without the seed or shares, and implying otherwise would make users keep their paper backup less carefully.

---

## File Structure

| File | Responsibility |
|---|---|
| `utils/backup/constants.ts` | Frozen protocol/keyID, chunk sizing, generation threshold |
| `utils/backup/derive.ts` | `deriveBackupWallet`, `backupPseudonym` |
| `utils/backup/deviceId.ts` | Per-install device id in AsyncStorage |
| `utils/backup/codec.ts` | Chunk ⇄ ciphertext |
| `utils/backup/client.ts` | `BackupClient` over `AuthFetch` |
| `utils/backup/cursor.ts` | Push cursor persistence |
| `utils/backup/push.ts` | One push pass, pure and testable |
| `utils/monitor/TaskBackupPush.ts` | Monitor task wrapper |
| `utils/backup/RemoteSyncReader.ts` | `WalletStorageSyncReader` for restore |
| `utils/backup/restore.ts` | Restore orchestration |
| `context/config.tsx` | `DEFAULT_BACKUP_URL` |
| `context/WalletContext.tsx` | Task registration |
| `app/settings.tsx` | Toggle + disclosure |

---

### Task 1: Frozen derivation constants and the backup identity

**Files:**
- Create: `utils/backup/constants.ts`, `utils/backup/derive.ts`
- Test: `__tests__/backupDerive.test.ts`

**Interfaces:**
- Consumes: `@bsv/sdk` 2.4.0
- Produces: `deriveBackupWallet(primaryKey: number[]): CompletedProtoWallet`, `backupPseudonym(primaryKey: number[]): string` (66-char compressed hex), `BACKUP_PROTOCOL: WalletProtocol`, `BACKUP_KEY_ID: string`.

- [ ] **Step 1: Write the failing test**

The frozen-vector test is the most important test in this plan. If derivation ever
changes, every existing backup is orphaned with no error message.

```ts
import { PrivateKey } from '@bsv/sdk'
import { backupPseudonym, deriveBackupWallet } from '@/utils/backup/derive'

// A fixed, well-known test key. Not funded, never used on mainnet.
const TEST_PRIMARY = new PrivateKey(1).toArray('be', 32)

describe('backup key derivation', () => {
  it('is deterministic for a given primaryKey', () => {
    expect(backupPseudonym(TEST_PRIMARY)).toBe(backupPseudonym(TEST_PRIMARY))
  })

  it('produces a 66-char compressed pubkey hex', () => {
    const p = backupPseudonym(TEST_PRIMARY)
    expect(p).toMatch(/^0[23][0-9a-f]{64}$/)
  })

  it('differs from the wallet identity key', () => {
    // The whole privacy property: the server must never see the real identity key.
    const identity = new PrivateKey(TEST_PRIMARY).toPublicKey().toString()
    expect(backupPseudonym(TEST_PRIMARY)).not.toBe(identity)
  })

  it('differs for a different primaryKey', () => {
    const other = new PrivateKey(2).toArray('be', 32)
    expect(backupPseudonym(TEST_PRIMARY)).not.toBe(backupPseudonym(other))
  })

  it('MATCHES THE FROZEN VECTOR', () => {
    // Precomputed and verified identical on @bsv/sdk 2.1.9 and 2.4.0. NEVER change this
    // value. A diff here means every backup already written by a shipped build has been
    // orphaned, with no error surfaced to the user.
    expect(backupPseudonym(TEST_PRIMARY))
      .toBe('03d7a8c57df91ccdc3704f2cc546b0c19b2dcfab5d3e0a438d2a8ae6cd3d3618b5')
  })

  it('round-trips encryption with counterparty self', async () => {
    const w = deriveBackupWallet(TEST_PRIMARY)
    const plaintext = [1, 2, 3, 4, 5]
    const { ciphertext } = await w.encrypt({
      plaintext, protocolID: BACKUP_PROTOCOL, keyID: BACKUP_KEY_ID, counterparty: 'self',
    })
    const { plaintext: out } = await w.decrypt({
      ciphertext, protocolID: BACKUP_PROTOCOL, keyID: BACKUP_KEY_ID, counterparty: 'self',
    })
    expect(out).toEqual(plaintext)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx jest __tests__/backupDerive.test.ts -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the constants**

```ts
// utils/backup/constants.ts
import type { WalletProtocol } from '@bsv/sdk'

/**
 * FROZEN. Restore has only the user's seed, so these values must never vary by install,
 * device, build, or randomness. Changing either constant orphans every backup ever
 * written. Protocol names are validated at runtime: 5-400 chars, /^[a-z0-9 ]+$/, no
 * double spaces, must not end in " protocol".
 *
 * NOTE: in TypeScript WalletProtocol is a TUPLE [SecurityLevel, string], not the
 * {securityLevel, protocol} struct the Go SDK uses.
 */
export const BACKUP_PROTOCOL: WalletProtocol = [2, 'wallet backup log']
export const BACKUP_KEY_ID = '1'

/** Well under the server's 1 MiB cap once encrypted. */
export const MAX_ROUGH_SIZE = 512_000
export const MAX_ITEMS = 200

/** Start a fresh full snapshot once a generation exceeds this many chunks. */
export const GENERATION_CHUNK_THRESHOLD = 200

/** Floor between push passes; the monitor loop ticks roughly every 5s. */
export const MIN_PUSH_INTERVAL_MS = 60_000
```

- [ ] **Step 4: Implement the derivation**

```ts
// utils/backup/derive.ts
import { CompletedProtoWallet, KeyDeriver, PrivateKey } from '@bsv/sdk'
import { BACKUP_KEY_ID, BACKUP_PROTOCOL } from './constants'

/**
 * Derive the backup-only identity from the wallet's primary key (m/0'/0').
 *
 * primaryKey, NOT rootKey: a wallet restored from printed backup shares recovers only
 * the m/0'/0' WIF and has no rootKey. Deriving from rootKey would leave exactly that
 * cohort unable to decrypt their own backups.
 *
 * The returned wallet is used for BOTH the AuthFetch peer identity and blob encryption,
 * so the backup subsystem never touches the permissioned main wallet and cannot trigger
 * protocol-permission or spending-authorisation prompts.
 */
export function deriveBackupWallet (primaryKey: number[]): CompletedProtoWallet {
  const deriver = new KeyDeriver(new PrivateKey(primaryKey))
  return new CompletedProtoWallet(
    deriver.derivePrivateKey(BACKUP_PROTOCOL, BACKUP_KEY_ID, 'self')
  )
}

/** The server-visible account address. Never the wallet's real identity key. */
export function backupPseudonym (primaryKey: number[]): string {
  const deriver = new KeyDeriver(new PrivateKey(primaryKey))
  return deriver
    .derivePrivateKey(BACKUP_PROTOCOL, BACKUP_KEY_ID, 'self')
    .toPublicKey()
    .toString()
}
```

- [ ] **Step 5: Run and confirm the frozen vector matches**

```bash
npx jest __tests__/backupDerive.test.ts -v
```

Expected: all green, including the frozen-vector assertion.

If the frozen-vector test fails, **do not update the expected value.** The constant was
precomputed against both 2.1.9 and 2.4.0 and is correct. A failure means the derivation in
`derive.ts` does not match the spec — most likely the protocol tuple, the keyID, or the
counterparty. Fix the implementation.

- [ ] **Step 6: Commit**

```bash
git add utils/backup/constants.ts utils/backup/derive.ts __tests__/backupDerive.test.ts
git commit -m "feat(backup): frozen backup identity derived from primaryKey"
```

---

### Task 2: Chunk codec

**Files:**
- Create: `utils/backup/codec.ts`
- Test: `__tests__/backupCodec.test.ts`

**Interfaces:**
- Consumes: `deriveBackupWallet`, `@bsv/wallet-toolbox-mobile` `BinaryJson`
- Produces: `encodeChunk(wallet, chunk): Promise<number[]>`, `decodeChunk(wallet, ciphertext): Promise<SyncChunk>`

- [ ] **Step 1: Write the failing test**

```ts
import type { SyncChunk } from '@bsv/wallet-toolbox-mobile'
import { decodeChunk, encodeChunk } from '@/utils/backup/codec'
import { deriveBackupWallet } from '@/utils/backup/derive'
import { PrivateKey } from '@bsv/sdk'

const KEY = new PrivateKey(7).toArray('be', 32)

function chunkWithBinary (): SyncChunk {
  return {
    fromStorageIdentityKey: 'a', toStorageIdentityKey: 'b', userIdentityKey: 'c',
    provenTxs: [{
      provenTxId: 1, txid: 'deadbeef', height: 800000, index: 0,
      // number[] fields are the ones BinaryJson base64-tags. Include a full byte range.
      merklePath: [0, 1, 127, 128, 255],
      rawTx: [1, 2, 3, 250, 251, 252, 253, 254, 255],
      blockHash: 'x', created_at: new Date(0), updated_at: new Date(0),
    }],
    provenTxReqs: [], outputBaskets: [], txLabels: [], outputTags: [],
    transactions: [], txLabelMaps: [], commissions: [], outputs: [],
    outputTagMaps: [], certificates: [], certificateFields: [],
  } as unknown as SyncChunk
}

describe('backup chunk codec', () => {
  it('round-trips binary fields byte-exactly', async () => {
    const w = deriveBackupWallet(KEY)
    const decoded = await decodeChunk(w, await encodeChunk(w, chunkWithBinary()))
    expect(decoded.provenTxs?.[0].rawTx).toEqual([1, 2, 3, 250, 251, 252, 253, 254, 255])
    expect(decoded.provenTxs?.[0].merklePath).toEqual([0, 1, 127, 128, 255])
  })

  it('preserves empty arrays rather than dropping them', async () => {
    // The TS sync consumer infinite-loops on an undefined entity array, so all 12 must
    // survive the round trip as arrays.
    const w = deriveBackupWallet(KEY)
    const decoded = await decodeChunk(w, await encodeChunk(w, chunkWithBinary()))
    expect(Array.isArray(decoded.outputs)).toBe(true)
    expect(Array.isArray(decoded.certificateFields)).toBe(true)
  })

  it('produces ciphertext a different key cannot read', async () => {
    const mine = deriveBackupWallet(KEY)
    const theirs = deriveBackupWallet(new PrivateKey(8).toArray('be', 32))
    const ct = await encodeChunk(mine, chunkWithBinary())
    await expect(decodeChunk(theirs, ct)).rejects.toThrow()
  })

  it('does not leak plaintext into the ciphertext', async () => {
    const w = deriveBackupWallet(KEY)
    const ct = await encodeChunk(w, chunkWithBinary())
    expect(Buffer.from(ct).toString('utf8')).not.toContain('deadbeef')
  })
})
```

- [ ] **Step 2: Run it**

Run: `npx jest __tests__/backupCodec.test.ts -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the codec**

```ts
// utils/backup/codec.ts
import type { CompletedProtoWallet } from '@bsv/sdk'
import { Utils } from '@bsv/sdk'
import type { SyncChunk } from '@bsv/wallet-toolbox-mobile'
import {
  parseJsonRpc, stringifyJsonRpc,
} from '@bsv/wallet-toolbox-mobile/out/src/storage/remoting/BinaryJson'
import { BACKUP_KEY_ID, BACKUP_PROTOCOL } from './constants'

/**
 * Serialise with the toolbox's own binary-aware JSON so number[] fields (rawTx,
 * inputBEEF, merklePath) are base64-tagged rather than expanded to ~4x as decimal
 * arrays, then encrypt.
 *
 * counterparty 'self' is load-bearing: it makes the ciphertext undecryptable by anyone
 * but this key, including the server that stores it.
 */
export async function encodeChunk (wallet: CompletedProtoWallet, chunk: SyncChunk): Promise<number[]> {
  const json = stringifyJsonRpc(chunk, true)
  const { ciphertext } = await wallet.encrypt({
    plaintext: Utils.toArray(json, 'utf8'),
    protocolID: BACKUP_PROTOCOL,
    keyID: BACKUP_KEY_ID,
    counterparty: 'self',
  })
  return ciphertext
}

export async function decodeChunk (wallet: CompletedProtoWallet, ciphertext: number[]): Promise<SyncChunk> {
  const { plaintext } = await wallet.decrypt({
    ciphertext,
    protocolID: BACKUP_PROTOCOL,
    keyID: BACKUP_KEY_ID,
    counterparty: 'self',
  })
  return parseJsonRpc(Utils.toUTF8(plaintext), true) as SyncChunk
}
```

- [ ] **Step 4: Run the tests**

Run: `npx jest __tests__/backupCodec.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add utils/backup/codec.ts __tests__/backupCodec.test.ts
git commit -m "feat(backup): binary-safe encrypted chunk codec"
```

---

### Task 3: Backup HTTP client

**Files:**
- Create: `utils/backup/client.ts`, `utils/backup/deviceId.ts`
- Modify: `context/config.tsx`
- Test: `__tests__/backupClient.test.ts`

**Interfaces:**
- Consumes: `deriveBackupWallet`
- Produces:

```ts
export interface LogEntry { seq: number, sha256: string, prevSha256?: string, size: number, createdAt: string }
export interface DeviceSummary { deviceId: string, generation: number, headSeq: number, headSha256: string, totalBytes: number, updatedAt: string }

export class BackupClient {
  constructor (baseUrl: string, primaryKey: number[])
  append (deviceId: string, generation: number, seq: number, prevSha256: string | undefined, ciphertext: number[]): Promise<{ seq: number, sha256: string }>
  index (deviceId: string, generation: number, from?: number): Promise<LogEntry[]>
  blob (deviceId: string, generation: number, seq: number): Promise<number[]>
  manifest (): Promise<DeviceSummary[]>
  pruneGeneration (deviceId: string, generation: number): Promise<void>
}
export function getDeviceId (): Promise<string>   // 32 lowercase hex, persisted per install
```

- [ ] **Step 1: Add the config entry**

In `context/config.tsx`, alongside `DEFAULT_MESSAGEBOX_URL`:

```ts
export const DEFAULT_BACKUP_URL = 'https://backup.bsvb.tech'
```

`DEFAULT_STORAGE_URL` stays `'local'` — the backup service is deliberately not a storage
provider.

- [ ] **Step 2: Write the failing client test**

```ts
import { BackupClient } from '@/utils/backup/client'
import { PrivateKey } from '@bsv/sdk'

const KEY = new PrivateKey(9).toArray('be', 32)
const DEVICE = 'a'.repeat(32)

describe('BackupClient', () => {
  it('posts raw octet-stream, not JSON', async () => {
    const calls: Array<{ url: string, init: RequestInit }> = []
    const client = new BackupClient('https://example.test', KEY, async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ status: 'success', seq: 1, sha256: 'ab' }), { status: 201 })
    })

    await client.append(DEVICE, 1, 1, undefined, [1, 2, 3])

    expect(calls[0].init.headers).toMatchObject({ 'Content-Type': 'application/octet-stream' })
    expect(calls[0].init.body).toBeInstanceOf(Uint8Array)
    expect(calls[0].url).toContain('seq=1')
    expect(calls[0].url).toContain('generation=1')
  })

  it('never sends an identity parameter', async () => {
    // The server derives the account from auth alone. Sending an identity would invite
    // exactly the cross-tenant bug this design exists to avoid.
    const calls: string[] = []
    const client = new BackupClient('https://example.test', KEY, async (url) => {
      calls.push(url)
      return new Response(JSON.stringify({ status: 'success', devices: [] }), { status: 200 })
    })
    await client.manifest()
    expect(calls[0]).not.toMatch(/identity|pseudonym|pubkey/i)
  })

  it('surfaces a 409 as a sequence conflict', async () => {
    const client = new BackupClient('https://example.test', KEY, async () =>
      new Response(JSON.stringify({ status: 'error', code: 'ERR_SEQ_CONFLICT' }), { status: 409 }))
    await expect(client.append(DEVICE, 1, 5, undefined, [1])).rejects.toThrow(/ERR_SEQ_CONFLICT/)
  })

  it('returns blob bytes as number[]', async () => {
    const client = new BackupClient('https://example.test', KEY, async () =>
      new Response(new Uint8Array([9, 8, 7]), { status: 200 }))
    expect(await client.blob(DEVICE, 1, 1)).toEqual([9, 8, 7])
  })
})
```

- [ ] **Step 3: Run it**

Run: `npx jest __tests__/backupClient.test.ts -v`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the client and device id**

`BackupClient` takes an injectable fetch (defaulting to `new AuthFetch(deriveBackupWallet(primaryKey)).fetch`) so tests need no network. `getDeviceId` reads
`backupDeviceId` from AsyncStorage, generating 16 random bytes as 32 lowercase hex on
first use.

- [ ] **Step 5: Run the tests**

Run: `npx jest __tests__/backupClient.test.ts -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add utils/backup/client.ts utils/backup/deviceId.ts context/config.tsx __tests__/backupClient.test.ts
git commit -m "feat(backup): AuthFetch-backed backup log client"
```

---

### Task 4: Push pass and cursor

**Files:**
- Create: `utils/backup/cursor.ts`, `utils/backup/push.ts`
- Test: `__tests__/backupPush.test.ts`

**Interfaces:**
- Consumes: `BackupClient`, `encodeChunk`, `StorageExpoSQLite`
- Produces:

```ts
export interface PushCursor {
  since?: string          // ISO; max updated_at consumed so far
  offsets: Array<{ name: string, offset: number }>
  generation: number
  seq: number
  prevSha256?: string
  chunksInGeneration: number
}
export function loadCursor (pseudonym: string, deviceId: string): Promise<PushCursor>
export function saveCursor (pseudonym: string, deviceId: string, c: PushCursor): Promise<void>

export interface PushDeps {
  storage: StorageExpoSQLite
  primaryKey: number[]
  /** Supply exactly one. `baseUrl` constructs a real BackupClient; `client` injects one
   *  (tests and the round-trip harness use a fake server through this seam). */
  baseUrl?: string
  client?: BackupClient
  deviceId?: string           // defaults to getDeviceId()
}

export function pushOnce (deps: PushDeps): Promise<{ pushed: number, bytes: number, rotated: boolean }>
```

`pushOnce` resolves `client ?? new BackupClient(baseUrl!, primaryKey)` and throws if
neither is supplied. Task 5 passes `baseUrl`; Task 7 passes `client`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('pushOnce', () => {
  it('does nothing when every entity array is empty', async () => {
    const append = jest.fn()
    const result = await pushOnce(deps({ chunk: emptyChunk(), append }))
    expect(append).not.toHaveBeenCalled()
    expect(result.pushed).toBe(0)
  })

  it('calls getSyncChunk directly on the storage provider', async () => {
    // Never via WalletStorageManager: updateBackups/syncToWriter take the sync lock and
    // block all storage reads and writes for the duration.
    const getSyncChunk = jest.fn().mockResolvedValue(chunkWithOneTx())
    await pushOnce(deps({ getSyncChunk }))
    expect(getSyncChunk).toHaveBeenCalledWith(expect.objectContaining({
      maxRoughSize: 512_000, maxItems: 200,
    }))
  })

  it('advances the cursor only after a successful append', async () => {
    const saveCursor = jest.fn()
    const append = jest.fn().mockRejectedValue(new Error('network down'))
    await expect(pushOnce(deps({ chunk: chunkWithOneTx(), append, saveCursor }))).rejects.toThrow()
    expect(saveCursor).not.toHaveBeenCalled()
  })

  it('chains prevSha256 from the previous append', async () => {
    const append = jest.fn().mockResolvedValue({ seq: 2, sha256: 'newsha' })
    const saveCursor = jest.fn()
    await pushOnce(deps({
      chunk: chunkWithOneTx(), append, saveCursor,
      cursor: { seq: 1, generation: 1, prevSha256: 'oldsha', offsets: [], chunksInGeneration: 1 },
    }))
    expect(append).toHaveBeenCalledWith(expect.anything(), 1, 2, 'oldsha', expect.anything())
    expect(saveCursor).toHaveBeenCalledWith(expect.anything(), expect.anything(),
      expect.objectContaining({ prevSha256: 'newsha', seq: 2 }))
  })

  it('rotates to a new generation past the threshold', async () => {
    // A fresh full snapshot (since undefined) starts generation N+1, bounding both
    // server storage and restore time.
    const result = await pushOnce(deps({
      chunk: chunkWithOneTx(),
      cursor: { seq: 200, generation: 1, offsets: [], chunksInGeneration: 200, since: '2026-01-01T00:00:00Z' },
    }))
    expect(result.rotated).toBe(true)
  })

  it('restarts the generation from seq 1 with no since filter', async () => {
    const getSyncChunk = jest.fn().mockResolvedValue(chunkWithOneTx())
    const append = jest.fn().mockResolvedValue({ seq: 1, sha256: 'x' })
    await pushOnce(deps({
      getSyncChunk, append,
      cursor: { seq: 200, generation: 1, offsets: [], chunksInGeneration: 200, since: '2026-01-01T00:00:00Z' },
    }))
    expect(getSyncChunk).toHaveBeenCalledWith(expect.objectContaining({ since: undefined }))
    expect(append).toHaveBeenCalledWith(expect.anything(), 2, 1, undefined, expect.anything())
  })
})
```

- [ ] **Step 2: Run them**

Run: `npx jest __tests__/backupPush.test.ts -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement cursor and push**

`pushOnce` reads the cursor, decides whether to rotate generation, calls
`storage.getSyncChunk` directly, returns early if all 12 entity arrays are empty, encodes,
appends, then persists the advanced cursor. On `ERR_SEQ_CONFLICT` it re-reads the server
index and resynchronises the cursor rather than looping.

- [ ] **Step 4: Run the tests**

Run: `npx jest __tests__/backupPush.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add utils/backup/cursor.ts utils/backup/push.ts __tests__/backupPush.test.ts
git commit -m "feat(backup): delta push pass with generation rotation"
```

---

### Task 5: Monitor task

**Files:**
- Create: `utils/monitor/TaskBackupPush.ts`
- Modify: `context/WalletContext.tsx` (registration beside `TaskSendOffline`)
- Test: `__tests__/backupTask.test.ts`

**Interfaces:**
- Consumes: `pushOnce`
- Produces: `TaskBackupPush extends WalletMonitorTask` with static `noteConnectivity(online)`, `noteChanged()`, `requestNow()`.

Follow `utils/monitor/TaskSendOffline.ts`: all state is static and process-global by
design, because the monitor is torn down and rebuilt on network switches and wallet
rebuilds and the push cadence must survive that.

- [ ] **Step 1: Write the failing test**

```ts
describe('TaskBackupPush', () => {
  beforeEach(() => { TaskBackupPush.reset() })

  it('does not trigger while offline', () => {
    TaskBackupPush.noteConnectivity(false)
    TaskBackupPush.noteChanged()
    expect(new TaskBackupPush(monitor, jest.fn()).trigger(Date.now()).run).toBe(false)
  })

  it('triggers when online and the database changed', () => {
    TaskBackupPush.noteConnectivity(true)
    TaskBackupPush.noteChanged()
    expect(new TaskBackupPush(monitor, jest.fn()).trigger(Date.now()).run).toBe(true)
  })

  it('respects the minimum interval between passes', () => {
    // The monitor loop ticks roughly every 5s with no yielding between tasks; pushing
    // that often would burn battery and block the JS thread.
    TaskBackupPush.noteConnectivity(true)
    TaskBackupPush.noteChanged()
    const task = new TaskBackupPush(monitor, jest.fn())
    const now = Date.now()
    expect(task.trigger(now).run).toBe(true)
    TaskBackupPush.noteRan(now)
    TaskBackupPush.noteChanged()
    expect(task.trigger(now + 5_000).run).toBe(false)
    expect(task.trigger(now + 61_000).run).toBe(true)
  })

  it('backs off after a failure', () => {
    TaskBackupPush.noteConnectivity(true)
    TaskBackupPush.noteFailure(Date.now())
    expect(TaskBackupPush.backoffMs).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run it**

Run: `npx jest __tests__/backupTask.test.ts -v`
Expected: FAIL

- [ ] **Step 3: Implement the task**

Wrap the `pushOnce` call in `InteractionManager.runAfterInteractions` so encryption and
HTTP never run inside the non-yielding monitor tick.

- [ ] **Step 4: Register it in WalletContext**

Beside the existing `TaskSendOffline` registration, inside the same `if (phoneStorage)`
block, before `monitor.addDefaultTasks()`. Registration order is load-bearing.

```ts
if (phoneStorage) {
  monitor.addTask(
    new TaskBackupPush(monitor, async () => {
      return await pushOnce({
        storage: phoneStorage!,
        primaryKey,
        baseUrl: selectedBackupUrl,
      })
    })
  )
  TaskBackupPush.noteChanged()  // pessimistic: one idle pass clears it
}
```

- [ ] **Step 5: Run the tests**

Run: `npx jest __tests__/backupTask.test.ts -v && npx tsc --noEmit`
Expected: PASS and clean.

- [ ] **Step 6: Commit**

```bash
git add utils/monitor/TaskBackupPush.ts context/WalletContext.tsx __tests__/backupTask.test.ts
git commit -m "feat(backup): monitor task driving delta pushes"
```

---

### Task 6: Restore reader and orchestration

**Files:**
- Create: `utils/backup/RemoteSyncReader.ts`, `utils/backup/restore.ts`
- Test: `__tests__/backupRestore.test.ts`

**Interfaces:**
- Consumes: `BackupClient`, `decodeChunk`
- Produces:

```ts
export class RemoteSyncReader implements WalletStorageSyncReader {
  constructor (
    client: BackupClient,
    wallet: CompletedProtoWallet,
    deviceId: string,
    generation: number,
    settings: TableSettings,
  )
  makeAvailable (): Promise<TableSettings>
  getSyncChunk (args: RequestSyncChunkArgs): Promise<SyncChunk>
}

export interface RestoreDeps {
  storage: StorageExpoSQLite
  primaryKey: number[]
  baseUrl?: string            // same one-of rule as PushDeps
  client?: BackupClient
  deviceId?: string           // defaults to the newest device in the manifest
}

export function restoreFromBackup (deps: RestoreDeps): Promise<{ chunks: number }>
```

`WalletStorageSyncReader` is only two methods — `makeAvailable()` and `getSyncChunk(args)` —
and that is the entire restore contract.

- [ ] **Step 1: Write the failing test**

```ts
describe('RemoteSyncReader', () => {
  it('returns chunks in sequence order', async () => {
    const reader = new RemoteSyncReader(fakeClient([blobA, blobB]), wallet, 'dev', 1, settings)
    expect((await reader.getSyncChunk(args)).provenTxs?.[0].txid).toBe('a')
    expect((await reader.getSyncChunk(args)).provenTxs?.[0].txid).toBe('b')
  })

  it('signals completion with an all-empty chunk', async () => {
    // The toolbox treats an empty chunk as the completion sentinel.
    const reader = new RemoteSyncReader(fakeClient([blobA]), wallet, 'dev', 1, settings)
    await reader.getSyncChunk(args)
    const done = await reader.getSyncChunk(args)
    expect(done.provenTxs).toEqual([])
    expect(done.outputs).toEqual([])
  })

  it('refuses a broken prevSha256 chain', async () => {
    // A gap or a fork means the restore would be silently incomplete, which is worse
    // than failing loudly.
    const reader = new RemoteSyncReader(fakeClientWithBrokenChain(), wallet, 'dev', 1, settings)
    await expect(reader.getSyncChunk(args)).rejects.toThrow(/chain/i)
  })
})
```

- [ ] **Step 2: Run it**

Run: `npx jest __tests__/backupRestore.test.ts -v`
Expected: FAIL

- [ ] **Step 3: Implement the reader**

`getSyncChunk` fetches the next blob by sequence, verifies `sha256` and the `prevSha256`
chain, decrypts, and returns the parsed chunk. When the sequence is exhausted it returns a
chunk with all 12 arrays present and empty.

- [ ] **Step 4: Implement restore orchestration**

`restoreFromBackup` derives the pseudonym from the recovered `primaryKey`, fetches the
manifest, selects the device and newest complete generation, then calls
`WalletStorageManager.syncFromReader(identityKey, reader)`.

- [ ] **Step 5: Run the tests**

Run: `npx jest __tests__/backupRestore.test.ts -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add utils/backup/RemoteSyncReader.ts utils/backup/restore.ts __tests__/backupRestore.test.ts
git commit -m "feat(backup): restore via WalletStorageSyncReader"
```

---

### Task 7: End-to-end round trip — the test that proves the feature

**Files:**
- Test: `__tests__/backupRoundTrip.test.ts`

**Interfaces:**
- Consumes: everything above

Nothing else in this plan proves the feature works. It also covers a code path that has
**never executed in this app**: `StorageExpoSQLite.processSyncChunk` is a pass-through
whose comment implies it was never exercised, and zero tests cover sync anywhere in the
repo. Treat any failure here as a real defect in the sync layer, not in the test.

- [ ] **Step 1: Write the round-trip test**

```ts
describe('backup round trip', () => {
  it('restores outputs and actions into a fresh database', async () => {
    const primaryKey = new PrivateKey(11).toArray('be', 32)

    // 1. Seed a wallet database with real transactions and outputs.
    const source = await makeTestStorage('source.db')
    await seedWallet(source, { transactions: 5, outputs: 12 })
    const before = await source.listOutputs({ basket: 'default' })

    // 2. Push every chunk into an in-memory fake server.
    const server = new FakeBackupServer()
    let guard = 0
    while (guard++ < 100) {
      const r = await pushOnce({ storage: source, primaryKey, client: server.client() })
      if (r.pushed === 0) break
    }
    expect(server.blobCount()).toBeGreaterThan(0)

    // 3. Restore into a brand-new database.
    const target = await makeTestStorage('target.db')
    await restoreFromBackup({ storage: target, primaryKey, client: server.client() })

    // 4. The restored wallet must be able to spend: same outputs, same derivation data.
    const after = await target.listOutputs({ basket: 'default' })
    expect(after.outputs).toHaveLength(before.outputs.length)
    expect(after.outputs.map(o => o.outpoint).sort())
      .toEqual(before.outputs.map(o => o.outpoint).sort())
  })

  it('preserves BRC-29 derivation metadata exactly', async () => {
    // This is the metadata that exists ONLY in the database and without which an output
    // cannot be spent. It is the entire reason this feature exists.
    const primaryKey = new PrivateKey(12).toArray('be', 32)
    const source = await makeTestStorage('src2.db')
    await seedBrc29Receipt(source, {
      senderIdentityKey: '02' + 'ab'.repeat(32),
      derivationPrefix: 'cHJlZml4',
      derivationSuffix: 'c3VmZml4',
    })

    const server = new FakeBackupServer()
    await drainPush(source, primaryKey, server)

    const target = await makeTestStorage('tgt2.db')
    await restoreFromBackup({ storage: target, primaryKey, client: server.client() })

    const [out] = (await target.listOutputs({ basket: 'default', include: 'entire transactions' })).outputs
    expect(out.derivationPrefix).toBe('cHJlZml4')
    expect(out.derivationSuffix).toBe('c3VmZml4')
    expect(out.senderIdentityKey).toBe('02' + 'ab'.repeat(32))
  })

  it('restores from a share-recovered primaryKey', async () => {
    // Share-restored wallets have no mnemonic and no rootKey. If derivation had used
    // rootKey, this test would fail and that cohort would be silently locked out.
    const primaryKey = new PrivateKey(13).toArray('be', 32)
    const source = await makeTestStorage('src3.db')
    await seedWallet(source, { transactions: 2, outputs: 3 })

    const server = new FakeBackupServer()
    await drainPush(source, primaryKey, server)

    const shares = new PrivateKey(primaryKey).toBackupShares(2, 3)
    const recovered = PrivateKey.fromBackupShares([shares[0], shares[2]]).toArray()
    expect(recovered).toEqual(primaryKey)

    const target = await makeTestStorage('tgt3.db')
    await restoreFromBackup({ storage: target, primaryKey: recovered, client: server.client() })
    expect((await target.listOutputs({ basket: 'default' })).outputs).toHaveLength(3)
  })
})
```

- [ ] **Step 2: Run it**

Run: `npx jest __tests__/backupRoundTrip.test.ts -v`
Expected: PASS. If `processSyncChunk` proves to be a genuine stub, fix the storage layer —
do not weaken the test.

- [ ] **Step 3: Commit**

```bash
git add __tests__/backupRoundTrip.test.ts
git commit -m "test(backup): end-to-end push and restore round trip"
```

---

### Task 8: Settings, disclosure and restore UI

**Files:**
- Modify: `app/settings.tsx`, `app/auth/scan-shares.tsx`, `app/auth/mnemonic.tsx`
- Modify: `context/i18n/translations.tsx`

**Interfaces:**
- Consumes: `restoreFromBackup`, `BackupClient`

Backup is **on by default**; opt-in would reproduce the very problem this solves. That
default means sending an encrypted wallet database to a BSVA-operated server without being
asked, which requires honesty rather than silence.

- [ ] **Step 1: Add the settings row**

A toggle plus copy stating: what is sent, that it is encrypted with a key only their seed
can derive, and that the operator cannot read it. Turning it off stops pushing and offers
to delete the log.

- [ ] **Step 2: Add the restore step to the recovery flows**

After a successful mnemonic entry or share scan, check the manifest and offer to restore.
If a backup exists, restoring is the default action.

- [ ] **Step 3: Write the disclosure copy**

Never imply the backup replaces the mnemonic. Wording along these lines:

> Your wallet history is backed up, encrypted, so you can recover it on a new device.
> **You still need your recovery phrase or printed shares** — without them the backup
> cannot be unlocked, by us or by anyone else.

The warning is the important half. If users believe the cloud backup replaces their paper
backup they will guard the paper less carefully and end up worse off than before this
feature existed.

- [ ] **Step 4: Add translations**

Add the new keys to `context/i18n/translations.tsx` for all supported languages.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add app context
git commit -m "feat(backup): settings toggle, disclosure copy and restore flow"
```

---

### Task 9: Device verification

**Files:** none modified

- [ ] **Step 1: Run against the real server**

Point `DEFAULT_BACKUP_URL` at a running instance from the server plan and build:

```bash
npm run ios-dev-device
```

- [ ] **Step 2: Confirm pushes happen**

Send a payment, then check the server index. Expected: a new chunk within a minute, and no
visible UI jank while it uploads.

- [ ] **Step 3: Restore onto a second device**

Install on a clean device, enter the same mnemonic, restore. Expected: transaction history
and balance match the source device.

- [ ] **Step 4: Spend from the restored wallet**

This is the real acceptance test for the entire feature. Send a payment from the restored
wallet using an output it learned about only through the backup log. If that broadcasts,
the derivation metadata survived and the problem is solved.

- [ ] **Step 5: Run the Android emulator pass**

```bash
npm run android
```

Project convention: always run the Android emulator, since it has caught races iOS did not.

- [ ] **Step 6: Commit**

```bash
git commit --allow-empty -m "test(backup): device verification — restore and spend confirmed"
```

---

## Acceptance

- Frozen derivation vector test green; pseudonym differs from the wallet identity key
- Chunks round-trip byte-exactly, including all `number[]` binary fields
- A different key cannot decrypt another's ciphertext
- No request carries an identity parameter
- Round-trip test restores outputs, actions and BRC-29 derivation metadata into a fresh DB
- Share-recovered `primaryKey` restores successfully
- Push never blocks the JS thread for more than 100ms
- A payment sent from a restored wallet, on a device, broadcasts and confirms
