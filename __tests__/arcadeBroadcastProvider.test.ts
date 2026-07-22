import { handleArcResponse } from '@/services/arcadeBroadcastProvider'

describe('handleArcResponse', () => {
  const txids = ['abc123']

  it('treats Arcade RECEIVED (HTTP 202) as success', () => {
    const result = handleArcResponse(
      'Arcade',
      { ok: true, status: 202 },
      { txid: txids[0], txStatus: 'RECEIVED' },
      txids
    )
    expect(result.status).toBe('success')
    expect(result.txid).toBe(txids[0])
    expect(result.doubleSpend).toBeUndefined()
    expect(result.serviceError).toBeUndefined()
  })

  it.each([
    'STORED',
    'SENT_TO_NETWORK',
    'ACCEPTED_BY_NETWORK',
    'SEEN_ON_NETWORK',
    'SEEN_MULTIPLE_NODES',
    'MINED',
    'IMMUTABLE'
  ] as const)('treats %s as success when response.ok', (txStatus) => {
    const result = handleArcResponse(
      'Arcade',
      { ok: true, status: 200 },
      { txid: txids[0], txStatus },
      txids
    )
    expect(result.status).toBe('success')
  })

  it('marks double-spend statuses without success', () => {
    for (const txStatus of ['DOUBLE_SPEND_ATTEMPTED', 'SEEN_IN_ORPHAN_MEMPOOL'] as const) {
      const result = handleArcResponse(
        'Arcade',
        { ok: true, status: 200 },
        { txid: txids[0], txStatus },
        txids
      )
      expect(result.status).toBe('error')
      expect(result.doubleSpend).toBe(true)
    }
  })

  it('marks REJECTED and non-ok HTTP as serviceError', () => {
    const rejected = handleArcResponse(
      'Arcade',
      { ok: true, status: 200 },
      { txid: txids[0], txStatus: 'REJECTED' },
      txids
    )
    expect(rejected.status).toBe('error')
    expect(rejected.serviceError).toBe(true)

    const httpErr = handleArcResponse(
      'Arcade',
      { ok: false, status: 500 },
      { txid: txids[0], txStatus: 'RECEIVED' },
      txids
    )
    expect(httpErr.status).toBe('error')
    expect(httpErr.serviceError).toBe(true)
  })

  it('treats missing txStatus with ok response as success (built-in ARC parity)', () => {
    const result = handleArcResponse(
      'TaalArc',
      { ok: true, status: 200 },
      { txid: txids[0] },
      txids
    )
    expect(result.status).toBe('success')
  })
})
