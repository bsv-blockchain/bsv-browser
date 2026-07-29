import {
  savePending, getPending, getUnprocessed, updateStatus, processPending,
  markSessionSpent, isSessionSpent, PENDING_KEY, SPENT_KEY,
} from '@/utils/localpay/pending'
import { FRAME_VERSION, type PaymentFrame } from '@/utils/localpay/codec'
import { Transaction, Beef, LockingScript } from '@bsv/sdk'

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

// A real AtomicBEEF, distinct from `frame()`'s placeholder bytes: attribution
// derives the txid by actually parsing the frame's transaction (internalizeAction's
// own resolved value carries no txid — see utils/localpay/pending.ts's processPending),
// so exercising that path needs bytes Beef.fromBinary can actually read.
function atomicBeefFixture(): { txid: string; transaction: Uint8Array } {
  const tx = new Transaction()
  tx.addOutput({
    satoshis: 1000,
    lockingScript: LockingScript.fromHex('76a914000000000000000000000000000000000000000088ac')
  })
  const txid = tx.id('hex')
  const beef = new Beef()
  beef.mergeTransaction(tx)
  return { txid, transaction: new Uint8Array(beef.toBinaryAtomic(txid)) }
}

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

  it('storage failures propagate from getPending', async () => {
    const s = {
      getKeyValue: jest.fn().mockRejectedValue(new Error('SQLite locked')),
      setKeyValue: jest.fn(),
    }
    await expect(getPending(s as never)).rejects.toThrow('SQLite locked')
  })

  it('storage failures propagate from savePending and do not call setKeyValue', async () => {
    const setKeyValue = jest.fn()
    const s = {
      getKeyValue: jest.fn().mockRejectedValue(new Error('SQLite locked')),
      setKeyValue,
    }
    await expect(savePending(s as never, frame())).rejects.toThrow('SQLite locked')
    expect(setKeyValue).not.toHaveBeenCalled()
  })

  it('processPending re-invokes internalizeAction for processing entry and completes it', async () => {
    const s = fakeStorage()
    const p = await savePending(s, frame())
    await updateStatus(s, p.id, 'processing')
    const wallet = { internalizeAction: jest.fn().mockResolvedValue({ accepted: true }) }
    const results = await processPending(wallet as never, s, 'admin.com')
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
    expect(results).toEqual([expect.objectContaining({ success: true })])
    expect((await getPending(s))[0].status).toBe('completed')
  })

  it('records the transport a payment arrived over, when the caller knows it', async () => {
    const s = fakeStorage()
    await savePending(s, frame(), 'awdl')
    expect((await getPending(s))[0].receivedVia).toBe('awdl')
  })

  it('leaves the transport unset when the caller does not pass one', async () => {
    const s = fakeStorage()
    await savePending(s, frame())
    expect((await getPending(s))[0].receivedVia).toBeUndefined()
  })

  it('attributes the queue row with the sender identity and transport after a successful internalize', async () => {
    const s = fakeStorage()
    const { txid, transaction } = atomicBeefFixture()
    await savePending(s, { ...frame(), transaction }, 'awdl')
    const wallet = { internalizeAction: jest.fn().mockResolvedValue({ accepted: true }) }
    const attribute = jest.fn().mockResolvedValue(undefined)
    await processPending(wallet as never, s, 'admin.com', attribute)
    expect(attribute).toHaveBeenCalledWith(txid, {
      senderIdentityKey: '02'.padEnd(66, 'c'),
      receivedVia: 'awdl'
    })
  })

  it('does not fail the payment or stop the queue when attribution throws', async () => {
    const s = fakeStorage()
    const { transaction } = atomicBeefFixture()
    await savePending(s, { ...frame(), transaction }, 'awdl')
    const wallet = { internalizeAction: jest.fn().mockResolvedValue({ accepted: true }) }
    const attribute = jest.fn().mockRejectedValue(new Error('database is locked'))
    const results = await processPending(wallet as never, s, 'admin.com', attribute)
    expect(results).toEqual([expect.objectContaining({ success: true })])
    expect((await getPending(s))[0].status).toBe('completed')
  })

  it("does not stop the loop when one entry's attribution throws and another follows", async () => {
    const s = fakeStorage()
    const { transaction } = atomicBeefFixture()
    await savePending(s, { ...frame(), transaction }, 'awdl')
    await savePending(s, { ...frame(), transaction }, 'qr')
    const wallet = { internalizeAction: jest.fn().mockResolvedValue({ accepted: true }) }
    const attribute = jest.fn().mockRejectedValueOnce(new Error('database is locked')).mockResolvedValueOnce(undefined)
    const results = await processPending(wallet as never, s, 'admin.com', attribute)
    expect(results).toEqual([expect.objectContaining({ success: true }), expect.objectContaining({ success: true })])
    expect(attribute).toHaveBeenCalledTimes(2)
  })

  it('skips attribution rather than throwing when the frame is not a readable BEEF', async () => {
    // frame()'s placeholder transaction bytes ([9, 9, 9]) are not a real BEEF —
    // Beef.fromBinary rejects them. A legacy or malformed frame must not crash
    // an otherwise-successful internalize.
    const s = fakeStorage()
    await savePending(s, frame(), 'awdl')
    const wallet = { internalizeAction: jest.fn().mockResolvedValue({ accepted: true }) }
    const attribute = jest.fn()
    const results = await processPending(wallet as never, s, 'admin.com', attribute)
    expect(results).toEqual([expect.objectContaining({ success: true })])
    expect(attribute).not.toHaveBeenCalled()
  })

  it('concurrent saves both persist via serialization', async () => {
    const s = {
      map: new Map<string, string>(),
      getKeyValue: async (k: string) => {
        await new Promise(r => setImmediate(r))
        return s.map.get(k)
      },
      setKeyValue: async (k: string, v: string) => {
        await new Promise(r => setImmediate(r))
        s.map.set(k, v)
      },
    }
    const [p1, p2] = await Promise.all([
      savePending(s as never, frame()),
      savePending(s as never, frame()),
    ])
    const all = await getPending(s as never)
    expect(all).toHaveLength(2)
    expect(all.map(x => x.id)).toContain(p1.id)
    expect(all.map(x => x.id)).toContain(p2.id)
    // Verify the stored list itself has 2 entries
    const stored = JSON.parse(s.map.get(PENDING_KEY)!)
    expect(stored).toHaveLength(2)
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
