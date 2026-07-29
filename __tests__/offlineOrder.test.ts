import { descendantsOf, releaseOrder, type OrderableTx } from '@/utils/offline/order'

const tx = (txid: string, inputTxids: string[] = [], extra: Partial<OrderableTx> = {}): OrderableTx => ({
  txid,
  hasProof: false,
  isTxidOnly: false,
  inputTxids,
  ...extra
})

describe('releaseOrder', () => {
  it('puts a parent before its child', () => {
    const order = releaseOrder([tx('B', ['A']), tx('A')])
    expect(order).toEqual(['A', 'B'])
  })

  it('orders a three-deep chain regardless of input order', () => {
    const order = releaseOrder([tx('C', ['B']), tx('A'), tx('B', ['A'])])
    expect(order).toEqual(['A', 'B', 'C'])
  })

  it('excludes transactions that already have a proof', () => {
    const order = releaseOrder([tx('A', [], { hasProof: true }), tx('B', ['A'])])
    expect(order).toEqual(['B'])
  })

  it('excludes txid-only entries', () => {
    const order = releaseOrder([tx('A', [], { isTxidOnly: true }), tx('B', ['A'])])
    expect(order).toEqual(['B'])
  })

  it('ignores inputs that are not in the set', () => {
    const order = releaseOrder([tx('B', ['A', 'unknown'])])
    expect(order).toEqual(['B'])
  })

  it('keeps a stable order for independent transactions', () => {
    const order = releaseOrder([tx('X'), tx('Y'), tx('Z')])
    expect(order).toEqual(['X', 'Y', 'Z'])
  })

  it('handles a diamond', () => {
    const order = releaseOrder([tx('D', ['B', 'C']), tx('B', ['A']), tx('C', ['A']), tx('A')])
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('B'))
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('C'))
    expect(order.indexOf('B')).toBeLessThan(order.indexOf('D'))
    expect(order.indexOf('C')).toBeLessThan(order.indexOf('D'))
  })

  it('drops a cycle rather than looping forever', () => {
    const order = releaseOrder([tx('A', ['B']), tx('B', ['A'])])
    expect(order).toEqual([])
  })

  it('returns nothing for an empty set', () => {
    expect(releaseOrder([])).toEqual([])
  })
})

describe('descendantsOf', () => {
  it('finds direct and transitive children', () => {
    const txs = [tx('A'), tx('B', ['A']), tx('C', ['B']), tx('D')]
    expect(descendantsOf('A', txs).sort()).toEqual(['B', 'C'])
  })

  it('excludes the transaction itself', () => {
    expect(descendantsOf('A', [tx('A')])).toEqual([])
  })

  it('returns nothing for a leaf', () => {
    const txs = [tx('A'), tx('B', ['A'])]
    expect(descendantsOf('B', txs)).toEqual([])
  })

  it('does not loop on a cycle', () => {
    const txs = [tx('A', ['B']), tx('B', ['A'])]
    expect(descendantsOf('A', txs)).toEqual(['B'])
  })
})
