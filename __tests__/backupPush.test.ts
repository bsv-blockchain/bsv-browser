/* eslint-disable import/first -- jest.mock must be hoisted above the imports it affects */
// Mocked per-file rather than via moduleNameMapper: the vault suites install their own
// AsyncStorage mock, and a global mapper makes the resolver recurse between the two.
jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {}
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store[k] ?? null,
      setItem: async (k: string, v: string) => { store[k] = v },
      removeItem: async (k: string) => { delete store[k] },
      clear: async () => { for (const k of Object.keys(store)) delete store[k] }
    }
  }
})

import AsyncStorage from '@react-native-async-storage/async-storage'
import { PrivateKey } from '@bsv/sdk'
import { BackupHttpError, ERR_SEQ_CONFLICT } from '@bsv/expo-wallet-toolbox/core/backup/client'
import { decodeEntry, emptyChunk } from '@bsv/expo-wallet-toolbox/core/backup/codec'
import { GENERATION_CHUNK_THRESHOLD } from '@bsv/expo-wallet-toolbox/core/backup/constants'
import { loadCursor, saveCursor, freshCursor, zeroOffsets } from '@bsv/expo-wallet-toolbox/core/backup/cursor'
import { backupPseudonym, deriveBackupWallet } from '@bsv/expo-wallet-toolbox/core/backup/derive'
import { setBackupPushEnabled } from '@bsv/expo-wallet-toolbox/core/backup/preference'
import { pushOnce } from '@bsv/expo-wallet-toolbox/core/backup/push'
import type { SyncChunk } from '@bsv/expo-wallet-toolbox/core/toolboxTypes'

const PRIMARY = new PrivateKey(11).toArray('be', 32)
const IDENTITY = '02' + 'ab'.repeat(32)
const DEVICE = 'c'.repeat(32)
const PSEUDONYM = backupPseudonym(PRIMARY, 'main')

function chunkWith (counts: { provenTxs?: number, outputs?: number }, updatedAt = '2026-08-01T00:00:00.000Z'): SyncChunk {
  const c = emptyChunk('a', 'b', IDENTITY) as unknown as Record<string, unknown[]>
  c.provenTxs = Array.from({ length: counts.provenTxs ?? 0 }, (_, i) => ({
    provenTxId: i, rawTx: [1, 2, 3], updated_at: updatedAt
  }))
  c.outputs = Array.from({ length: counts.outputs ?? 0 }, (_, i) => ({
    outputId: i, updated_at: updatedAt
  }))
  return c as unknown as SyncChunk
}

function fakeStorage (
  chunk: SyncChunk,
  kv: Record<string, string> = {}
): { getSyncChunk: jest.Mock, getKeyValue: jest.Mock, setKeyValue: jest.Mock } {
  const map = new Map<string, string>(Object.entries(kv))
  return {
    getSyncChunk: jest.fn().mockResolvedValue(chunk),
    // Every non-empty-chunk push now also reads the app-owned KV rows to fold into the same
    // envelope (XR-011) — a bare `{ getSyncChunk }` stub would throw "getKeyValue is not a
    // function" on any test that reaches that far, so every caller of this helper gets a
    // working (empty by default) KV store for free.
    getKeyValue: jest.fn(async (k: string) => map.get(k)),
    setKeyValue: jest.fn(async (k: string, v: string) => void map.set(k, v))
  }
}

/**
 * A storage stub that answers `since` the way SQLite actually does.
 *
 * The real query is `updated_at >= ?` (storage/methods/findSql.ts) paged by a
 * plain LIMIT/OFFSET ordered by primary key ascending, so a fake that just
 * replays a fixed chunk cannot show what a cursor does across passes. This one
 * holds a fixed set of records and filters them, which is what makes the
 * boundary behaviour observable.
 */
