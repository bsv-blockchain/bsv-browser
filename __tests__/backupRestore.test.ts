import { Hash, PrivateKey, Utils } from '@bsv/sdk'
import type { LogEntry } from '@bsv/expo-wallet-toolbox/core/backup/client'
import { MAX_INDEX_ENTRIES } from '@bsv/expo-wallet-toolbox/core/backup/constants'
import { encodeChunk, emptyChunk, isEmptyChunk } from '@bsv/expo-wallet-toolbox/core/backup/codec'
import { deriveBackupWallet } from '@bsv/expo-wallet-toolbox/core/backup/derive'
import { BackupChainError, RemoteSyncReader } from '@bsv/expo-wallet-toolbox/core/backup/RemoteSyncReader'
import type { SyncChunk } from '@bsv/expo-wallet-toolbox/core/toolboxTypes'

const PRIMARY = new PrivateKey(21).toArray('be', 32)
const DEVICE = 'd'.repeat(32)
const SETTINGS = { storageIdentityKey: 'local-storage-key' } as any

const args = {
  identityKey: 'ik', fromStorageIdentityKey: 'a', toStorageIdentityKey: 'b',
  maxRoughSize: 0, maxItems: 0, offsets: []
} as any

function chunkWithTx (txid: string): SyncChunk {
  const c = emptyChunk('a', 'b', 'user') as unknown as Record<string, unknown[]>
  c.provenTxs = [{ provenTxId: 1, txid, rawTx: [1, 2, 3] }]
  return c as unknown as SyncChunk
}

/** Same digest RemoteSyncReader now checks a downloaded blob against — kept alongside the
 * fixtures below so every fake index entry's sha256/size genuinely describes its blob. */
function sha256Hex (bytes: Uint8Array | number[]): string {
  return Utils.toHex(Hash.sha256(bytes as number[]))
}

/** A client backed by an in-memory log, standing in for the server. */
function fakeClient (blobs: number[][], entries?: LogEntry[]): any {
  const index: LogEntry[] = entries ?? blobs.map((b, i) => ({
    seq: i + 1,
    sha256: sha256Hex(b),
    prevSha256: i === 0 ? undefined : sha256Hex(blobs[i - 1]),
    size: b.length,
    createdAt: '2026-08-15T00:00:00Z'
  }))
  return {
    index: jest.fn().mockResolvedValue(index),
    blob: jest.fn(async (_d: string, _g: number, seq: number) => blobs[seq - 1]),
    manifest: jest.fn().mockResolvedValue([]),
    append: jest.fn(),
    pruneGeneration: jest.fn()
  }
}

