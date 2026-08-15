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
import type { SyncChunk } from '@bsv/wallet-toolbox-mobile/out/src/sdk/WalletStorage.interfaces'
import { BackupHttpError, ERR_SEQ_CONFLICT } from '@/utils/backup/client'
import { emptyChunk } from '@/utils/backup/codec'
import { GENERATION_CHUNK_THRESHOLD } from '@/utils/backup/constants'
import { loadCursor, saveCursor, freshCursor, zeroOffsets } from '@/utils/backup/cursor'
import { backupPseudonym } from '@/utils/backup/derive'
import { pushOnce } from '@/utils/backup/push'

const PRIMARY = new PrivateKey(11).toArray('be', 32)
const IDENTITY = '02' + 'ab'.repeat(32)
const DEVICE = 'c'.repeat(32)
const PSEUDONYM = backupPseudonym(PRIMARY)

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

function fakeStorage (chunk: SyncChunk): { getSyncChunk: jest.Mock } {
  return { getSyncChunk: jest.fn().mockResolvedValue(chunk) }
}

function fakeClient (over: Partial<Record<'append' | 'manifest', jest.Mock>> = {}): any {
  return {
    append: over.append ?? jest.fn().mockResolvedValue({ seq: 1, sha256: 'newsha' }),
    manifest: over.manifest ?? jest.fn().mockResolvedValue([]),
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
      primaryKey: PRIMARY, identityKey: IDENTITY, client, deviceId: DEVICE
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
      storage: storage as any, primaryKey: PRIMARY, identityKey: IDENTITY,
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
      storage: storage as any, primaryKey: PRIMARY, identityKey: IDENTITY,
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
      primaryKey: PRIMARY, identityKey: IDENTITY, client, deviceId: DEVICE
    })

    expect(r.pushed).toBe(1)
    expect(client.append).toHaveBeenCalledWith(DEVICE, 1, 1, undefined, expect.any(Array))

    const cursor = await loadCursor(PSEUDONYM, DEVICE)
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
      primaryKey: PRIMARY, identityKey: IDENTITY, client, deviceId: DEVICE
    })).rejects.toThrow('network down')

    const cursor = await loadCursor(PSEUDONYM, DEVICE)
    expect(cursor.seq).toBe(0)
    expect(cursor.offsets.provenTx).toBe(0)
  })

  it('chains prevSha256 from the previous append', async () => {
    await saveCursor(PSEUDONYM, DEVICE, {
      ...freshCursor(), seq: 1, prevSha256: 'oldsha', chunksInGeneration: 1
    })
    const client = fakeClient({ append: jest.fn().mockResolvedValue({ seq: 2, sha256: 'secondsha' }) })

    await pushOnce({
      storage: fakeStorage(chunkWith({ provenTxs: 1 })) as any,
      primaryKey: PRIMARY, identityKey: IDENTITY, client, deviceId: DEVICE
    })

    expect(client.append).toHaveBeenCalledWith(DEVICE, 1, 2, 'oldsha', expect.any(Array))
    expect((await loadCursor(PSEUDONYM, DEVICE)).prevSha256).toBe('secondsha')
  })

  it('closes the window by advancing since and zeroing offsets', async () => {
    // Mirrors EntitySyncState: when a chunk comes back empty the window is exhausted, so
    // `since` jumps to the greatest updated_at seen and the offsets reset.
    await saveCursor(PSEUDONYM, DEVICE, {
      ...freshCursor(),
      offsets: { ...zeroOffsets(), provenTx: 5 },
      maxUpdatedAt: '2026-08-02T00:00:00.000Z',
      seq: 3,
      chunksInGeneration: 3
    })

    await pushOnce({
      storage: fakeStorage(emptyChunk('a', 'b', IDENTITY)) as any,
      primaryKey: PRIMARY, identityKey: IDENTITY, client: fakeClient(), deviceId: DEVICE
    })

    const cursor = await loadCursor(PSEUDONYM, DEVICE)
    expect(cursor.since).toBe('2026-08-02T00:00:00.000Z')
    expect(cursor.offsets.provenTx).toBe(0)
    expect(cursor.maxUpdatedAt).toBeUndefined()
    expect(cursor.seq).toBe(3)
  })

  it('rotates to a new generation past the threshold, at a window boundary', async () => {
    await saveCursor(PSEUDONYM, DEVICE, {
      ...freshCursor(),
      since: '2026-01-01T00:00:00.000Z',
      seq: GENERATION_CHUNK_THRESHOLD,
      chunksInGeneration: GENERATION_CHUNK_THRESHOLD
    })

    const r = await pushOnce({
      storage: fakeStorage(emptyChunk('a', 'b', IDENTITY)) as any,
      primaryKey: PRIMARY, identityKey: IDENTITY, client: fakeClient(), deviceId: DEVICE
    })

    expect(r.rotated).toBe(true)

    // A new generation is a full snapshot: no since filter, sequence restarts at one.
    const cursor = await loadCursor(PSEUDONYM, DEVICE)
    expect(cursor.generation).toBe(2)
    expect(cursor.seq).toBe(0)
    expect(cursor.since).toBeUndefined()
    expect(cursor.chunksInGeneration).toBe(0)
  })

  it('does not rotate mid-window', async () => {
    // Rotating with records still pending would leave a generation that is not a coherent
    // snapshot, which a restore could not trust.
    await saveCursor(PSEUDONYM, DEVICE, {
      ...freshCursor(), seq: GENERATION_CHUNK_THRESHOLD, chunksInGeneration: GENERATION_CHUNK_THRESHOLD
    })

    const r = await pushOnce({
      storage: fakeStorage(chunkWith({ provenTxs: 1 })) as any,
      primaryKey: PRIMARY, identityKey: IDENTITY, client: fakeClient(), deviceId: DEVICE
    })

    expect(r.rotated).toBe(false)
    expect((await loadCursor(PSEUDONYM, DEVICE)).generation).toBe(1)
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
      primaryKey: PRIMARY, identityKey: IDENTITY, client, deviceId: DEVICE
    })

    expect(r.pushed).toBe(0)
    const cursor = await loadCursor(PSEUDONYM, DEVICE)
    expect(cursor.generation).toBe(5)
    expect(cursor.seq).toBe(0)
  })

  it('requires either a client or a baseUrl', async () => {
    await expect(pushOnce({
      storage: fakeStorage(chunkWith({ provenTxs: 1 })) as any,
      primaryKey: PRIMARY, identityKey: IDENTITY, deviceId: DEVICE
    })).rejects.toThrow(/client or a baseUrl/)
  })
})
