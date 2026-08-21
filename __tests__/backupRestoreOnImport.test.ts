/**
 * restoreOnImport — the one call the import flow makes before the wallet is usable.
 *
 * What matters here is not the replay itself (backupRestore.test.ts covers the reader)
 * but the decisions around it: which device's log gets replayed, what happens when there
 * is nothing to replay, and that a broken log stops the import rather than producing a
 * wallet that looks healthy and is missing outputs.
 */
import { PrivateKey } from '@bsv/sdk'
import type { SyncChunk } from '@bsv/wallet-toolbox-mobile/out/src/sdk/WalletStorage.interfaces'
import type { DeviceSummary, LogEntry } from '@/utils/backup/client'
import { encodeChunk, emptyChunk } from '@/utils/backup/codec'
import { deriveBackupWallet } from '@/utils/backup/derive'
import { restoreOnImport } from '@/utils/backup/restoreOnImport'

const PRIMARY = new PrivateKey(21).toArray('be', 32)
const OLD_DEVICE = 'a'.repeat(32)
const NEW_DEVICE = 'b'.repeat(32)

const summary = (over: Partial<DeviceSummary>): DeviceSummary => ({
  deviceId: OLD_DEVICE,
  generation: 1,
  headSeq: 1,
  headSha256: 'sha1',
  totalBytes: 10,
  updatedAt: '2026-08-01T00:00:00Z',
  ...over
})

function chunkWithTx (txid: string): SyncChunk {
  const c = emptyChunk('a', 'b', 'user') as unknown as Record<string, unknown[]>
  c.provenTxs = [{ provenTxId: 1, txid, rawTx: [1, 2, 3] }]
  return c as unknown as SyncChunk
}

/** Server stand-in: a manifest plus per-(device, generation) logs. */
function fakeClient (
  devices: DeviceSummary[],
  logs: Record<string, number[][]> = {},
  indexOverride?: Record<string, LogEntry[]>
): any {
  const key = (d: string, g: number): string => `${d}/${g}`
  return {
    manifest: jest.fn().mockResolvedValue(devices),
    index: jest.fn(async (d: string, g: number) => {
      const override = indexOverride?.[key(d, g)]
      if (override != null) return override
      return (logs[key(d, g)] ?? []).map((b, i) => ({
        seq: i + 1,
        sha256: `sha${i + 1}`,
        prevSha256: i === 0 ? undefined : `sha${i}`,
        size: b.length,
        createdAt: '2026-08-15T00:00:00Z'
      }))
    }),
    blob: jest.fn(async (d: string, g: number, seq: number) => (logs[key(d, g)] ?? [])[seq - 1]),
    append: jest.fn(),
    pruneGeneration: jest.fn()
  }
}

/** Storage stand-in: accepts chunks, reports done once it has seen them all. */
function fakeStorage (expected: number): any {
  let seen = 0
  const s: any = {
    seen: () => seen,
    makeAvailable: jest.fn().mockResolvedValue({ storageIdentityKey: 'fresh-local' }),
    findOrInsertUser: jest.fn(async () => ({ user: { userId: 7 }, isNew: true })),
    findOrInsertSyncStateAuth: jest.fn(async () => ({ syncState: {}, isNew: true })),
    processSyncChunk: jest.fn(async () => {
      // The real processSyncChunk verifyTruthy/verifyOne's these rows — a chunk
      // arriving before both seeds is exactly the "A truthy value is required"
      // failure on a fresh device.
      if (s.findOrInsertUser.mock.calls.length === 0 || s.findOrInsertSyncStateAuth.mock.calls.length === 0) {
        throw new Error('A truthy value is required.')
      }
      if (seen >= expected) return { done: true, maxUpdated_at: undefined, updates: 0, inserts: 0 }
      seen++
      return { done: false, maxUpdated_at: undefined, updates: 0, inserts: 0 }
    })
  }
  return s
}

const deps = (over: Record<string, unknown>): any => ({
  primaryKey: PRIMARY,
  identityKey: '02' + 'ab'.repeat(32),
  ...over
})