function inclusiveSinceStorage (updatedAt: string[]): { getSyncChunk: jest.Mock, getKeyValue: jest.Mock, setKeyValue: jest.Mock } {
  const rows = updatedAt.map((t, i) => ({ provenTxId: i, rawTx: [1, 2, 3], updated_at: t }))
  return {
    getSyncChunk: jest.fn(async (args: any) => {
      const since = args.since != null ? new Date(args.since).toISOString() : undefined
      const offsets = args.offsets as { name: string, offset: number }[]
      const offset = offsets.find(o => o.name === 'provenTx')?.offset ?? 0
      const c = emptyChunk('a', 'b', IDENTITY) as unknown as Record<string, unknown[]>
      // `>=`, exactly as the column comparison does.
      c.provenTxs = rows.filter(r => since == null || r.updated_at >= since).slice(offset)
      return c as unknown as SyncChunk
    }),
    getKeyValue: jest.fn().mockResolvedValue(undefined),
    setKeyValue: jest.fn()
  }
}

function fakeClient (over: Partial<Record<'append' | 'manifest' | 'limits', jest.Mock>> = {}): any {
  return {
    append: over.append ?? jest.fn().mockResolvedValue({ seq: 1, sha256: 'newsha', size: 1 }),
    manifest: over.manifest ?? jest.fn().mockResolvedValue([]),
    // The oversize gate reads the cap from the server's limits document. The
    // stub answers with the historic 1 MiB so the guard tests below keep a
    // realistic threshold to trip.
    limits:
      over.limits ??
      jest.fn().mockResolvedValue({ maxBlobBytes: 1 << 20, maxBodyBytes: 1 << 21, serverIdentityKey: '02'.padEnd(66, 'a') }),
    index: jest.fn().mockResolvedValue([]),
    blob: jest.fn(),
    pruneGeneration: jest.fn()
  }
}

beforeEach(async () => { await AsyncStorage.clear() })