describe('RemoteSyncReader', () => {
  it('returns chunks in sequence order', async () => {
    const w = deriveBackupWallet(PRIMARY, 'main')
    const blobs = [
      await encodeChunk(w, chunkWithTx('aaa'), 'main'),
      await encodeChunk(w, chunkWithTx('bbb'), 'main')
    ]
    const reader = new RemoteSyncReader(fakeClient(blobs), w, 'main', DEVICE, 1, SETTINGS)

    expect((await reader.getSyncChunk(args)).provenTxs?.[0].txid).toBe('aaa')
    expect((await reader.getSyncChunk(args)).provenTxs?.[0].txid).toBe('bbb')
  })

  it('signals completion with an all-empty chunk', async () => {
    // The toolbox treats an empty chunk as the completion sentinel, and needs every one of
    // the twelve arrays present rather than undefined.
    const w = deriveBackupWallet(PRIMARY, 'main')
    const reader = new RemoteSyncReader(fakeClient([await encodeChunk(w, chunkWithTx('aaa'), 'main')]), w, 'main', DEVICE, 1, SETTINGS)

    await reader.getSyncChunk(args)
    const done = await reader.getSyncChunk(args)

    expect(isEmptyChunk(done)).toBe(true)
    expect(Array.isArray(done.outputs)).toBe(true)
    expect(Array.isArray(done.certificateFields)).toBe(true)
  })

  it('rejects a log with a missing sequence', async () => {
    // A gap means the restore would be silently incomplete — the wallet would look healthy
    // while missing outputs it needs to spend. Failing loudly is the safer outcome.
    const w = deriveBackupWallet(PRIMARY, 'main')
    const blobs = [await encodeChunk(w, chunkWithTx('aaa'), 'main')]
    const broken: LogEntry[] = [
      { seq: 2, sha256: 'sha2', prevSha256: 'sha1', size: 1, createdAt: 'z' }
    ]

    const reader = new RemoteSyncReader(fakeClient(blobs, broken), w, 'main', DEVICE, 1, SETTINGS)
    await expect(reader.getSyncChunk(args)).rejects.toBeInstanceOf(BackupChainError)
  })

  it('rejects a forked chain', async () => {
    const w = deriveBackupWallet(PRIMARY, 'main')
    const blobs = [
      await encodeChunk(w, chunkWithTx('aaa'), 'main'),
      await encodeChunk(w, chunkWithTx('bbb'), 'main')
    ]
    const forked: LogEntry[] = [
      { seq: 1, sha256: 'sha1', prevSha256: undefined, size: 1, createdAt: 'z' },
      { seq: 2, sha256: 'sha2', prevSha256: 'NOT-sha1', size: 1, createdAt: 'z' }
    ]

    const reader = new RemoteSyncReader(fakeClient(blobs, forked), w, 'main', DEVICE, 1, SETTINGS)
    await expect(reader.getSyncChunk(args)).rejects.toThrow(/forked/)
  })

  it('cannot decrypt a log written by a different wallet', async () => {
    const mine = deriveBackupWallet(PRIMARY, 'main')
    const theirs = deriveBackupWallet(new PrivateKey(22).toArray('be', 32), 'main')
    const blobs = [await encodeChunk(theirs, chunkWithTx('aaa'), 'main')]

    const reader = new RemoteSyncReader(fakeClient(blobs), mine, 'main', DEVICE, 1, SETTINGS)
    await expect(reader.getSyncChunk(args)).rejects.toThrow()
  })

  it('cannot decrypt a log written by the same wallet on another network', async () => {
    // The cross-network restore scenario this feature exists to prevent: same seed,
    // blobs written on mainnet, reader operating on testnet. Must fail outright.
    const main = deriveBackupWallet(PRIMARY, 'main')
    const test = deriveBackupWallet(PRIMARY, 'test')
    const blobs = [await encodeChunk(main, chunkWithTx('aaa'), 'main')]

    const reader = new RemoteSyncReader(fakeClient(blobs), test, 'test', DEVICE, 1, SETTINGS)
    await expect(reader.getSyncChunk(args)).rejects.toThrow()
  })

  it('reads the index once, not per chunk', async () => {
    const w = deriveBackupWallet(PRIMARY, 'main')
    const blobs = [
      await encodeChunk(w, chunkWithTx('aaa'), 'main'),
      await encodeChunk(w, chunkWithTx('bbb'), 'main')
    ]
    const client = fakeClient(blobs)
    const reader = new RemoteSyncReader(client, w, 'main', DEVICE, 1, SETTINGS)

    await reader.getSyncChunk(args)
    await reader.getSyncChunk(args)
    await reader.getSyncChunk(args)

    expect(client.index).toHaveBeenCalledTimes(1)
  })

  it('round-trips a chunk through encode and restore byte-exactly', async () => {
    // The property the whole feature depends on: what a restore replays is exactly what
    // the push captured, including the binary fields that make outputs spendable.
    const w = deriveBackupWallet(PRIMARY, 'main')
    const original = emptyChunk('a', 'b', 'user') as unknown as Record<string, unknown[]>
    original.outputs = [{
      outputId: 1,
      senderIdentityKey: '02' + 'cd'.repeat(32),
      derivationPrefix: 'cHJlZml4',
      derivationSuffix: 'c3VmZml4',
      lockingScript: Array.from({ length: 64 }, (_, i) => i)
    }]

    const blobs = [await encodeChunk(w, original as unknown as SyncChunk, 'main')]
    const reader = new RemoteSyncReader(fakeClient(blobs), w, 'main', DEVICE, 1, SETTINGS)
    const restored = await reader.getSyncChunk(args) as any

    // This metadata exists only in the database and is exactly why the seed alone cannot
    // recover a wallet.
    expect(restored.outputs[0].senderIdentityKey).toBe('02' + 'cd'.repeat(32))
    expect(restored.outputs[0].derivationPrefix).toBe('cHJlZml4')
    expect(restored.outputs[0].derivationSuffix).toBe('c3VmZml4')
    expect(restored.outputs[0].lockingScript).toEqual(Array.from({ length: 64 }, (_, i) => i))
  })

  it('XR-014: rejects a blob whose bytes disagree with the index entry it was fetched for', async () => {
    // Decryption alone cannot catch this: the AEAD envelope authenticates only
    // {chain, chunk, seal} (see codec.ts), never the position a chunk was appended at, so a
    // same-wallet ciphertext that is genuinely authentic FOR SEQUENCE 1 still decrypts
    // cleanly if a compromised/malicious backup service serves it back for sequence 2. The
    // index (also server-controlled) still truthfully reports sequence 2's OWN digest/size
    // for that slot, so comparing the downloaded bytes against it catches the swap.
    const w = deriveBackupWallet(PRIMARY, 'main')
    const seq1 = await encodeChunk(w, chunkWithTx('aaa'), 'main')
    const seq2 = await encodeChunk(w, chunkWithTx('bbb'), 'main')
    const client = fakeClient([seq1, seq2])
    const realBlob = client.blob
    client.blob = jest.fn(async (d: string, g: number, seq: number) =>
      seq === 2 ? await realBlob(d, g, 1) : await realBlob(d, g, seq))

    const reader = new RemoteSyncReader(client, w, 'main', DEVICE, 1, SETTINGS)
    // Sequence 1 is served honestly, so replay reaches the tampered sequence 2 before failing.
    expect((await reader.getSyncChunk(args)).provenTxs?.[0].txid).toBe('aaa')
    await expect(reader.getSyncChunk(args)).rejects.toThrow(/digest|does not match/i)
  })
})


