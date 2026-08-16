import { PrivateKey } from '@bsv/sdk'
import type { SyncChunk } from '@bsv/wallet-toolbox-mobile/out/src/sdk/WalletStorage.interfaces'
import type { LogEntry } from '@/utils/backup/client'
import { encodeChunk, emptyChunk, isEmptyChunk } from '@/utils/backup/codec'
import { deriveBackupWallet } from '@/utils/backup/derive'
import { BackupChainError, RemoteSyncReader } from '@/utils/backup/RemoteSyncReader'

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

/** A client backed by an in-memory log, standing in for the server. */
function fakeClient (blobs: number[][], entries?: LogEntry[]): any {
  const index: LogEntry[] = entries ?? blobs.map((b, i) => ({
    seq: i + 1,
    sha256: `sha${i + 1}`,
    prevSha256: i === 0 ? undefined : `sha${i}`,
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
    const w = deriveBackupWallet(PRIMARY)
    const blobs = [
      await encodeChunk(w, chunkWithTx('aaa')),
      await encodeChunk(w, chunkWithTx('bbb'))
    ]
    const reader = new RemoteSyncReader(fakeClient(blobs), w, DEVICE, 1, SETTINGS)

    expect((await reader.getSyncChunk(args)).provenTxs?.[0].txid).toBe('aaa')
    expect((await reader.getSyncChunk(args)).provenTxs?.[0].txid).toBe('bbb')
  })

  it('signals completion with an all-empty chunk', async () => {
    // The toolbox treats an empty chunk as the completion sentinel, and needs every one of
    // the twelve arrays present rather than undefined.
    const w = deriveBackupWallet(PRIMARY)
    const reader = new RemoteSyncReader(fakeClient([await encodeChunk(w, chunkWithTx('aaa'))]), w, DEVICE, 1, SETTINGS)

    await reader.getSyncChunk(args)
    const done = await reader.getSyncChunk(args)

    expect(isEmptyChunk(done)).toBe(true)
    expect(Array.isArray(done.outputs)).toBe(true)
    expect(Array.isArray(done.certificateFields)).toBe(true)
  })

  it('rejects a log with a missing sequence', async () => {
    // A gap means the restore would be silently incomplete — the wallet would look healthy
    // while missing outputs it needs to spend. Failing loudly is the safer outcome.
    const w = deriveBackupWallet(PRIMARY)
    const blobs = [await encodeChunk(w, chunkWithTx('aaa'))]
    const broken: LogEntry[] = [
      { seq: 2, sha256: 'sha2', prevSha256: 'sha1', size: 1, createdAt: 'z' }
    ]

    const reader = new RemoteSyncReader(fakeClient(blobs, broken), w, DEVICE, 1, SETTINGS)
    await expect(reader.getSyncChunk(args)).rejects.toBeInstanceOf(BackupChainError)
  })

  it('rejects a forked chain', async () => {
    const w = deriveBackupWallet(PRIMARY)
    const blobs = [
      await encodeChunk(w, chunkWithTx('aaa')),
      await encodeChunk(w, chunkWithTx('bbb'))
    ]
    const forked: LogEntry[] = [
      { seq: 1, sha256: 'sha1', prevSha256: undefined, size: 1, createdAt: 'z' },
      { seq: 2, sha256: 'sha2', prevSha256: 'NOT-sha1', size: 1, createdAt: 'z' }
    ]

    const reader = new RemoteSyncReader(fakeClient(blobs, forked), w, DEVICE, 1, SETTINGS)
    await expect(reader.getSyncChunk(args)).rejects.toThrow(/forked/)
  })

  it('cannot decrypt a log written by a different wallet', async () => {
    const mine = deriveBackupWallet(PRIMARY)
    const theirs = deriveBackupWallet(new PrivateKey(22).toArray('be', 32))
    const blobs = [await encodeChunk(theirs, chunkWithTx('aaa'))]

    const reader = new RemoteSyncReader(fakeClient(blobs), mine, DEVICE, 1, SETTINGS)
    await expect(reader.getSyncChunk(args)).rejects.toThrow()
  })

  it('reads the index once, not per chunk', async () => {
    const w = deriveBackupWallet(PRIMARY)
    const blobs = [
      await encodeChunk(w, chunkWithTx('aaa')),
      await encodeChunk(w, chunkWithTx('bbb'))
    ]
    const client = fakeClient(blobs)
    const reader = new RemoteSyncReader(client, w, DEVICE, 1, SETTINGS)

    await reader.getSyncChunk(args)
    await reader.getSyncChunk(args)
    await reader.getSyncChunk(args)

    expect(client.index).toHaveBeenCalledTimes(1)
  })

  it('round-trips a chunk through encode and restore byte-exactly', async () => {
    // The property the whole feature depends on: what a restore replays is exactly what
    // the push captured, including the binary fields that make outputs spendable.
    const w = deriveBackupWallet(PRIMARY)
    const original = emptyChunk('a', 'b', 'user') as unknown as Record<string, unknown[]>
    original.outputs = [{
      outputId: 1,
      senderIdentityKey: '02' + 'cd'.repeat(32),
      derivationPrefix: 'cHJlZml4',
      derivationSuffix: 'c3VmZml4',
      lockingScript: Array.from({ length: 64 }, (_, i) => i)
    }]

    const blobs = [await encodeChunk(w, original as unknown as SyncChunk)]
    const reader = new RemoteSyncReader(fakeClient(blobs), w, DEVICE, 1, SETTINGS)
    const restored = await reader.getSyncChunk(args) as any

    // This metadata exists only in the database and is exactly why the seed alone cannot
    // recover a wallet.
    expect(restored.outputs[0].senderIdentityKey).toBe('02' + 'cd'.repeat(32))
    expect(restored.outputs[0].derivationPrefix).toBe('cHJlZml4')
    expect(restored.outputs[0].derivationSuffix).toBe('c3VmZml4')
    expect(restored.outputs[0].lockingScript).toEqual(Array.from({ length: 64 }, (_, i) => i))
  })
})