describe('pushOnce', () => {
  it('appends nothing when the chunk is empty', async () => {
    const client = fakeClient()
    const r = await pushOnce({
      storage: fakeStorage(emptyChunk('a', 'b', IDENTITY)) as any,
      primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client, deviceId: DEVICE
    })

    expect(client.append).not.toHaveBeenCalled()
    expect(r.pushed).toBe(0)
    expect(r.windowClosed).toBe(true)
  })

  it('reads the chunk directly from the storage provider with bounded sizing', async () => {
    // Never via WalletStorageManager: updateBackups/syncToWriter take the sync lock and
    // block every storage read and write for the duration.
    const storage = fakeStorage(chunkWith({ provenTxs: 1 }))
    await pushOnce({
      storage: storage as any, primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY,
      client: fakeClient(), deviceId: DEVICE
    })

    expect(storage.getSyncChunk).toHaveBeenCalledWith(expect.objectContaining({
      identityKey: IDENTITY,
      maxRoughSize: 512_000,
      maxItems: 200
    }))
  })

  it('never sends the real identity key as the log address', async () => {
    const storage = fakeStorage(chunkWith({ provenTxs: 1 }))
    await pushOnce({
      storage: storage as any, primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY,
      client: fakeClient(), deviceId: DEVICE
    })

    // identityKey is needed for the LOCAL user lookup, but the log is addressed by the
    // pseudonym, and the two must never be the same value.
    const args = storage.getSyncChunk.mock.calls[0][0]
    expect(args.toStorageIdentityKey).toBe(PSEUDONYM)
    expect(args.toStorageIdentityKey).not.toBe(IDENTITY)
  })

  it('appends the encrypted chunk and advances the cursor', async () => {
    const client = fakeClient()
    const r = await pushOnce({
      storage: fakeStorage(chunkWith({ provenTxs: 2, outputs: 3 })) as any,
      primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client, deviceId: DEVICE
    })

    expect(r.pushed).toBe(1)
    expect(client.append).toHaveBeenCalledWith(DEVICE, 1, 1, undefined, expect.any(Array))

    const cursor = await loadCursor('main', PSEUDONYM, DEVICE)
    expect(cursor.seq).toBe(1)
    expect(cursor.prevSha256).toBe('newsha')
    expect(cursor.offsets.provenTx).toBe(2)
    expect(cursor.offsets.output).toBe(3)
    expect(cursor.maxUpdatedAt).toBe('2026-08-01T00:00:00.000Z')
  })

  it('does not advance the cursor when the append fails', async () => {
    // Advancing on failure would skip records permanently — a silent hole in the restore.
    const client = fakeClient({ append: jest.fn().mockRejectedValue(new Error('network down')) })

    await expect(pushOnce({
      storage: fakeStorage(chunkWith({ provenTxs: 1 })) as any,
      primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client, deviceId: DEVICE
    })).rejects.toThrow('network down')

    const cursor = await loadCursor('main', PSEUDONYM, DEVICE)
    expect(cursor.seq).toBe(0)
    expect(cursor.offsets.provenTx).toBe(0)
  })

  it('chains prevSha256 from the previous append', async () => {
    await saveCursor('main', PSEUDONYM, DEVICE, {
      ...freshCursor(), seq: 1, prevSha256: 'oldsha', chunksInGeneration: 1
    })
    const client = fakeClient({ append: jest.fn().mockResolvedValue({ seq: 2, sha256: 'secondsha' }) })

    await pushOnce({
      storage: fakeStorage(chunkWith({ provenTxs: 1 })) as any,
      primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client, deviceId: DEVICE
    })

    expect(client.append).toHaveBeenCalledWith(DEVICE, 1, 2, 'oldsha', expect.any(Array))
    expect((await loadCursor('main', PSEUDONYM, DEVICE)).prevSha256).toBe('secondsha')
  })

  it('closes the window by advancing since and zeroing offsets', async () => {
    // As in EntitySyncState, an empty chunk means the window is exhausted: the offsets
    // reset and `since` moves to the greatest updated_at seen — but one millisecond PAST
    // it, not onto it. The column comparison is `>=`, and our writer is an append-only
    // log rather than a merging storage, so landing on the mark re-uploaded the boundary
    // record on every subsequent window.
    await saveCursor('main', PSEUDONYM, DEVICE, {
      ...freshCursor(),
      offsets: { ...zeroOffsets(), provenTx: 5 },
      maxUpdatedAt: '2026-08-02T00:00:00.000Z',
      seq: 3,
      chunksInGeneration: 3
    })

    await pushOnce({
      storage: fakeStorage(emptyChunk('a', 'b', IDENTITY)) as any,
      primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client: fakeClient(), deviceId: DEVICE
    })

    const cursor = await loadCursor('main', PSEUDONYM, DEVICE)
    expect(cursor.since).toBe('2026-08-02T00:00:00.001Z')
    expect(cursor.offsets.provenTx).toBe(0)
    expect(cursor.maxUpdatedAt).toBeUndefined()
    expect(cursor.seq).toBe(3)
  })

  it('stops uploading once an unchanged wallet has been backed up', async () => {
    // The regression this guards: `since` used to advance to exactly the greatest
    // updated_at seen, and the column comparison is `>=`, so the record sitting on
    // the boundary came back on the very next window and was appended again. The
    // cycle never converged — one duplicate blob every two passes, forever, each
    // one counting toward the generation threshold that triggers a full re-upload.
    const client = fakeClient()
    const storage = inclusiveSinceStorage(['2026-08-01T00:00:00.000Z'])

    for (let pass = 0; pass < 10; pass++) {
      await pushOnce({
        storage: storage as any,
        primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client, deviceId: DEVICE
      })
    }

    // One record, so exactly one upload of it — sealing never appends a separate entry
    // (see push.test.ts's own 'pushOnce seals' block below), so no matter how many more
    // times the monitor ticks after the window closes, nothing further is sent.
    expect(client.append).toHaveBeenCalledTimes(1)
  })

  it('advances past the boundary so a settled window cannot reopen', async () => {
    const client = fakeClient()
    const storage = inclusiveSinceStorage(['2026-08-01T00:00:00.000Z'])

    // Pass one uploads, pass two finds the window exhausted and closes it.
    for (let pass = 0; pass < 2; pass++) {
      await pushOnce({
        storage: storage as any,
        primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client, deviceId: DEVICE
      })
    }

    const cursor = await loadCursor('main', PSEUDONYM, DEVICE)
    // Strictly after the record, not equal to it.
    expect(cursor.since).toBe('2026-08-01T00:00:00.001Z')
    expect(client.append).toHaveBeenCalledTimes(1)
  })

  it('XR-016: rotates to a fresh generation when the device clock has moved backward', async () => {
    // A window closes at T (>= T+1ms from here on) exactly as the previous test does.
    // The clock then jumps BACKWARD to T-1hour, and the app (using that now-wrong clock)
    // writes a new record stamped T-30min — strictly BELOW the closed window's boundary, so
    // the plain `updated_at >= since` scan can never select it again on its own.
    jest.useFakeTimers()
    try {
      jest.setSystemTime(new Date('2026-08-01T00:00:00.000Z'))
      const client = fakeClient()
      const closedWindowStorage = inclusiveSinceStorage(['2026-08-01T00:00:00.000Z'])
      // Pass one uploads, pass two finds the window exhausted and closes it — same as
      // 'advances past the boundary' above.
      for (let pass = 0; pass < 2; pass++) {
        await pushOnce({
          storage: closedWindowStorage as any,
          primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client, deviceId: DEVICE
        })
      }
      expect(client.append).toHaveBeenCalledTimes(1)

      jest.setSystemTime(new Date('2026-07-31T23:00:00.000Z')) // T - 1 hour: the rollback.
      // Storage now holds BOTH the original record and the new, orphaned one — a real
      // device's database is never emptied by a clock change.
      const afterRollbackStorage = inclusiveSinceStorage([
        '2026-08-01T00:00:00.000Z',
        '2026-07-31T23:30:00.000Z' // T - 30 min: below the closed window's boundary.
      ])

      await pushOnce({
        storage: afterRollbackStorage as any,
        primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client, deviceId: DEVICE
      })

      // A silent no-op (the pre-fix behaviour) would leave this at 1 forever. The fix
      // detects the regression, rotates to a fresh generation (no `since` filter — a full
      // snapshot sees every record regardless of its timestamp), and pushes again.
      expect(client.append).toHaveBeenCalledTimes(2)
      const cursor = await loadCursor('main', PSEUDONYM, DEVICE)
      expect(cursor.generation).toBe(2)
      // Sequence one of the NEW generation, not a continuation of the old one — a rotation
      // is a full resnapshot, so the previously-orphaned record travels in the same chunk
      // as everything else rather than needing to be found some other way.
      expect(client.append.mock.calls[1][1]).toBe(2)
      expect(client.append.mock.calls[1][2]).toBe(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it('still collects a record written in the same millisecond as the boundary', async () => {
    // The reason the advance is safe: a window only closes when nothing at or after
    // `since` is left beyond the offsets, so anything sharing the boundary
    // millisecond has already been uploaded within that window rather than skipped.
    const client = fakeClient()
    const storage = inclusiveSinceStorage([
      '2026-08-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z'
    ])

    for (let pass = 0; pass < 6; pass++) {
      await pushOnce({
        storage: storage as any,
        primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client, deviceId: DEVICE
      })
    }

    // All three shared the boundary and all three went up, in one chunk, once — the window
    // closing after it appends nothing further (see 'pushOnce seals' below).
    expect(client.append).toHaveBeenCalledTimes(1)
    const chunk = storage.getSyncChunk.mock.results[0].value
    await expect(chunk.then((c: any) => c.provenTxs.length)).resolves.toBe(3)
  })

  it('settles a cursor left parked on the boundary by an older build', async () => {
    // Every wallet already in the field has a cursor sitting exactly ON its high-water
    // mark, which is the state the old code kept re-reading from. No migration handles
    // this: the next window re-reads the boundary once more, and the close after it moves
    // past. So each wallet pays at most one final duplicate and then goes quiet.
    //
    // This cursor also happens to be exactly the back-fill shape pushOnce looks for (since
    // already set, chunks already pushed in this generation, initialChunkCount never set)
    // — an older build's cursor predates sealing entirely — so the very first pass
    // back-fills initialChunkCount purely locally before reading anything.
    const client = fakeClient()
    const storage = inclusiveSinceStorage(['2026-08-01T00:00:00.000Z'])
    await saveCursor('main', PSEUDONYM, DEVICE, {
      ...freshCursor(),
      since: '2026-08-01T00:00:00.000Z',
      seq: 7,
      chunksInGeneration: 7
    })

    for (let pass = 0; pass < 10; pass++) {
      await pushOnce({
        storage: storage as any,
        primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client, deviceId: DEVICE
      })
    }

    // The back-fill costs no append at all — only the one final duplicate of the
    // still-unpushed boundary record goes up, now carrying the back-filled seal.
    expect(client.append).toHaveBeenCalledTimes(1)
    expect((await loadCursor('main', PSEUDONYM, DEVICE)).since).toBe('2026-08-01T00:00:00.001Z')
    expect((await loadCursor('main', PSEUDONYM, DEVICE)).initialChunkCount).toBe(7)
  })

  it('rotates to a new generation past the threshold, at a window boundary', async () => {
    await saveCursor('main', PSEUDONYM, DEVICE, {
      ...freshCursor(),
      since: '2026-01-01T00:00:00.000Z',
      seq: GENERATION_CHUNK_THRESHOLD,
      chunksInGeneration: GENERATION_CHUNK_THRESHOLD
    })

    const r = await pushOnce({
      storage: fakeStorage(emptyChunk('a', 'b', IDENTITY)) as any,
      primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client: fakeClient(), deviceId: DEVICE
    })

    expect(r.rotated).toBe(true)

    // A new generation is a full snapshot: no since filter, sequence restarts at one.
    const cursor = await loadCursor('main', PSEUDONYM, DEVICE)
    expect(cursor.generation).toBe(2)
    expect(cursor.seq).toBe(0)
    expect(cursor.since).toBeUndefined()
    expect(cursor.chunksInGeneration).toBe(0)
  })

  it('does not rotate mid-window', async () => {
    // Rotating with records still pending would leave a generation that is not a coherent
    // snapshot, which a restore could not trust.
    await saveCursor('main', PSEUDONYM, DEVICE, {
      ...freshCursor(), seq: GENERATION_CHUNK_THRESHOLD, chunksInGeneration: GENERATION_CHUNK_THRESHOLD
    })

    const r = await pushOnce({
      storage: fakeStorage(chunkWith({ provenTxs: 1 })) as any,
      primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client: fakeClient(), deviceId: DEVICE
    })

    expect(r.rotated).toBe(false)
    expect((await loadCursor('main', PSEUDONYM, DEVICE)).generation).toBe(1)
  })

  it('starts a fresh generation after a sequence conflict', async () => {
    // Happens when the log outlived the cursor — a reinstall, say. Guessing which records
    // the remote already covers risks a hole, so a fresh snapshot is the safe answer.
    const client = fakeClient({
      append: jest.fn().mockRejectedValue(new BackupHttpError(409, ERR_SEQ_CONFLICT, 'expected seq 7')),
      manifest: jest.fn().mockResolvedValue([
        { deviceId: DEVICE, generation: 4, headSeq: 6, headSha256: 'x', totalBytes: 1, updatedAt: 'z' }
      ])
    })

    const r = await pushOnce({
      storage: fakeStorage(chunkWith({ provenTxs: 1 })) as any,
      primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client, deviceId: DEVICE
    })

    expect(r.pushed).toBe(0)
    const cursor = await loadCursor('main', PSEUDONYM, DEVICE)
    expect(cursor.generation).toBe(5)
    expect(cursor.seq).toBe(0)
  })

  it('keeps each network on its own cursor and its own pseudonym', async () => {
    // The network-separation property at the push layer: a mainnet pass must not consume
    // or advance testnet bookkeeping, and each pass must address its own chain's account.
    const storage = fakeStorage(chunkWith({ provenTxs: 1 }))
    await pushOnce({
      storage: storage as any, primaryKey: PRIMARY, chain: 'main',
      identityKey: IDENTITY, client: fakeClient(), deviceId: DEVICE
    })

    const testPseudonym = backupPseudonym(PRIMARY, 'test')
    expect((await loadCursor('main', PSEUDONYM, DEVICE)).seq).toBe(1)
    expect(await loadCursor('test', testPseudonym, DEVICE)).toEqual(freshCursor())

    // And a testnet pass addresses the testnet pseudonym, never the mainnet one.
    const testStorage = fakeStorage(chunkWith({ provenTxs: 1 }))
    await pushOnce({
      storage: testStorage as any, primaryKey: PRIMARY, chain: 'test',
      identityKey: IDENTITY, client: fakeClient(), deviceId: DEVICE
    })
    expect(testStorage.getSyncChunk.mock.calls[0][0].toStorageIdentityKey).toBe(testPseudonym)
    expect((await loadCursor('main', PSEUDONYM, DEVICE)).seq).toBe(1)
    expect((await loadCursor('test', testPseudonym, DEVICE)).seq).toBe(1)
  })

  it('requires either a client or a baseUrl', async () => {
    await expect(pushOnce({
      storage: fakeStorage(chunkWith({ provenTxs: 1 })) as any,
      primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, deviceId: DEVICE
    })).rejects.toThrow(/client or a baseUrl/)
  })
})

describe('XR-011: pushOnce appData', () => {
  async function decodedAppData (ciphertext: number[]): Promise<Record<string, unknown> | undefined> {
    const wallet = deriveBackupWallet(PRIMARY, 'main')
    const decoded = await decodeEntry(wallet, ciphertext, 'main')
    return decoded.appData as Record<string, unknown> | undefined
  }

  it('folds the current localpay_pending/peerpay_outbox rows into the pushed envelope', async () => {
    const client = fakeClient()
    const storage = fakeStorage(chunkWith({ provenTxs: 1 }), {
      localpay_pending: '[{"id":"p1"}]',
      peerpay_outbox: '[{"id":"o1"}]'
    })

    await pushOnce({
      storage: storage as any, primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client, deviceId: DEVICE
    })

    expect(client.append).toHaveBeenCalledTimes(1)
    expect(await decodedAppData(client.append.mock.calls[0][4])).toEqual({
      localpayPending: '[{"id":"p1"}]',
      peerpayOutbox: '[{"id":"o1"}]'
    })
  })

  it('omits appData entirely when nothing app-owned is queued, so the envelope is unchanged', async () => {
    const client = fakeClient()
    const storage = fakeStorage(chunkWith({ provenTxs: 1 }))

    await pushOnce({
      storage: storage as any, primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client, deviceId: DEVICE
    })

    expect(await decodedAppData(client.append.mock.calls[0][4])).toBeUndefined()
  })

  it('never appends purely to carry appData: a window closing with nothing new sends nothing, even with a queued payment', async () => {
    // The dangerous shape this must never produce: the toolbox's own processSyncChunk treats
    // EVERY entity array being empty as its completion sentinel regardless of the entry's
    // position in the log (see codec.ts's encodeChunk docs) — an appended, entity-empty
    // "appData-only" entry would make a live restore stop early and drop whatever real
    // chunks were appended after it.
    const client = fakeClient()
    const storage = fakeStorage(emptyChunk('a', 'b', IDENTITY), { localpay_pending: '[{"id":"p1"}]' })

    const r = await pushOnce({
      storage: storage as any, primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client, deviceId: DEVICE
    })

    expect(client.append).not.toHaveBeenCalled()
    expect(r.pushed).toBe(0)
    expect(r.windowClosed).toBe(true)
  })

  it('counts appData bytes toward the oversize gate, so a huge queue is never silently dropped from the check', async () => {
    const client = fakeClient()
    const hugePending = JSON.stringify([{ id: 'p1', blob: 'x'.repeat(2_000_000) }])
    const storage = fakeStorage(chunkWith({ provenTxs: 1 }), { localpay_pending: hugePending })

    const r = await pushOnce({
      storage: storage as any, primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client, deviceId: DEVICE
    })

    expect(r.oversized).toBe(true)
    expect(client.append).not.toHaveBeenCalled()
  })
})

// ── oversize guard ────────────────────────────────────────────────────────
//
// The cap now comes from the server's own limits document rather than a local
// constant; the stub answers 1 MiB. A full-size R1-K1 rawTx (~960 KB, ~1.28 MB
// base64) trips that on its own. maxRoughSize bounds how much the toolbox
// ACCUMULATES, never the size of one record, so no tuning makes such a chunk
// fit a cap it exceeds alone.
//
// Left unguarded this is not merely a failed push: encrypting and then
// BRC-31-signing that payload blocked the JS thread for ~50s on device, every
// retry, freezing the whole app.
describe('pushOnce oversize guard', () => {
  function chunkWithBigTx (rawTxBytes: number): SyncChunk {
    const c = emptyChunk('a', 'b', IDENTITY) as unknown as Record<string, unknown[]>
    c.provenTxs = [{
      provenTxId: 1,
      rawTx: Array.from({ length: rawTxBytes }, () => 7),
      updated_at: '2026-08-01T00:00:00.000Z'
    }]
    return c as unknown as SyncChunk
  }

  it('never encrypts or uploads a chunk that cannot fit the server cap', async () => {
    const client = fakeClient()
    const r = await pushOnce({
      storage: fakeStorage(chunkWithBigTx(959_836)) as any,
      primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client, deviceId: DEVICE
    })

    expect(client.append).not.toHaveBeenCalled()
    expect(r.pushed).toBe(0)
    expect(r.oversized).toBe(true)
  })

  it('leaves the cursor untouched so an oversized chunk is never silently skipped', async () => {
    const before = await loadCursor('main', PSEUDONYM, DEVICE)
    await pushOnce({
      storage: fakeStorage(chunkWithBigTx(959_836)) as any,
      primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client: fakeClient(), deviceId: DEVICE
    })

    expect(await loadCursor('main', PSEUDONYM, DEVICE)).toEqual(before)
  })

  it('still pushes a chunk that fits', async () => {
    const client = fakeClient()
    const r = await pushOnce({
      storage: fakeStorage(chunkWithBigTx(1000)) as any,
      primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client, deviceId: DEVICE
    })

    expect(client.append).toHaveBeenCalled()
    expect(r.pushed).toBe(1)
    expect(r.oversized).toBeFalsy()
  })
})

// ── seals ──────────────────────────────────────────────────────────────
//
// P1-backup-incomplete-generation's fix: a generation's log carries no notion of
// "complete" on its own, so a restore landing mid-rotation could replay a partial
// snapshot and report success. A seal riding on an ORDINARY chunk's own envelope, once
// this device's view of the generation's initial snapshot is provably whole, is what
// RemoteSyncReader/restore.ts check for on the read side. No separate entry is ever
// appended for it — see codec.ts's encodeChunk docs on why a dedicated marker is unsafe
// for a reader that predates it.
describe('pushOnce seals', () => {
  async function decodedSeal (
    ciphertext: number[]
  ): Promise<{ generation: number, initialChunkCount: number } | undefined> {
    const wallet = deriveBackupWallet(PRIMARY, 'main')
    const decoded = await decodeEntry(wallet, ciphertext, 'main')
    return decoded.seal
  }

  it('records initialChunkCount when the first window closes, then seals every later chunk — never a new entry', async () => {
    const client = fakeClient()

    // Two real chunks, in the still-open first window (since stays undefined) — neither
    // carries a seal, since the window has not closed yet.
    await pushOnce({
      storage: fakeStorage(chunkWith({ provenTxs: 1 })) as any,
      primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client, deviceId: DEVICE
    })
    await pushOnce({
      storage: fakeStorage(chunkWith({ provenTxs: 1 })) as any,
      primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client, deviceId: DEVICE
    })
    expect(client.append).toHaveBeenCalledTimes(2)
    for (const call of client.append.mock.calls) {
      expect(await decodedSeal(call[4])).toBeUndefined()
    }

    // The window closes: nothing left to send, no append at all — initialChunkCount is
    // recorded purely in the cursor.
    const closing = await pushOnce({
      storage: fakeStorage(emptyChunk('a', 'b', IDENTITY)) as any,
      primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client, deviceId: DEVICE
    })
    expect(closing.windowClosed).toBe(true)
    expect(client.append).toHaveBeenCalledTimes(2)
    expect((await loadCursor('main', PSEUDONYM, DEVICE)).initialChunkCount).toBe(2)

    // The next real chunk (a pure delta) carries the seal referencing that count.
    await pushOnce({
      storage: fakeStorage(chunkWith({ provenTxs: 1 })) as any,
      primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client, deviceId: DEVICE
    })
    expect(client.append).toHaveBeenCalledTimes(3)
    expect(await decodedSeal(client.append.mock.calls[2][4])).toEqual({ generation: 1, initialChunkCount: 2 })

    // A SECOND window close in the same generation — pure delta continuation — must not
    // move initialChunkCount, and closing itself never appends anything.
    const secondClose = await pushOnce({
      storage: fakeStorage(emptyChunk('a', 'b', IDENTITY)) as any,
      primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client, deviceId: DEVICE
    })
    expect(secondClose.windowClosed).toBe(true)
    expect(client.append).toHaveBeenCalledTimes(3)
    expect((await loadCursor('main', PSEUDONYM, DEVICE)).initialChunkCount).toBe(2)

    // A further delta still carries the ORIGINAL seal, not one referencing the later count.
    await pushOnce({
      storage: fakeStorage(chunkWith({ provenTxs: 1 })) as any,
      primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client, deviceId: DEVICE
    })
    expect(client.append).toHaveBeenCalledTimes(4)
    expect(await decodedSeal(client.append.mock.calls[3][4])).toEqual({ generation: 1, initialChunkCount: 2 })

    // Every append was a real chunk — no extra entry was ever appended for sealing.
    expect(client.append).toHaveBeenCalledTimes(4)
  })

  it('back-fills initialChunkCount for a cursor whose window already closed under an older build, with no append at all', async () => {
    // Simulates a device that pushed three chunks and closed its window before sealing
    // existed: `since` and `chunksInGeneration` are set, but `initialChunkCount` has never
    // existed on this cursor.
    await saveCursor('main', PSEUDONYM, DEVICE, {
      ...freshCursor(),
      since: '2026-08-01T00:00:00.001Z',
      seq: 3,
      chunksInGeneration: 3
    })
    const client = fakeClient()

    const r = await pushOnce({
      storage: fakeStorage(chunkWith({ provenTxs: 1 })) as any,
      primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client, deviceId: DEVICE
    })

    // The back-fill itself costs no network round trip; this pass's one append is the real
    // chunk it read, now carrying the back-filled seal.
    expect(r.pushed).toBe(1)
    expect(client.append).toHaveBeenCalledTimes(1)
    expect(await decodedSeal(client.append.mock.calls[0][4])).toEqual({ generation: 1, initialChunkCount: 3 })
    expect((await loadCursor('main', PSEUDONYM, DEVICE)).initialChunkCount).toBe(3)
  })

  it('never seals an empty wallet that has pushed nothing at all', async () => {
    const client = fakeClient()

    await pushOnce({
      storage: fakeStorage(emptyChunk('a', 'b', IDENTITY)) as any,
      primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client, deviceId: DEVICE
    })
    await pushOnce({
      storage: fakeStorage(emptyChunk('a', 'b', IDENTITY)) as any,
      primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client, deviceId: DEVICE
    })

    expect(client.append).not.toHaveBeenCalled()
    expect((await loadCursor('main', PSEUDONYM, DEVICE)).initialChunkCount).toBeUndefined()
  })
})

describe('pushOnce opt-out', () => {
  it('sends nothing, and does not even read the database, once the user opts out', async () => {
    await setBackupPushEnabled(false)
    const storage = fakeStorage(chunkWith({ provenTxs: 1 }))
    const client = fakeClient()

    const r = await pushOnce({ storage: storage as any, primaryKey: PRIMARY, chain: 'main', identityKey: IDENTITY, client, deviceId: DEVICE })

    expect(r).toEqual({ pushed: 0, bytes: 0, windowClosed: false, rotated: false, optedOut: true })
    expect(storage.getSyncChunk).not.toHaveBeenCalled()
    expect(client.append).not.toHaveBeenCalled()
  })

  it('leaves the cursor untouched while opted out, so opting back in resumes rather than skips', async () => {
    const before = await loadCursor('main', PSEUDONYM, DEVICE)
    await setBackupPushEnabled(false)

    await pushOnce({
      storage: fakeStorage(chunkWith({ provenTxs: 1 })) as any,
      primaryKey: PRIMARY,
      chain: 'main',
      identityKey: IDENTITY,
      client: fakeClient(),
      deviceId: DEVICE
    })

    expect(await loadCursor('main', PSEUDONYM, DEVICE)).toEqual(before)
  })

  it('pushes again after opting back in', async () => {
    await setBackupPushEnabled(false)
    await setBackupPushEnabled(true)
    const client = fakeClient()

    const r = await pushOnce({
      storage: fakeStorage(chunkWith({ provenTxs: 1 })) as any,
      primaryKey: PRIMARY,
      chain: 'main',
      identityKey: IDENTITY,
      client,
      deviceId: DEVICE
    })

    expect(r.pushed).toBe(1)
    expect(client.append).toHaveBeenCalledTimes(1)
  })
})