describe('RemoteSyncReader reliability and scheduling', () => {
  const wallet = () => ({ decrypt: jest.fn(async () => ({
    plaintext: Utils.toArray(JSON.stringify({ chain: 'main', chunk: chunkWithTx('restored') }), 'utf8')
  })) }) as any
  // Every seq below is served the same one-byte blob (see `blob` mocks in this describe
  // block), so every entry can legitimately share that blob's own digest/size.
  const ONE_BYTE_SHA = sha256Hex([1])
  const entries = (n: number): LogEntry[] => Array.from({ length: n }, (_, i) => ({
    seq: i + 1, sha256: ONE_BYTE_SHA, prevSha256: i ? ONE_BYTE_SHA : undefined,
    size: 1, createdAt: '2026-09-05T00:00:00Z'
  }))

  it('XR-013: throws once the index grows past the entry ceiling, rather than accumulating without bound', async () => {
    // No expectedHeadSeq and always a full page: nothing but the ceiling itself can ever
    // stop this loop — exactly a malicious/compromised backup host that keeps paging
    // forever to grow entries[] (and eventually every downloaded blob) without bound.
    const pool = entries(MAX_INDEX_ENTRIES + 600)
    const client = {
      index: jest.fn(async (_d: string, _g: number, from = 1) => pool.slice(from - 1, from - 1 + 500)),
      // Real, matching content for entry 1 — so an unbounded index would otherwise let this
      // resolve normally instead of merely failing on an unrelated unconfigured mock.
      blob: jest.fn().mockResolvedValue(new Uint8Array([1]))
    }
    const reader = new RemoteSyncReader(client as any, wallet(), 'main', DEVICE, 1, SETTINGS)
    await expect(reader.getSyncChunk(args)).rejects.toThrow(/index has grown past|ceiling/i)
    expect(client.blob).not.toHaveBeenCalled()
  })

  it('reads beyond the server 500-entry page limit and replays every chunk in order', async () => {
    const all = entries(501)
    const client = {
      index: jest.fn(async (_d, _g, from = 1) => all.slice(from - 1, from - 1 + 500)),
      blob: jest.fn(async () => new Uint8Array([1]))
    }
    const reader = new RemoteSyncReader(client as any, wallet(), 'main', DEVICE, 1, SETTINGS, 501)
    for (let i = 0; i < 501; i++) expect(isEmptyChunk(await reader.getSyncChunk(args))).toBe(false)
    expect(isEmptyChunk(await reader.getSyncChunk(args))).toBe(true)
    expect(reader.length).toBe(501)
    expect(client.index.mock.calls).toEqual([[DEVICE, 1], [DEVICE, 1, 501]])
    expect(client.blob.mock.calls.map((call: any) => call[2])).toEqual(all.map(e => e.seq))
  })

  it('rejects an index that stops before the manifest head, before replaying any data', async () => {
    const client = {
      index: jest.fn().mockResolvedValueOnce(entries(1)).mockResolvedValueOnce([]),
      blob: jest.fn()
    }
    const reader = new RemoteSyncReader(client as any, wallet(), 'main', DEVICE, 1, SETTINGS, 2)
    await expect(reader.getSyncChunk(args)).rejects.toThrow(/advertised head/)
    expect(client.blob).not.toHaveBeenCalled()
  })

  it('does not cache an invalid index across retries', async () => {
    const client = { index: jest.fn().mockResolvedValue([{ ...entries(1)[0], seq: 2 }]), blob: jest.fn() }
    const reader = new RemoteSyncReader(client as any, wallet(), 'main', DEVICE, 1, SETTINGS)
    await expect(reader.getSyncChunk(args)).rejects.toThrow(/gap/)
    await expect(reader.getSyncChunk(args)).rejects.toThrow(/gap/)
    expect(client.blob).not.toHaveBeenCalled()
  })

  it('retries the same sequence after a download or decryption failure', async () => {
    const w = wallet()
    w.decrypt.mockRejectedValueOnce(new Error('decode failed'))
    const client = {
      index: jest.fn().mockResolvedValue(entries(1)),
      blob: jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(new Uint8Array([1]))
    }
    const reader = new RemoteSyncReader(client as any, w, 'main', DEVICE, 1, SETTINGS)
    await expect(reader.getSyncChunk(args)).rejects.toThrow('offline')
    await expect(reader.getSyncChunk(args)).rejects.toThrow('decode failed')
    expect(isEmptyChunk(await reader.getSyncChunk(args))).toBe(false)
    expect(client.blob.mock.calls.map(call => call[2])).toEqual([1, 1, 1])
  })

  it('downloads only one small chunk ahead while the caller replays, without reordering', async () => {
    const client = { index: jest.fn().mockResolvedValue(entries(3)), blob: jest.fn().mockResolvedValue(new Uint8Array([1])) }
    const reader = new RemoteSyncReader(client as any, wallet(), 'main', DEVICE, 1, SETTINGS)
    await reader.getSyncChunk(args)
    expect(client.blob.mock.calls.map(call => call[2])).toEqual([1, 2])
    await reader.getSyncChunk(args)
    expect(client.blob.mock.calls.map(call => call[2])).toEqual([1, 2, 3])
    await reader.getSyncChunk(args)
    expect(client.blob).toHaveBeenCalledTimes(3)
  })

  it('keeps large chunks sequential to avoid doubling mobile memory pressure', async () => {
    // Only the FIRST entry is ever actually downloaded here (prefetch of the second is
    // skipped because both are over the prefetch threshold), so only it needs bytes that
    // truly match its declared size/digest — the second is never fetched or checked.
    const big = new Uint8Array(2 * 1024 * 1024)
    const bigSha = sha256Hex(big)
    const index = entries(2).map(e => ({ ...e, size: big.length, sha256: bigSha, prevSha256: bigSha }))
    ;(index[0] as { prevSha256?: string }).prevSha256 = undefined
    const client = { index: jest.fn().mockResolvedValue(index), blob: jest.fn().mockResolvedValue(big) }
    const reader = new RemoteSyncReader(client as any, wallet(), 'main', DEVICE, 1, SETTINGS)
    await reader.getSyncChunk(args)
    expect(client.blob).toHaveBeenCalledTimes(1)
  })

  it('surfaces a failed prefetch when consumed and retries that sequence', async () => {
    const client = {
      index: jest.fn().mockResolvedValue(entries(2)),
      blob: jest.fn().mockResolvedValueOnce(new Uint8Array([1])).mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue(new Uint8Array([1]))
    }
    const reader = new RemoteSyncReader(client as any, wallet(), 'main', DEVICE, 1, SETTINGS)
    await reader.getSyncChunk(args)
    await new Promise(resolve => setImmediate(resolve))
    await expect(reader.getSyncChunk(args)).rejects.toThrow('offline')
    expect(isEmptyChunk(await reader.getSyncChunk(args))).toBe(false)
    expect(client.blob.mock.calls.map(call => call[2])).toEqual([1, 2, 2])
  })
})

