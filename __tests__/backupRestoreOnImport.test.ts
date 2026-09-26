/**
 * restoreOnImport — the one call the import flow makes before the wallet is usable.
 *
 * What matters here is not the replay itself (restore.test.ts covers the reader)
 * but the decisions around it: which device's log gets replayed, what happens when there
 * is nothing to replay, and that a broken log stops the import rather than producing a
 * wallet that looks healthy and is missing outputs.
 */
import { Hash, PrivateKey, Utils } from '@bsv/sdk'
import type { DeviceSummary, LogEntry } from '@bsv/expo-wallet-toolbox/core/backup/client'
import { encodeChunk, emptyChunk, isEmptyChunk } from '@bsv/expo-wallet-toolbox/core/backup/codec'
import { deriveBackupWallet } from '@bsv/expo-wallet-toolbox/core/backup/derive'
import { restoreOnImport } from '@bsv/expo-wallet-toolbox/core/backup/restoreOnImport'
import type { SyncChunk } from '@bsv/expo-wallet-toolbox/core/toolboxTypes'

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

/** Same digest RemoteSyncReader now checks a downloaded blob against — kept alongside the
 * fixtures below so every fake index entry's sha256/size genuinely describes its blob. */
function sha256Hex (bytes: number[]): string {
  return Utils.toHex(Hash.sha256(bytes))
}

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
      const blobs = logs[key(d, g)] ?? []
      return blobs.map((b, i) => ({
        seq: i + 1,
        sha256: sha256Hex(b),
        prevSha256: i === 0 ? undefined : sha256Hex(blobs[i - 1]),
        size: b.length,
        createdAt: '2026-08-15T00:00:00Z'
      }))
    }),
    blob: jest.fn(async (d: string, g: number, seq: number) => (logs[key(d, g)] ?? [])[seq - 1]),
    append: jest.fn(),
    pruneGeneration: jest.fn()
  }
}

/**
 * Storage stand-in: accepts chunks, reports done once the reader itself signals completion
 * (an all-empty chunk) — exactly like the real toolbox's own processSyncChunk, rather than
 * a manually-supplied count. That makes it replay-agnostic: restoring more than one
 * device's log (see XR-015) is just more calls into the same fake, each device's own
 * reader emitting its own completion chunk when ITS index is exhausted. Every provenTx
 * txid actually handed to it is recorded, across every device, so a test can assert on
 * what ended up in "storage" instead of only on call counts.
 */
function fakeStorage (): any {
  const receivedTxids: string[] = []
  const kv = new Map<string, string>()
  const s: any = {
    receivedTxids,
    kv,
    // XR-011: the appData half of a replay reaches storage through these two — a plain
    // in-memory KV map is a faithful double of key_value_store for that purpose.
    getKeyValue: jest.fn(async (k: string) => kv.get(k)),
    setKeyValue: jest.fn(async (k: string, v: string) => void kv.set(k, v)),
    findProvenTxReqs: jest.fn().mockResolvedValue([]),
    makeAvailable: jest.fn().mockResolvedValue({ storageIdentityKey: 'fresh-local' }),
    findOrInsertUser: jest.fn(async () => ({ user: { userId: 7 }, isNew: true })),
    findOrInsertSyncStateAuth: jest.fn(async () => ({ syncState: {}, isNew: true })),
    processSyncChunk: jest.fn(async (_args: unknown, chunk: SyncChunk) => {
      // The real processSyncChunk verifyTruthy/verifyOne's these rows — a chunk
      // arriving before both seeds is exactly the "A truthy value is required"
      // failure on a fresh device.
      if (s.findOrInsertUser.mock.calls.length === 0 || s.findOrInsertSyncStateAuth.mock.calls.length === 0) {
        throw new Error('A truthy value is required.')
      }
      for (const tx of chunk.provenTxs ?? []) receivedTxids.push(tx.txid)
      if (isEmptyChunk(chunk)) return { done: true, maxUpdated_at: undefined, updates: 0, inserts: 0 }
      return { done: false, maxUpdated_at: undefined, updates: 0, inserts: 0 }
    })
  }
  return s
}

const deps = (over: Record<string, unknown>): any => ({
  primaryKey: PRIMARY,
  chain: 'main',
  identityKey: '02' + 'ab'.repeat(32),
  ...over
})

