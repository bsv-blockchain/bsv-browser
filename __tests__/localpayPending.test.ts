import {
  savePending, getPending, getUnprocessed, updateStatus, processPending,
  markSessionSpent, isSessionSpent, PENDING_KEY, SPENT_KEY,
} from '@/utils/localpay/pending'
import { FRAME_VERSION, type PaymentFrame } from '@/utils/localpay/codec'

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getKeyValue: async (k: string) => map.get(k),
    setKeyValue: async (k: string, v: string) => void map.set(k, v),
  }
}

const frame = (): PaymentFrame => ({
  version: FRAME_VERSION,
  senderIdentityKey: '02'.padEnd(66, 'c'),
  amount: 42,
  outputIndex: 0,
  derivationPrefix: 'cHJlZml4',
  derivationSuffix: 'c3VmZml4',
  transaction: new Uint8Array([9, 9, 9]),
})

describe('localpay pending queue', () => {
  it('persists under the localpay key', async () => {
    const s = fakeStorage()
    await savePending(s, frame())
    expect(s.map.has(PENDING_KEY)).toBe(true)
  })

  it('returns saved entries as pending', async () => {
    const s = fakeStorage()
    await savePending(s, frame())
    const all = await getPending(s)
    expect(all).toHaveLength(1)
    expect(all[0].status).toBe('pending')
    expect(all[0].frame.amount).toBe(42)
  })

  it('treats corrupt storage as empty rather than throwing', async () => {
    const s = fakeStorage()
    s.map.set(PENDING_KEY, 'not json')
    await expect(getPending(s)).resolves.toEqual([])
  })

  it('excludes completed entries from unprocessed', async () => {
    const s = fakeStorage()
    const p = await savePending(s, frame())
    await updateStatus(s, p.id, 'completed')
    expect(await getUnprocessed(s)).toHaveLength(0)
  })

  it('re-offers a processing entry after a crash', async () => {
    const s = fakeStorage()
    const p = await savePending(s, frame())
    await updateStatus(s, p.id, 'processing')
    expect(await getUnprocessed(s)).toHaveLength(1)
  })

  it('records a failure reason', async () => {
    const s = fakeStorage()
    const p = await savePending(s, frame())
    await updateStatus(s, p.id, 'failed', 'no network')
    expect((await getPending(s))[0].failureReason).toBe('no network')
  })

  it('marks completed when internalizeAction succeeds', async () => {
    const s = fakeStorage()
    await savePending(s, frame())
    const wallet = { internalizeAction: jest.fn().mockResolvedValue({ accepted: true }) }
    const results = await processPending(wallet as never, s, 'admin.com')
    expect(results).toEqual([expect.objectContaining({ success: true })])
    expect((await getPending(s))[0].status).toBe('completed')
  })

  it('marks failed and keeps the entry when internalizeAction throws', async () => {
    const s = fakeStorage()
    await savePending(s, frame())
    const wallet = { internalizeAction: jest.fn().mockRejectedValue(new Error('offline')) }
    const results = await processPending(wallet as never, s, 'admin.com')
    expect(results).toEqual([expect.objectContaining({ success: false, error: 'offline' })])
    const all = await getPending(s)
    expect(all[0].status).toBe('failed')
    expect(all).toHaveLength(1)
  })
})

describe('spent session guard', () => {
  const sid = () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])

  it('reports an unseen session as unspent', async () => {
    await expect(isSessionSpent(fakeStorage(), sid())).resolves.toBe(false)
  })

  it('reports a marked session as spent', async () => {
    const s = fakeStorage()
    await markSessionSpent(s, sid())
    await expect(isSessionSpent(s, sid())).resolves.toBe(true)
  })

  it('distinguishes different sessions', async () => {
    const s = fakeStorage()
    await markSessionSpent(s, sid())
    const other = new Uint8Array(16).fill(9)
    await expect(isSessionSpent(s, other)).resolves.toBe(false)
  })

  it('is idempotent', async () => {
    const s = fakeStorage()
    await markSessionSpent(s, sid())
    await markSessionSpent(s, sid())
    expect(JSON.parse(s.map.get(SPENT_KEY)!)).toHaveLength(1)
  })

  it('treats corrupt storage as no sessions spent', async () => {
    const s = fakeStorage()
    s.map.set(SPENT_KEY, 'not json')
    await expect(isSessionSpent(s, sid())).resolves.toBe(false)
  })
})