// ── seals — P1-backup-incomplete-generation ─────────────────────────────────
describe('RemoteSyncReader seals', () => {
  /** Chunks encrypted for real via the same wallet, the last one optionally sealed. */
  async function logWith (
    w: ReturnType<typeof deriveBackupWallet>,
    chunkTxids: string[],
    seal: { generation: number, initialChunkCount: number } | null
  ): Promise<{ blobs: number[][], entries: LogEntry[] }> {
    const blobs: number[][] = []
    for (let i = 0; i < chunkTxids.length; i++) {
      const sealThis = seal != null && i === chunkTxids.length - 1 ? seal : undefined
      blobs.push(await encodeChunk(w, chunkWithTx(chunkTxids[i]), 'main', sealThis))
    }
    const entries: LogEntry[] = blobs.map((b, i) => ({
      seq: i + 1,
      sha256: sha256Hex(b),
      prevSha256: i === 0 ? undefined : sha256Hex(blobs[i - 1]),
      size: b.length,
      createdAt: '2026-09-20T00:00:00Z'
    }))
    return { blobs, entries }
  }

  it('yields every entry to the caller, seal or not, and counts them all in length', async () => {
    const w = deriveBackupWallet(PRIMARY, 'main')
    const { blobs, entries } = await logWith(w, ['aaa', 'bbb'], { generation: 1, initialChunkCount: 2 })
    const reader = new RemoteSyncReader(fakeClient(blobs, entries), w, 'main', DEVICE, 1, SETTINGS)

    expect((await reader.getSyncChunk(args)).provenTxs?.[0].txid).toBe('aaa')
    expect((await reader.getSyncChunk(args)).provenTxs?.[0].txid).toBe('bbb')
    expect(isEmptyChunk(await reader.getSyncChunk(args))).toBe(true)
    expect(reader.length).toBe(2)
  })

  it('reports verifiedComplete true when the newest entry carries a seal for this generation whose initialChunkCount is covered', async () => {
    const w = deriveBackupWallet(PRIMARY, 'main')
    const { blobs, entries } = await logWith(w, ['aaa', 'bbb'], { generation: 1, initialChunkCount: 2 })
    const reader = new RemoteSyncReader(fakeClient(blobs, entries), w, 'main', DEVICE, 1, SETTINGS)

    await expect(reader.verifiedComplete()).resolves.toBe(true)
  })

  it('reports verifiedComplete false when there is no seal at all', async () => {
    const w = deriveBackupWallet(PRIMARY, 'main')
    const { blobs, entries } = await logWith(w, ['aaa', 'bbb'], null)
    const reader = new RemoteSyncReader(fakeClient(blobs, entries), w, 'main', DEVICE, 1, SETTINGS)

    await expect(reader.verifiedComplete()).resolves.toBe(false)
  })

  it('reports verifiedComplete false when the newest seal names another generation', async () => {
    const w = deriveBackupWallet(PRIMARY, 'main')
    const { blobs, entries } = await logWith(w, ['aaa', 'bbb'], { generation: 2, initialChunkCount: 2 })
    const reader = new RemoteSyncReader(fakeClient(blobs, entries), w, 'main', DEVICE, 1, SETTINGS)

    await expect(reader.verifiedComplete()).resolves.toBe(false)
  })

  it('reports verifiedComplete false when the seal claims more chunks than the log holds', async () => {
    const w = deriveBackupWallet(PRIMARY, 'main')
    // Only two real chunks exist, but the seal (forged/corrupted) claims three.
    const { blobs, entries } = await logWith(w, ['aaa', 'bbb'], { generation: 1, initialChunkCount: 3 })
    const reader = new RemoteSyncReader(fakeClient(blobs, entries), w, 'main', DEVICE, 1, SETTINGS)

    await expect(reader.verifiedComplete()).resolves.toBe(false)
  })

  it('a legacy log with no seal on any entry reports verifiedComplete false', async () => {
    const w = deriveBackupWallet(PRIMARY, 'main')
    const { blobs, entries } = await logWith(w, ['aaa', 'bbb', 'ccc'], null)
    const reader = new RemoteSyncReader(fakeClient(blobs, entries), w, 'main', DEVICE, 1, SETTINGS)

    await expect(reader.verifiedComplete()).resolves.toBe(false)
  })

  it('stays verifiedComplete once further deltas land, because every later chunk carries the same seal', async () => {
    // Unlike a one-shot marker entry, the seal rides on EVERY chunk appended after the
    // initial window closes — so a generation that keeps receiving ordinary deltas stays
    // provably complete, rather than losing its proof the moment a new chunk becomes the
    // newest entry. See push.ts's pushOnce.
    const w = deriveBackupWallet(PRIMARY, 'main')
    const sealed = await logWith(w, ['aaa', 'bbb'], { generation: 1, initialChunkCount: 2 })
    const extra = await encodeChunk(w, chunkWithTx('ccc'), 'main', { generation: 1, initialChunkCount: 2 })
    const blobs = [...sealed.blobs, extra]
    const entries: LogEntry[] = [
      ...sealed.entries,
      {
        seq: 3,
        sha256: sha256Hex(extra),
        prevSha256: sealed.entries[sealed.entries.length - 1].sha256,
        size: extra.length,
        createdAt: '2026-09-21T00:00:00Z'
      }
    ]
    const reader = new RemoteSyncReader(fakeClient(blobs, entries), w, 'main', DEVICE, 1, SETTINGS)

    await expect(reader.verifiedComplete()).resolves.toBe(true)
    expect((await reader.getSyncChunk(args)).provenTxs?.[0].txid).toBe('aaa')
    expect((await reader.getSyncChunk(args)).provenTxs?.[0].txid).toBe('bbb')
    expect((await reader.getSyncChunk(args)).provenTxs?.[0].txid).toBe('ccc')
    expect(isEmptyChunk(await reader.getSyncChunk(args))).toBe(true)
    expect(reader.length).toBe(3)
  })

  it('does not re-fetch or re-decrypt the entry replay later reaches', async () => {
    const w = deriveBackupWallet(PRIMARY, 'main')
    const { blobs, entries } = await logWith(w, ['aaa'], { generation: 1, initialChunkCount: 1 })
    const client = fakeClient(blobs, entries)

    const reader = new RemoteSyncReader(client, w, 'main', DEVICE, 1, SETTINGS)
    await reader.verifiedComplete()
    const blobCallsAfterVerify = client.blob.mock.calls.length

    await reader.getSyncChunk(args) // 'aaa', already decoded by verifiedComplete's look-ahead

    // Only one entry exists (seq 1); replay must reuse verifiedComplete's decode of it
    // rather than downloading and decrypting it a second time.
    expect(client.blob.mock.calls.filter((c: any[]) => c[2] === 1).length).toBe(blobCallsAfterVerify)
  })
})

