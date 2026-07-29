import { buildOfflineHoldResult, groupOfflineHolds, holdSafeTxStatuses, type HoldTx } from '@/utils/offline/hold'

describe('buildOfflineHoldResult', () => {
  it('reports every held request as accepted for later delivery', () => {
    const reqs = [{ txid: 'aa' }, { txid: 'bb' }]
    const r = buildOfflineHoldResult(reqs)
    expect(r.status).toBe('success')
    expect(r.details.map(d => d.txid)).toEqual(['aa', 'bb'])
    expect(r.details.every(d => d.status === 'success')).toBe(true)
  })

  it('carries the request through so callers can inspect it', () => {
    const req = { txid: 'aa' }
    expect(buildOfflineHoldResult([req]).details[0].req).toBe(req)
  })

  it('handles an empty set', () => {
    expect(buildOfflineHoldResult([]).details).toEqual([])
  })
})

const tx = (extra: Partial<HoldTx> = {}): HoldTx => ({
  userId: 1,
  isOutgoing: false,
  status: 'unproven',
  ...extra
})

describe('groupOfflineHolds', () => {
  describe('role follows the money', () => {
    it('calls an incoming transaction received', () => {
      const groups = groupOfflineHolds([{ req: { txid: 'aa' }, tx: tx({ isOutgoing: false }) }])
      expect([...groups!.values()]).toEqual([{ userId: 1, role: 'received', reqs: [{ txid: 'aa' }] }])
    })

    it('calls an outgoing transaction sent', () => {
      // A non-delayed createAction reaches the same seam, so hardcoding
      // 'received' would mislabel the wallet's own send.
      const groups = groupOfflineHolds([{ req: { txid: 'aa' }, tx: tx({ isOutgoing: true, status: 'nosend' }) }])
      expect([...groups!.values()]).toEqual([{ userId: 1, role: 'sent', reqs: [{ txid: 'aa' }] }])
    })
  })

  describe('grouping', () => {
    it('splits one user across two roles in a single batch', () => {
      const groups = groupOfflineHolds([
        { req: { txid: 'aa' }, tx: tx({ isOutgoing: false }) },
        { req: { txid: 'bb' }, tx: tx({ isOutgoing: true, status: 'nosend' }) },
        { req: { txid: 'cc' }, tx: tx({ isOutgoing: false }) }
      ])
      expect([...groups!.values()]).toEqual([
        { userId: 1, role: 'received', reqs: [{ txid: 'aa' }, { txid: 'cc' }] },
        { userId: 1, role: 'sent', reqs: [{ txid: 'bb' }] }
      ])
    })

    it('keeps two users apart even at the same role', () => {
      const groups = groupOfflineHolds([
        { req: { txid: 'aa' }, tx: tx({ userId: 1 }) },
        { req: { txid: 'bb' }, tx: tx({ userId: 2 }) }
      ])
      expect([...groups!.values()]).toEqual([
        { userId: 1, role: 'received', reqs: [{ txid: 'aa' }] },
        { userId: 2, role: 'received', reqs: [{ txid: 'bb' }] }
      ])
    })

    it('groups nothing when given nothing', () => {
      expect(groupOfflineHolds([])?.size).toBe(0)
    })
  })

  describe('refuses the whole call', () => {
    it('when a request cannot be attributed to a transaction row', () => {
      // offline_actions.userId is a foreign key to users(userId) and foreign
      // keys are off, so a fabricated id would insert a row no drain queries.
      expect(groupOfflineHolds([{ req: { txid: 'aa' }, tx: undefined }])).toBeUndefined()
    })

    it('when only one of several requests is unattributable', () => {
      expect(
        groupOfflineHolds([
          { req: { txid: 'aa' }, tx: tx() },
          { req: { txid: 'bb' }, tx: undefined }
        ])
      ).toBeUndefined()
    })

    it("when a transaction is still 'unprocessed'", () => {
      // TaskFailAbandoned would fail it within 5 minutes while the queue row
      // still read 'queued'.
      expect(groupOfflineHolds([{ req: { txid: 'aa' }, tx: tx({ status: 'unprocessed' }) }])).toBeUndefined()
    })

    it('when only one of several requests is not hold-safe, rather than holding the safe subset', () => {
      expect(
        groupOfflineHolds([
          { req: { txid: 'aa' }, tx: tx({ status: 'unproven' }) },
          { req: { txid: 'bb' }, tx: tx({ status: 'unprocessed' }) }
        ])
      ).toBeUndefined()
    })

    it.each(['unprocessed', 'unsigned', 'sending', 'failed', 'completed'])('for status %s', status => {
      expect(groupOfflineHolds([{ req: { txid: 'aa' }, tx: tx({ status }) }])).toBeUndefined()
    })
  })

  describe('holds', () => {
    it.each([...holdSafeTxStatuses])('for hold-safe status %s', status => {
      expect(groupOfflineHolds([{ req: { txid: 'aa' }, tx: tx({ status }) }])?.size).toBe(1)
    })
  })
})