describe('restoreOnImport', () => {
  it('does nothing when no backup server is configured', async () => {
    const storage = fakeStorage(0)
    const result = await restoreOnImport(deps({ storage, baseUrl: '' }))

    expect(result).toEqual({ restored: false, chunks: 0, reason: 'not-configured' })
    expect(storage.processSyncChunk).not.toHaveBeenCalled()
  })

  it('reports no-backup for a wallet the server has never seen', async () => {
    // The ordinary case for a wallet imported from a phrase that was never backed up:
    // the import must continue, not fail.
    const storage = fakeStorage(0)
    const client = fakeClient([])
    const result = await restoreOnImport(deps({ storage, client }))

    expect(result).toEqual({ restored: false, chunks: 0, reason: 'no-backup' })
    expect(client.index).not.toHaveBeenCalled()
    expect(storage.processSyncChunk).not.toHaveBeenCalled()
  })

  it('replays the newest generation of the most recently written device', async () => {
    const w = deriveBackupWallet(PRIMARY)
    const logs = {
      [`${OLD_DEVICE}/1`]: [await encodeChunk(w, chunkWithTx('old'))],
      [`${NEW_DEVICE}/2`]: [await encodeChunk(w, chunkWithTx('new1')), await encodeChunk(w, chunkWithTx('new2'))]
    }
    const client = fakeClient(
      [
        summary({ deviceId: OLD_DEVICE, generation: 1, updatedAt: '2026-08-01T00:00:00Z' }),
        summary({ deviceId: NEW_DEVICE, generation: 1, updatedAt: '2026-08-09T00:00:00Z' }),
        summary({ deviceId: NEW_DEVICE, generation: 2, updatedAt: '2026-08-09T00:00:00Z' })
      ],
      logs
    )
    const storage = fakeStorage(2)

    const result = await restoreOnImport(deps({ storage, client }))

    expect(result.restored).toBe(true)
    expect(result.deviceId).toBe(NEW_DEVICE)
    expect(result.generation).toBe(2)
    expect(result.chunks).toBe(2)
    // The target is resolved HERE and passed through explicitly — never left to
    // restoreFromBackup's own "most recently updated" default, which this device's
    // own first push would win as soon as the monitor starts.
    expect(client.index).toHaveBeenCalledWith(NEW_DEVICE, 2)
    expect(client.index).not.toHaveBeenCalledWith(OLD_DEVICE, 1)
  })

  it('seeds the user row and the source device\'s syncState before the first chunk', async () => {
    const w = deriveBackupWallet(PRIMARY)
    const client = fakeClient([summary({ deviceId: NEW_DEVICE, generation: 1 })], {
      [`${NEW_DEVICE}/1`]: [await encodeChunk(w, chunkWithTx('only'))]
    })
    const storage = fakeStorage(1)
    const identityKey = '02' + 'ab'.repeat(32)

    const result = await restoreOnImport(deps({ storage, client }))

    expect(result.restored).toBe(true)
    expect(storage.findOrInsertUser).toHaveBeenCalledWith(identityKey)
    // syncState keyed to the SOURCE device: processSyncChunk looks it up by
    // fromStorageIdentityKey, which restore passes as the backup's deviceId.
    expect(storage.findOrInsertSyncStateAuth).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7, identityKey }),
      NEW_DEVICE,
      'backup-restore'
    )
  })

  it('reports progress as chunks land', async () => {
    const w = deriveBackupWallet(PRIMARY)
    const client = fakeClient([summary({})], {
      [`${OLD_DEVICE}/1`]: [
        await encodeChunk(w, chunkWithTx('a')),
        await encodeChunk(w, chunkWithTx('b')),
        await encodeChunk(w, chunkWithTx('c'))
      ]
    })
    const seen: Array<[number, number]> = []

    await restoreOnImport(
      deps({ storage: fakeStorage(3), client, onProgress: (c: number, t: number) => seen.push([c, t]) })
    )

    expect(seen).toEqual([
      [1, 3],
      [2, 3],
      [3, 3]
    ])
  })

  it('fails the import when the log has a gap', async () => {
    // Half a history is worse than none: the wallet would look healthy while missing the
    // outputs it needs to spend, so this must reach the user as a failure.
    const w = deriveBackupWallet(PRIMARY)
    const client = fakeClient(
      [summary({})],
      { [`${OLD_DEVICE}/1`]: [await encodeChunk(w, chunkWithTx('a'))] },
      { [`${OLD_DEVICE}/1`]: [{ seq: 2, sha256: 'sha2', prevSha256: 'sha1', size: 1, createdAt: 'z' }] }
    )

    await expect(restoreOnImport(deps({ storage: fakeStorage(1), client }))).rejects.toThrow(/gap/)
  })
})