// ── XR-011: appData ──────────────────────────────────────────────────────────
describe('RemoteSyncReader appData', () => {
  it('is undefined before anything has been replayed, and for a log with no appData at all', async () => {
    const w = deriveBackupWallet(PRIMARY, 'main')
    const reader = new RemoteSyncReader(fakeClient([await encodeChunk(w, chunkWithTx('aaa'), 'main')]), w, 'main', DEVICE, 1, SETTINGS)

    expect(reader.appData).toBeUndefined()
    await reader.getSyncChunk(args)
    expect(reader.appData).toBeUndefined()
  })

  it('reflects the newest entry replayed so far, updating as replay proceeds', async () => {
    const w = deriveBackupWallet(PRIMARY, 'main')
    const first = await encodeChunk(w, chunkWithTx('aaa'), 'main', undefined, { localpayPending: '[{"id":"p1"}]' })
    const second = await encodeChunk(w, chunkWithTx('bbb'), 'main', undefined, { localpayPending: '[{"id":"p1"},{"id":"p2"}]' })
    const reader = new RemoteSyncReader(fakeClient([first, second]), w, 'main', DEVICE, 1, SETTINGS)

    await reader.getSyncChunk(args)
    expect(reader.appData).toEqual({ localpayPending: '[{"id":"p1"}]' })

    await reader.getSyncChunk(args)
    expect(reader.appData).toEqual({ localpayPending: '[{"id":"p1"},{"id":"p2"}]' })
  })

  it('keeps the last known snapshot when a later entry carries none at all (never regresses to undefined)', async () => {
    const w = deriveBackupWallet(PRIMARY, 'main')
    const withAppData = await encodeChunk(w, chunkWithTx('aaa'), 'main', undefined, { peerpayOutbox: '[{"id":"o1"}]' })
    const withoutAppData = await encodeChunk(w, chunkWithTx('bbb'), 'main')
    const reader = new RemoteSyncReader(fakeClient([withAppData, withoutAppData]), w, 'main', DEVICE, 1, SETTINGS)

    await reader.getSyncChunk(args)
    await reader.getSyncChunk(args)

    expect(reader.appData).toEqual({ peerpayOutbox: '[{"id":"o1"}]' })
  })

  it('still captures appData when the entry was already decoded ahead of time by verifiedComplete', async () => {
    // verifiedComplete decodes the LAST entry up front and caches it (decodedCache) purely to
    // rank restore candidates; when replay's own sequential pointer later reaches that same
    // entry, getSyncChunk must still read its appData off the cache-hit path, not only off a
    // fresh decode.
    const w = deriveBackupWallet(PRIMARY, 'main')
    const only = await encodeChunk(w, chunkWithTx('aaa'), 'main', undefined, { localpayPending: '[{"id":"p1"}]' })
    const client = fakeClient([only])
    const reader = new RemoteSyncReader(client, w, 'main', DEVICE, 1, SETTINGS)

    await reader.verifiedComplete()
    expect(reader.appData).toBeUndefined() // look-ahead alone must not publish it early

    await reader.getSyncChunk(args)
    expect(reader.appData).toEqual({ localpayPending: '[{"id":"p1"}]' })
  })
})
