/**
 * SQL-native listOutputs implementation.
 * Replaces IDB cursor-based filtering with SQL queries.
 */
import type { ListOutputsResult, Validation } from '@bsv/sdk'
import type { AuthId } from '@bsv/wallet-toolbox-mobile/out/src/sdk/WalletStorage.interfaces'
import type { StorageExpoSQLite } from '../StorageExpoSQLite'

export async function listOutputsSql(
  storage: StorageExpoSQLite,
  auth: AuthId,
  vargs: Validation.ValidListOutputsArgs
): Promise<ListOutputsResult> {
  const userId = auth.userId!
  const limit = vargs.limit || 10
  const offset = vargs.offset || 0
  const basket = vargs.basket
  const tags = vargs.tags || []
  const tagQueryMode = vargs.tagQueryMode || 'any'
  const includeCustomInstructions = vargs.includeCustomInstructions || false
  const includeTags = vargs.includeTags || false
  const includeLabels = vargs.includeLabels || false
  const includeLockingScripts = vargs.includeLockingScripts || false
  const knownTxids = vargs.knownTxids || []

  // Resolve basket
  let basketId: number | undefined
  if (basket) {
    const baskets = await storage.findOutputBaskets({ partial: { userId, name: basket } })
    if (baskets.length !== 1) {
      return { totalOutputs: 0, outputs: [] }
    }
    basketId = baskets[0].basketId
  }

  // Resolve tags to tagIds
  let tagIds: number[] = []
  const isQueryModeAll = tagQueryMode === 'all'

  if (tags.length > 0) {
    const foundTags = await storage.findOutputTags({
      partial: { userId, isDeleted: false as any }
    })
    const matchedTags = foundTags.filter((t: any) => tags.includes(t.tag))
    tagIds = matchedTags.map((t: any) => t.outputTagId as number)

    if (isQueryModeAll && tagIds.length < tags.length) {
      return { totalOutputs: 0, outputs: [] }
    }
    if (!isQueryModeAll && tagIds.length === 0) {
      return { totalOutputs: 0, outputs: [] }
    }
  }

  // Build partial for query
  const partial: Record<string, any> = { userId, spendable: true }
  if (basketId !== undefined) partial.basketId = basketId

  // Find outputs with spendable status and valid transaction statuses
  const outputs = await storage.findOutputs(
    {
      partial: partial as any,
      txStatus: ['completed', 'unproven', 'nosend'] as any,
      noScript: true,
      paged: { limit, offset }
    },
    tagIds.length > 0 ? tagIds : undefined,
    isQueryModeAll
  )

  // Count total
  let totalOutputs: number
  if (outputs.length === limit) {
    totalOutputs = await storage.countOutputs(
      {
        partial: partial as any,
        txStatus: ['completed', 'unproven', 'nosend'] as any,
        noScript: true
      },
      tagIds.length > 0 ? tagIds : undefined,
      isQueryModeAll
    )
  } else {
    totalOutputs = offset + outputs.length
  }

  // Cache labels by transactionId to avoid duplicate queries
  const labelsByTxId = new Map<number, string[]>()

  // Build output response
  const walletOutputs: any[] = []

  for (const o of outputs) {
    const wo: any = {
      satoshis: Number(o.satoshis),
      spendable: !!o.spendable,
      outpoint: `${(o as any).txid || ''}.${o.vout}`,
      customInstructions: undefined,
      tags: undefined,
      labels: undefined,
      lockingScript: undefined,
      outputIndex: o.vout,
      outputDescription: (o as any).outputDescription || ''
    }

    if (includeCustomInstructions && o.customInstructions) {
      wo.customInstructions = o.customInstructions
    }

    if (includeLabels) {
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
        (wo as any).lockingScript = typeof o.lockingScript === 'string'
          ? o.lockingScript
          : Array.from(o.lockingScript as any).map((b: any) => b.toString(16).padStart(2, '0')).join('')
      }
    }

    walletOutputs.push(wo)
  }

  const result: ListOutputsResult = { totalOutputs, outputs: walletOutputs }

  // Build BEEF if includeTransactions requested
  if (vargs.includeTransactions) {
    try {
      const { Beef } = await import('@bsv/sdk')
      let beef = new Beef()
      const seenTxids = new Set<string>()
      for (const o of outputs) {
        const txid = (o as any).txid
        if (txid && !seenTxids.has(txid)) {
          seenTxids.add(txid)
          try {
            beef = await storage.getValidBeefForKnownTxid(txid, beef, undefined, knownTxids)
          } catch {
            // Skip if we can't build beef for this txid
          }
        }
      }
      result.BEEF = beef.toBinary()
    } catch {
      // BEEF construction is optional
    }
  }

  return result
}
