/**
 * SQL-native listOutputs implementation.
 * Replaces IDB cursor-based filtering with SQL queries.
 * Handles specOp patterns (wallet balance, invalid change, etc.)
 */
import type { ListOutputsResult, Validation } from '@bsv/sdk'
import type { AuthId } from '@bsv/wallet-toolbox-mobile/out/src/sdk/WalletStorage.interfaces'
import type { StorageExpoSQLite } from '../StorageExpoSQLite'
import { getListOutputsSpecOp } from '@bsv/wallet-toolbox-mobile/out/src/storage/methods/ListOutputsSpecOp'

export async function listOutputsSql(
  storage: StorageExpoSQLite,
  auth: AuthId,
  vargs: Validation.ValidListOutputsArgs
): Promise<ListOutputsResult> {
  const userId = auth.userId!
  const limit = vargs.limit || 10
  const offset = vargs.offset || 0
  const includeCustomInstructions = vargs.includeCustomInstructions || false
  const includeTags = vargs.includeTags || false
  const includeLabels = vargs.includeLabels || false
  const includeLockingScripts = vargs.includeLockingScripts || false
  const knownTxids = vargs.knownTxids || []

  const r: ListOutputsResult = { totalOutputs: 0, outputs: [] }

  // Check for specOp (wallet balance, invalid change, etc.)
  let { specOp, basket, tags: remainingTags } = getListOutputsSpecOp(vargs.basket, vargs.tags)
  let tags = remainingTags || []

  // Resolve basket
  let basketId: number | undefined
  if (basket) {
    const baskets = await storage.findOutputBaskets({ partial: { userId, name: basket } })
    console.log(`[listOutputsSql] basket="${basket}" found ${baskets.length} matches${baskets.length > 0 ? ` (id=${baskets[0].basketId})` : ''}`)
    if (baskets.length !== 1) return r
    basketId = baskets[0].basketId
  }

  // Handle specOp tag interception
  const specOpTags: string[] = []
  if (specOp && specOp.tagsParamsCount) {
    specOpTags.push(...tags.splice(0, Math.min(tags.length, specOp.tagsParamsCount)))
  }
  if (specOp && specOp.tagsToIntercept) {
    const ts = tags
    tags = []
    for (const t of ts) {
      if (specOp.tagsToIntercept.length === 0 || specOp.tagsToIntercept.indexOf(t) >= 0) {
        specOpTags.push(t)
        if (t === 'all') basketId = undefined
      } else {
        tags.push(t)
      }
    }
  }

  // Early return for specOps that only need tags
  if (specOp && specOp.resultFromTags) {
    return await specOp.resultFromTags(storage, auth, vargs, specOpTags)
  }

  // Resolve tags to tagIds
  let tagIds: number[] = []
  const isQueryModeAll = (vargs.tagQueryMode || 'any') === 'all'

  if (tags.length > 0) {
    const foundTags = await storage.findOutputTags({
      partial: { userId, isDeleted: false } as any
    })
    const matchedTags = foundTags.filter((t: any) => tags.includes(t.tag))
    tagIds = matchedTags.map((t: any) => t.outputTagId as number)

    if (isQueryModeAll && tagIds.length < tags.length) return r
    if (!isQueryModeAll && tagIds.length === 0) return r
  }

  // Build partial for query
  const partial: Record<string, any> = { userId, spendable: true }
  if (basketId !== undefined) partial.basketId = basketId

  // Build find args — specOps with ignoreLimit fetch ALL outputs
  const findArgs: any = {
    partial,
    txStatus: ['completed', 'unproven', 'nosend'],
    noScript: true
  }
  if (!specOp || !specOp.ignoreLimit) {
    findArgs.paged = { limit, offset }
  }

  let outputs = await storage.findOutputs(
    findArgs,
    tagIds.length > 0 ? tagIds : undefined,
    isQueryModeAll
  )
  if (outputs.length === 0 && basketId !== undefined) {
    // Debug: check what's in the basket without filters
    const db = (storage as any).getDB()
    const raw = await db.getAllAsync(
      `SELECT o.outputId, o.spendable, o.satoshis, t.status as txStatus
       FROM outputs o JOIN transactions t ON o.transactionId = t.transactionId
       WHERE o.userId = ? AND o.basketId = ?`,
      [userId, basketId]
    )
    console.log(`[listOutputsSql] DEBUG basket=${basketId} raw outputs:`, JSON.stringify(raw))
  }
  console.log(`[listOutputsSql] basket="${basket}" specOp=${specOp?.name || 'none'} found ${outputs.length} outputs, satoshis: [${outputs.slice(0, 5).map(o => o.satoshis).join(',')}]`)

  // Count total
  if (outputs.length === limit) {
    r.totalOutputs = await storage.countOutputs(
      { partial, txStatus: ['completed', 'unproven', 'nosend'], noScript: true } as any,
      tagIds.length > 0 ? tagIds : undefined,
      isQueryModeAll
    )
  } else {
    r.totalOutputs = outputs.length
  }

  // Apply specOp processing
  if (specOp) {
    if (specOp.filterOutputs) {
      outputs = await specOp.filterOutputs(storage, auth, vargs, specOpTags, outputs)
    }
    if (specOp.resultFromOutputs) {
      return await specOp.resultFromOutputs(storage, auth, vargs, specOpTags, outputs)
    }
  }

  // Cache labels by transactionId to avoid duplicate queries
  const labelsByTxId = new Map<number, string[]>()

  // Build output response
  for (const o of outputs) {
    const wo: any = {
      satoshis: Number(o.satoshis),
      spendable: !!o.spendable,
      outpoint: `${(o as any).txid || ''}.${o.vout}`
    }

    if (includeCustomInstructions && o.customInstructions) {
      wo.customInstructions = o.customInstructions
    }

    if (includeLabels && (o as any).txid) {
      if (!labelsByTxId.has(o.transactionId)) {
        const txLabels = await storage.getLabelsForTransactionId(o.transactionId)
        labelsByTxId.set(o.transactionId, txLabels.map(l => l.label))
      }
      wo.labels = labelsByTxId.get(o.transactionId)
    }

    if (includeTags) {
      const outputTags = await storage.getTagsForOutputId(o.outputId)
      wo.tags = outputTags.map(t => t.tag)
    }

    if (includeLockingScripts) {
      await storage.validateOutputScript(o)
      if (o.lockingScript) {
        wo.lockingScript = typeof o.lockingScript === 'string'
          ? o.lockingScript
          : Array.from(o.lockingScript as any).map((b: any) => b.toString(16).padStart(2, '0')).join('')
      }
    }

    r.outputs.push(wo)
  }

  // Build BEEF if includeTransactions requested
  if (vargs.includeTransactions) {
    try {
      const { Beef } = await import('@bsv/sdk')
      const beef = new Beef()
      for (const o of outputs) {
        const txid = (o as any).txid
        if (txid && !beef.findTxid(txid)) {
          try {
            await storage.getValidBeefForKnownTxid(txid, beef, undefined, knownTxids)
          } catch {
            // Skip if we can't build beef for this txid
          }
        }
      }
      r.BEEF = beef.toBinary()
    } catch {
      // BEEF construction is optional
    }
  }

  return r
}
