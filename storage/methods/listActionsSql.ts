/**
 * SQL-native listActions implementation.
 * Replaces IDB cursor-based filtering with SQL queries.
 */
import type { ListActionsResult, Validation } from '@bsv/sdk'
import type { AuthId } from '@bsv/wallet-toolbox-mobile/out/src/sdk/WalletStorage.interfaces'
import type { StorageExpoSQLite } from '../StorageExpoSQLite'

export async function listActionsSql(
  storage: StorageExpoSQLite,
  auth: AuthId,
  vargs: Validation.ValidListActionsArgs
): Promise<ListActionsResult> {
  const userId = auth.userId!
  const limit = vargs.limit || 10
  const offset = vargs.offset || 0
  const labels = vargs.labels || []
  const labelQueryMode = vargs.labelQueryMode || 'any'
  const includeLabels = vargs.includeLabels || false
  const includeInputs = vargs.includeInputs || false
  const includeOutputs = vargs.includeOutputs || false

  // Default statuses to query
  const stati: string[] = ['completed', 'unprocessed', 'sending', 'unproven', 'unsigned', 'nosend', 'nonfinal']

  // Resolve labels to labelIds
  let labelIds: number[] = []
  const isQueryModeAll = labelQueryMode === 'all'

  if (labels.length > 0) {
    const foundLabels = await storage.findTxLabels({
      partial: { userId, isDeleted: false as any }
    })
    const matchedLabels = foundLabels.filter((l: any) => labels.includes(l.label))
    labelIds = matchedLabels.map((l: any) => l.txLabelId as number)

    // If 'all' mode and not all labels found, return empty
    if (isQueryModeAll && labelIds.length < labels.length) {
      return { totalActions: 0, actions: [] }
    }
    // If 'any' mode and no labels found, return empty
    if (!isQueryModeAll && labelIds.length === 0) {
      return { totalActions: 0, actions: [] }
    }
  }

  // Find transactions
  const txs = await storage.findTransactions(
    {
      partial: { userId },
      status: stati as any,
      noRawTx: true,
      paged: { limit, offset },
      orderDescending: true
    },
    labelIds.length > 0 ? labelIds : undefined,
    isQueryModeAll
  )

  // Count total
  let totalActions: number
  if (txs.length === limit) {
    totalActions = await storage.countTransactions(
      {
        partial: { userId },
        status: stati as any,
        noRawTx: true
      },
      labelIds.length > 0 ? labelIds : undefined,
      isQueryModeAll
    )
  } else {
    totalActions = offset + txs.length
  }

  // Build action objects
  const actions: any[] = []
  for (const tx of txs) {
    const action: any = {
      txid: tx.txid || '',
      satoshis: tx.satoshis || 0,
      status: tx.status,
      isOutgoing: !!tx.isOutgoing,
      description: tx.description || '',
      version: tx.version || 0,
      lockTime: tx.lockTime || 0,
      inputs: undefined,
      outputs: undefined,
      labels: undefined
    }

    // Include outputs if requested
    if (includeOutputs) {
      const outputs = await storage.findOutputs({
        partial: { transactionId: tx.transactionId },
        noScript: !vargs.includeOutputLockingScripts
      })
      action.outputs = []
      for (const o of outputs) {
        const ox = await storage.extendOutput(o, true, true)
        const wo: any = {
          satoshis: o.satoshis || 0,
          spendable: !!o.spendable,
          tags: ((ox as any).tags || []).map((t: any) => t.tag),
          outputIndex: Number(o.vout),
          outputDescription: (o as any).outputDescription || '',
          basket: (ox as any).basket?.name || ''
        }
        if (vargs.includeOutputLockingScripts && o.lockingScript) {
          wo.lockingScript = typeof o.lockingScript === 'string'
            ? o.lockingScript
            : Array.from(o.lockingScript as any).map((b: any) => b.toString(16).padStart(2, '0')).join('')
        }
        action.outputs.push(wo)
      }
    }

    // Include inputs if requested
    if (includeInputs) {
      const inputOutputs = await storage.findOutputs({
        partial: { spentBy: tx.transactionId as any },
        noScript: !vargs.includeInputSourceLockingScripts
      })
      action.inputs = []
      for (const o of inputOutputs) {
        const ox = await storage.extendOutput(o, true, true)
        const wi: any = {
          sourceOutpoint: `${(o as any).txid || ''}.${o.vout}`,
          sourceSatoshis: o.satoshis || 0,
          inputDescription: (o as any).outputDescription || '',
          sequenceNumber: (o as any).sequenceNumber || 0
        }
        action.inputs.push(wi)
      }
    }

    // Include labels if requested
    if (includeLabels) {
      const txLabels = await storage.getLabelsForTransactionId(tx.transactionId)
      action.labels = txLabels.map(l => l.label)
    }

    actions.push(action)
  }

  return { totalActions, actions }
}