describe('restoreOnImport', () => {
  it('does nothing when no backup server is configured', async () => {
    const storage = fakeStorage()
    const result = await restoreOnImport(deps({ storage, baseUrl: '' }))

    expect(result).toEqual({ restored: false, chunks: 0, reason: 'not-configured' })
    expect(storage.processSyncChunk).not.toHaveBeenCalled()
  })

  it('reports no-backup for a wallet the server has never seen', async () => {
    // The ordinary case for a wallet imported from a phrase that was never backed up:
    // the import must continue, not fail.
    const storage = fakeStorage()
    const client = fakeClient([])
    const result = await restoreOnImport(deps({ storage, client }))

    expect(result).toEqual({ restored: false, chunks: 0, reason: 'no-backup' })
    expect(client.index).not.toHaveBeenCalled()
    expect(storage.processSyncChunk).not.toHaveBeenCalled()
  })

  it('XR-015: replays EVERY device in the manifest, not only the most recently written one', async () => {
    // OLD_DEVICE's log holds a record ('old') that exists nowhere else — exactly the
    // independent, non-overlapping per-device history the finding is about. Restoring
    // only NEW_DEVICE (the highest-ranked candidate) would silently drop it.
    const w = deriveBackupWallet(PRIMARY, 'main')
    const logs = {
      [`${OLD_DEVICE}/1`]: [await encodeChunk(w, chunkWithTx('old'), 'main')],
      [`${NEW_DEVICE}/2`]: [await encodeChunk(w, chunkWithTx('new1'), 'main'), await encodeChunk(w, chunkWithTx('new2'), 'main')]
    }
    const client = fakeClient(
      [
        summary({ deviceId: OLD_DEVICE, generation: 1, updatedAt: '2026-08-01T00:00:00Z' }),
        summary({ deviceId: NEW_DEVICE, generation: 1, updatedAt: '2026-08-09T00:00:00Z' }),
        summary({ deviceId: NEW_DEVICE, generation: 2, updatedAt: '2026-08-09T00:00:00Z' })
      ],
      logs
    )
    const storage = fakeStorage()

    const result = await restoreOnImport(deps({ storage, client }))

    expect(result.restored).toBe(true)
    // The highest-ranked (primary) device/generation is still reported exactly as before —
    // a single-device manifest is unaffected by this change.
    expect(result.deviceId).toBe(NEW_DEVICE)
    expect(result.generation).toBe(2)
    // 1 chunk from OLD_DEVICE's own log plus 2 from NEW_DEVICE's — both replayed, not just
    // the primary's 2.
    expect(result.chunks).toBe(3)
    expect(client.manifest).toHaveBeenCalledTimes(1)
    // The target is resolved HERE and passed through explicitly — never left to
    // restoreFromBackup's own "most recently updated" default, which this device's
    // own first push would win as soon as the monitor starts. None of these logs carry a
    // completion marker, so pickTarget's verified-first ranking probes every candidate
    // (including the older device) before falling back to today's newest-only heuristic —
    // which lands on the same NEW_DEVICE/2 result the old plain heuristic always picked.
    expect(client.index).toHaveBeenCalledWith(NEW_DEVICE, 2)
    expect(client.index).toHaveBeenCalledWith(OLD_DEVICE, 1)
    expect(result.verified).toBe(false)
    // The actual point: OLD_DEVICE's unique record reached storage, alongside NEW_DEVICE's.
    expect(storage.receivedTxids.sort()).toEqual(['new1', 'new2', 'old'])
  })

  it('seeds the user row and the source device\'s syncState before the first chunk', async () => {
    const w = deriveBackupWallet(PRIMARY, 'main')
    const client = fakeClient([summary({ deviceId: NEW_DEVICE, generation: 1 })], {
      [`${NEW_DEVICE}/1`]: [await encodeChunk(w, chunkWithTx('only'), 'main')]
    })
    const storage = fakeStorage()
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
    const w = deriveBackupWallet(PRIMARY, 'main')
    const client = fakeClient([summary({})], {
      [`${OLD_DEVICE}/1`]: [
        await encodeChunk(w, chunkWithTx('a'), 'main'),
        await encodeChunk(w, chunkWithTx('b'), 'main'),
        await encodeChunk(w, chunkWithTx('c'), 'main')
      ]
    })
    const seen: Array<[number, number]> = []

    await restoreOnImport(
      deps({ storage: fakeStorage(), client, onProgress: (c: number, t: number) => seen.push([c, t]) })
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
    const w = deriveBackupWallet(PRIMARY, 'main')
    const client = fakeClient(
      [summary({})],
      { [`${OLD_DEVICE}/1`]: [await encodeChunk(w, chunkWithTx('a'), 'main')] },
      { [`${OLD_DEVICE}/1`]: [{ seq: 2, sha256: 'sha2', prevSha256: 'sha1', size: 1, createdAt: 'z' }] }
    )

    await expect(restoreOnImport(deps({ storage: fakeStorage(), client }))).rejects.toThrow(/gap/)
  })

  it('does not validate coins when there is nothing to restore', async () => {
    const validateRestoredCoins = jest.fn()
    const result = await restoreOnImport(
      deps({ storage: fakeStorage(), client: fakeClient([]), validateRestoredCoins })
    )
    expect(result.reason).toBe('no-backup')
    expect(validateRestoredCoins).not.toHaveBeenCalled()
  })

  it('awaits validateRestoredCoins before resolving a successful restore', async () => {
    const w = deriveBackupWallet(PRIMARY, 'main')
    const client = fakeClient([summary({ deviceId: NEW_DEVICE, generation: 1 })], {
      [`${NEW_DEVICE}/1`]: [await encodeChunk(w, chunkWithTx('only'), 'main')]
    })
    const storage = fakeStorage()
    const order: string[] = []
    const validateRestoredCoins = jest.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 30))
      order.push('validate')
    })

    const result = await restoreOnImport(deps({ storage, client, validateRestoredCoins }))
    order.push('returned')

    expect(validateRestoredCoins).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['validate', 'returned'])
    expect(result.restored).toBe(true)
  })

  // ── P1-backup-incomplete-generation: verified-first target selection ─────
  describe('verified-first target selection', () => {
    it('prefers an older sealed generation over a newer, still-open one', async () => {
      const w = deriveBackupWallet(PRIMARY, 'main')
      const logs = {
        // Generation 1: sealed — the second (newest) real chunk carries this device's own
        // seal, proving the two-chunk initial snapshot is fully present.
        [`${OLD_DEVICE}/1`]: [
          await encodeChunk(w, chunkWithTx('g1-a'), 'main'),
          await encodeChunk(w, chunkWithTx('g1-b'), 'main', { generation: 1, initialChunkCount: 2 })
        ],
        // Generation 2: newer (rotated later) but its initial window has not closed yet —
        // no seal at all, exactly the mid-rotation case P1 is about.
        [`${OLD_DEVICE}/2`]: [await encodeChunk(w, chunkWithTx('g2-a'), 'main')]
      }
      const client = fakeClient(
        [
          summary({ deviceId: OLD_DEVICE, generation: 1, updatedAt: '2026-09-01T00:00:00Z' }),
          summary({ deviceId: OLD_DEVICE, generation: 2, updatedAt: '2026-09-10T00:00:00Z' })
        ],
        logs
      )
      const storage = fakeStorage()

      const result = await restoreOnImport(deps({ storage, client }))

      expect(result.restored).toBe(true)
      expect(result.generation).toBe(1)
      expect(result.verified).toBe(true)
      // Exactly the two real chunks replayed — the seal rides on the second one's own
      // envelope rather than a separate entry.
      expect(result.chunks).toBe(2)
    })

    it('reports verified:false and uses the plain newest-only fallback when nothing is marked', async () => {
      const w = deriveBackupWallet(PRIMARY, 'main')
      const client = fakeClient([summary({ deviceId: OLD_DEVICE, generation: 1 })], {
        [`${OLD_DEVICE}/1`]: [await encodeChunk(w, chunkWithTx('legacy'), 'main')]
      })
      const storage = fakeStorage()

      const result = await restoreOnImport(deps({ storage, client }))

      expect(result.restored).toBe(true)
      expect(result.verified).toBe(false)
      expect(result.chunks).toBe(1)
    })
  })
})

