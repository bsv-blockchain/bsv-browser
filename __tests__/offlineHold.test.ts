import { buildOfflineHoldResult } from '@/utils/offline/hold'

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
