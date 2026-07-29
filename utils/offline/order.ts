/**
 * The order in which held transactions may be released, and who dies with whom
 * when one is rejected.
 *
 * Pure on purpose. Ordering is the difference between a chain of offline
 * payments landing and a child being rejected as an orphan, so it gets
 * exhaustive unit tests rather than device-only confidence.
 *
 * `OrderableTx` is the shape `BeefTx` already has, so the driver passes
 * `beef.txs` in directly and there is exactly one ordering rule in the codebase.
 */
export interface OrderableTx {
  txid: string
  /** True once a merkle path is attached — already mined, nothing to send. */
  hasProof: boolean
  /** True for a bare txid reference with no transaction bytes. */
  isTxidOnly: boolean
  inputTxids: string[]
}

/**
 * Dependency order over the transactions that still need broadcasting.
 *
 * Mined and txid-only entries are excluded: the first needs nothing, the second
 * has nothing to send. Inputs outside the set are ignored — they are either
 * already on chain or someone else's problem, and in both cases they impose no
 * ordering on us. A cycle (impossible in real transactions, possible in
 * corrupt data) is dropped rather than allowed to spin.
 */
export function releaseOrder(txs: OrderableTx[]): string[] {
  const sendable = txs.filter(t => !t.hasProof && !t.isTxidOnly)
  const inSet = new Set(sendable.map(t => t.txid))
  const remaining = new Map(sendable.map(t => [t.txid, t]))
  const emitted = new Set<string>()
  const order: string[] = []

  // Insertion-ordered passes rather than recursion: the input order is the
  // arrival order, so independent transactions keep it and the result is stable.
  let progressed = true
  while (progressed && remaining.size > 0) {
    progressed = false
    for (const t of [...remaining.values()]) {
      const blocked = t.inputTxids.some(i => inSet.has(i) && !emitted.has(i))
      if (blocked) continue
      order.push(t.txid)
      emitted.add(t.txid)
      remaining.delete(t.txid)
      progressed = true
    }
  }
  return order
}

/**
 * Every transaction in the set that depends on `txid`, directly or through
 * other members. Used to cascade a rejection: if a parent is refused, no child
 * of it can ever be valid.
 */
export function descendantsOf(txid: string, txs: OrderableTx[]): string[] {
  const childrenOf = new Map<string, string[]>()
  for (const t of txs) {
    for (const input of t.inputTxids) {
      const list = childrenOf.get(input)
      if (list) list.push(t.txid)
      else childrenOf.set(input, [t.txid])
    }
  }
  const found = new Set<string>()
  const queue = [...(childrenOf.get(txid) ?? [])]
  while (queue.length > 0) {
    const next = queue.shift() as string
    if (next === txid || found.has(next)) continue
    found.add(next)
    queue.push(...(childrenOf.get(next) ?? []))
  }
  return [...found]
}