// ── XR-011: restore replays app-owned recovery-critical rows ─────────────────
describe('XR-011: restoreOnImport replays appData', () => {
  it('restores a receiver-side acknowledged, not-yet-internalized localpay pending frame', async () => {
    // The ledger's own concrete scenario: an acknowledged Nearby/QR PaymentFrame that never
    // reached internalizeAction before device loss. At HEAD this row lived only in
    // key_value_store['localpay_pending'], entirely outside every pushed/replayed SyncChunk.
    const w = deriveBackupWallet(PRIMARY, 'main')
    const pending = '[{"id":"p1","status":"pending","frame":{}}]'
    const chunk = await encodeChunk(w, chunkWithTx('aaa'), 'main', undefined, { localpayPending: pending })
    const client = fakeClient([summary({ deviceId: OLD_DEVICE, generation: 1 })], {
      [`${OLD_DEVICE}/1`]: [chunk]
    })
    const storage = fakeStorage()

    const result = await restoreOnImport(deps({ storage, client }))

    expect(result.restored).toBe(true)
    expect(storage.kv.get('localpay_pending')).toBe(pending)
  })

  it('restores the peerpay_outbox delivery checkpoint (XR-012)', async () => {
    const w = deriveBackupWallet(PRIMARY, 'main')
    const outbox = '[{"id":"o1","status":"unsent","delivered":true}]'
    const chunk = await encodeChunk(w, chunkWithTx('aaa'), 'main', undefined, { peerpayOutbox: outbox })
    const client = fakeClient([summary({ deviceId: OLD_DEVICE, generation: 1 })], {
      [`${OLD_DEVICE}/1`]: [chunk]
    })
    const storage = fakeStorage()

    await restoreOnImport(deps({ storage, client }))

    expect(storage.kv.get('peerpay_outbox')).toBe(outbox)
  })

  it('restores the durable issued-receive-date history (XR-055)', async () => {
    const w = deriveBackupWallet(PRIMARY, 'main')
    const chunk = await encodeChunk(w, chunkWithTx('aaa'), 'main', undefined, {
      receiveIssuedDates: ['2026-06-01', '2026-08-15']
    })
    const client = fakeClient([summary({ deviceId: OLD_DEVICE, generation: 1 })], {
      [`${OLD_DEVICE}/1`]: [chunk]
    })
    const storage = fakeStorage()

    await restoreOnImport(deps({ storage, client }))

    expect(JSON.parse(storage.kv.get('pay_receive_issued_dates'))).toEqual(['2026-06-01', '2026-08-15'])
  })

  it('does nothing to key_value_store when no chunk ever carried appData', async () => {
    const w = deriveBackupWallet(PRIMARY, 'main')
    const client = fakeClient([summary({ deviceId: OLD_DEVICE, generation: 1 })], {
      [`${OLD_DEVICE}/1`]: [await encodeChunk(w, chunkWithTx('aaa'), 'main')]
    })
    const storage = fakeStorage()

    await restoreOnImport(deps({ storage, client }))

    expect(storage.setKeyValue).not.toHaveBeenCalled()
  })

  it('XR-015: merges appData across two devices rather than the second clobbering the first', async () => {
    // Each device's own localpay_pending queue is independent and non-overlapping, exactly
    // like the toolbox's own entity tables — a payment received on OLD_DEVICE alone must
    // survive even though NEW_DEVICE (the primary/highest-ranked device) is replayed too.
    const w = deriveBackupWallet(PRIMARY, 'main')
    const logs = {
      [`${OLD_DEVICE}/1`]: [
        await encodeChunk(w, chunkWithTx('old'), 'main', undefined, { localpayPending: '[{"id":"p-old"}]' })
      ],
      [`${NEW_DEVICE}/1`]: [
        await encodeChunk(w, chunkWithTx('new'), 'main', undefined, { localpayPending: '[{"id":"p-new"}]' })
      ]
    }
    const client = fakeClient(
      [
        summary({ deviceId: OLD_DEVICE, generation: 1, updatedAt: '2026-08-01T00:00:00Z' }),
        summary({ deviceId: NEW_DEVICE, generation: 1, updatedAt: '2026-08-09T00:00:00Z' })
      ],
      logs
    )
    const storage = fakeStorage()

    const result = await restoreOnImport(deps({ storage, client }))

    expect(result.deviceId).toBe(NEW_DEVICE)
    const merged = JSON.parse(storage.kv.get('localpay_pending'))
    expect(merged.map((p: any) => p.id).sort()).toEqual(['p-new', 'p-old'])
  })

  it('a replayed row never calls anything but getKeyValue/setKeyValue — no internalize, broadcast or abort', async () => {
    // The concrete safety property the ledger asks for. This fake storage exposes exactly
    // the methods a real StorageExpoSQLite (plus the toolbox's own processSyncChunk
    // preconditions) needs for an ordinary restore — no internalizeAction, no broadcast, no
    // abortAction anywhere on it — so a passing restore here is a structural guarantee, not
    // just a behavioural one: there is nothing else on this double for a regression to call.
    const w = deriveBackupWallet(PRIMARY, 'main')
    const chunk = await encodeChunk(w, chunkWithTx('aaa'), 'main', undefined, {
      localpayPending: '[{"id":"p1"}]',
      peerpayOutbox: '[{"id":"o1","delivered":true}]',
      receiveIssuedDates: ['2026-08-01']
    })
    const client = fakeClient([summary({ deviceId: OLD_DEVICE, generation: 1 })], {
      [`${OLD_DEVICE}/1`]: [chunk]
    })
    const storage = fakeStorage()

    const result = await restoreOnImport(deps({ storage, client }))

    expect(result.restored).toBe(true)
    expect(storage.setKeyValue).toHaveBeenCalledWith('localpay_pending', '[{"id":"p1"}]')
    expect(storage.setKeyValue).toHaveBeenCalledWith('peerpay_outbox', '[{"id":"o1","delivered":true}]')
    expect(storage.setKeyValue).toHaveBeenCalledWith('pay_receive_issued_dates', JSON.stringify(['2026-08-01']))
  })
})
