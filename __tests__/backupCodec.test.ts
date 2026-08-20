import { PrivateKey } from '@bsv/sdk'
import type { SyncChunk } from '@bsv/wallet-toolbox-mobile/out/src/sdk/WalletStorage.interfaces'
import { CHUNK_ENTITIES, decodeChunk, emptyChunk, encodeChunk, isEmptyChunk } from '@/utils/backup/codec'
import { deriveBackupWallet } from '@/utils/backup/derive'

const KEY = new PrivateKey(7).toArray('be', 32)

/** Every byte value, so a lossy encoding cannot slip through. */
const ALL_BYTES = Array.from({ length: 256 }, (_, i) => i)

function chunkWithBinary (): SyncChunk {
  const base = emptyChunk('from', 'to', 'user') as unknown as Record<string, unknown>
  base.provenTxs = [{
    provenTxId: 1,
    txid: 'deadbeefcafe',
    height: 800000,
    index: 0,
    merklePath: ALL_BYTES,
    rawTx: ALL_BYTES,
    blockHash: 'abc'
  }]
  return base as unknown as SyncChunk
}

describe('backup chunk codec', () => {
  it('round-trips binary fields byte-exactly', async () => {
    const w = deriveBackupWallet(KEY)
    const decoded = await decodeChunk(w, await encodeChunk(w, chunkWithBinary()))

    expect(decoded.provenTxs?.[0].rawTx).toEqual(ALL_BYTES)
    expect(decoded.provenTxs?.[0].merklePath).toEqual(ALL_BYTES)
  })

  it('returns binary fields as number[], not Uint8Array', async () => {
    // The toolbox's processSyncChunk expects number[]; handing it a typed array would
    // fail deep inside storage rather than here.
    const w = deriveBackupWallet(KEY)
    const decoded = await decodeChunk(w, await encodeChunk(w, chunkWithBinary()))

    expect(Array.isArray(decoded.provenTxs?.[0].rawTx)).toBe(true)
    expect(decoded.provenTxs?.[0].rawTx).not.toBeInstanceOf(Uint8Array)
  })

  it('revives created_at/updated_at as Date instances', async () => {
    // BinaryJson has no Date support: encode writes ISO strings. The merge
    // entities call .getTime() on these columns (EntityProvenTxReq.mergeExisting
    // crashed the real on-device restore on a string), so decode must revive
    // them. Other string fields must stay strings.
    const w = deriveBackupWallet(KEY)
    const base = emptyChunk('from', 'to', 'user') as unknown as Record<string, unknown>
    base.provenTxReqs = [{
      provenTxReqId: 1,
      created_at: new Date('2026-01-02T03:04:05.000Z'),
      updated_at: new Date('2026-02-03T04:05:06.000Z'),
      txid: 'aa',
      status: 'completed',
      attempts: 0,
      notified: false,
      history: '{}',
      notify: '{}',
      rawTx: ALL_BYTES
    }]
    const decoded = await decodeChunk(w, await encodeChunk(w, base as unknown as SyncChunk))
    const req = decoded.provenTxReqs?.[0] as any
    expect(req.created_at).toBeInstanceOf(Date)
    expect(req.updated_at).toBeInstanceOf(Date)
    expect(req.updated_at.getTime()).toBe(new Date('2026-02-03T04:05:06.000Z').getTime())
    expect(typeof req.txid).toBe('string')
    expect(typeof req.history).toBe('string')
  })

  it('packs byte arrays instead of expanding them to decimal', async () => {
    // Without packing, binaryJsonReplacer ignores number[] — every binary field on the
    // toolbox's tables is typed number[] — and each byte costs ~2.9 characters as decimal
    // against ~1.37 as base64. On a realistically sized transaction the payload should
    // therefore land near half the naive size; 0.7 leaves room for the JSON envelope and
    // the 48-byte AES-GCM overhead without making the test meaningless.
    const w = deriveBackupWallet(KEY)
    const chunk = emptyChunk('a', 'b', 'c') as unknown as Record<string, unknown>
    const rawTx = Array.from({ length: 2048 }, (_, i) => i % 256)
    chunk.provenTxs = [{ provenTxId: 1, txid: 'ab', height: 1, index: 0, rawTx, merklePath: rawTx }]

    const packed = (await encodeChunk(w, chunk as unknown as SyncChunk)).length
    const naive = JSON.stringify(chunk).length

    expect(packed).toBeLessThan(naive * 0.7)
  })

  it('preserves all twelve entity arrays', async () => {
    // The toolbox's consumer loops forever on an undefined entity array rather than
    // treating it as empty, so every one must survive the round trip.
    const w = deriveBackupWallet(KEY)
    const decoded = await decodeChunk(w, await encodeChunk(w, chunkWithBinary())) as unknown as Record<string, unknown>

    for (const name of CHUNK_ENTITIES) {
      expect(Array.isArray(decoded[name])).toBe(true)
    }
  })

  it('leaves short numeric arrays untouched in value', async () => {
    const w = deriveBackupWallet(KEY)
    const chunk = emptyChunk('a', 'b', 'c') as unknown as Record<string, unknown>
    chunk.outputs = [{ outputId: 1, tags: [1, 2, 3], vout: 0 }]

    const decoded = await decodeChunk(w, await encodeChunk(w, chunk as unknown as SyncChunk)) as unknown as Record<string, any>
    expect(decoded.outputs[0].tags).toEqual([1, 2, 3])
  })

  it('round-trips a long non-byte numeric array unchanged', async () => {
    // Values above 255 must not be mistaken for bytes.
    const w = deriveBackupWallet(KEY)
    const big = Array.from({ length: 64 }, (_, i) => 1000 + i)
    const chunk = emptyChunk('a', 'b', 'c') as unknown as Record<string, unknown>
    chunk.outputs = [{ heights: big }]

    const decoded = await decodeChunk(w, await encodeChunk(w, chunk as unknown as SyncChunk)) as unknown as Record<string, any>
    expect(decoded.outputs[0].heights).toEqual(big)
  })

  it('round-trips a byte-like id array losslessly', async () => {
    // A long array of small integers is packed as bytes; it must come back identical.
    const w = deriveBackupWallet(KEY)
    const ids = Array.from({ length: 100 }, (_, i) => i % 200)
    const chunk = emptyChunk('a', 'b', 'c') as unknown as Record<string, unknown>
    chunk.outputs = [{ ids }]

    const decoded = await decodeChunk(w, await encodeChunk(w, chunk as unknown as SyncChunk)) as unknown as Record<string, any>
    expect(decoded.outputs[0].ids).toEqual(ids)
  })

  it('produces ciphertext another wallet cannot read', async () => {
    const mine = deriveBackupWallet(KEY)
    const theirs = deriveBackupWallet(new PrivateKey(8).toArray('be', 32))

    await expect(decodeChunk(theirs, await encodeChunk(mine, chunkWithBinary()))).rejects.toThrow()
  })

  it('does not leak plaintext into the ciphertext', async () => {
    const w = deriveBackupWallet(KEY)
    const ct = await encodeChunk(w, chunkWithBinary())

    expect(Buffer.from(ct).toString('utf8')).not.toContain('deadbeefcafe')
    expect(Buffer.from(ct).toString('utf8')).not.toContain('provenTxs')
  })

  it('recognises an empty chunk as the completion sentinel', () => {
    expect(isEmptyChunk(emptyChunk('a', 'b', 'c'))).toBe(true)
    expect(isEmptyChunk(chunkWithBinary())).toBe(false)
  })
})
