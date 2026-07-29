import { dependencyOrder, descendantsOf, releaseOrder, type OrderableTx } from '@/utils/offline/order'

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

  it('keeps the input order when nothing is blocked', () => {
    const order = releaseOrder([tx('X'), tx('Y'), tx('Z')])
    expect(order).toEqual(['X', 'Y', 'Z'])
  })

  // Documents the limit of the line above rather than a bug to fix. A pass emits
  // as it scans, so C1 — checked while P was still unemitted — waits for the next
  // pass and loses its arrival position to C2, which the same pass reaches after P
  // has gone out. Pinned because the doc comment on `dependencyOrder` states this
  // explicitly, and because the diamond test above cannot reach it (it puts the
  // shared parent LAST, so both dependents are blocked in the first pass).
  //
  // Deliberately not fixed: a parent can never end up after its child, so the
  // tie-break between two unrelated siblings costs nothing.
  it('does not preserve arrival order between siblings when one was checked before their parent', () => {
    expect(releaseOrder([tx('C1', ['P']), tx('P'), tx('C2', ['P'])])).toEqual(['P', 'C2', 'C1'])
    // The guarantee that does hold, in both orderings.
    expect(releaseOrder([tx('P'), tx('C1', ['P']), tx('C2', ['P'])])).toEqual(['P', 'C1', 'C2'])
  })

  it('is deterministic for a given input array', () => {
    const txs = () => [tx('C1', ['P']), tx('P'), tx('C2', ['P'])]
    expect(releaseOrder(txs())).toEqual(releaseOrder(txs()))
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

describe('dependencyOrder', () => {
  it('orders mined and txid-only transactions instead of dropping them', () => {
    // The whole reason this exists apart from releaseOrder. A cascade has to place
    // every member, because a mined or txid-only transaction can still be both
    // somebody's child and somebody's parent.
    const txs = [tx('C', ['B']), tx('B', ['A'], { isTxidOnly: true }), tx('A', [], { hasProof: true })]
    expect(dependencyOrder(txs)).toEqual(['A', 'B', 'C'])
    expect(releaseOrder(txs)).toEqual(['C'])
  })

  it('drops a cycle rather than looping forever, like releaseOrder', () => {
    expect(dependencyOrder([tx('A', ['B']), tx('B', ['A'])])).toEqual([])
  })

  it('ignores inputs that are not in the set', () => {
    expect(dependencyOrder([tx('B', ['A', 'unknown'])])).toEqual(['B'])
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
