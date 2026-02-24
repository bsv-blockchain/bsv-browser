/**
 * SQL-native listActions implementation.
 * Replaces IDB cursor-based filtering with SQL queries.
 * Handles specOp patterns (noSend actions, failed actions, etc.)
 */
import type { ListActionsResult, Validation } from '@bsv/sdk'
import type { AuthId } from '@bsv/wallet-toolbox-mobile/out/src/sdk/WalletStorage.interfaces'
import type { StorageExpoSQLite } from '../StorageExpoSQLite'
import { getLabelToSpecOp } from '@bsv/wallet-toolbox-mobile/out/src/storage/methods/ListActionsSpecOp'
import { isListActionsSpecOp } from '@bsv/wallet-toolbox-mobile/out/src/sdk/types'
import { parseBrc114ActionTimeLabels, makeBrc114ActionTimeLabel } from '@bsv/wallet-toolbox-mobile/out/src/utility/brc114ActionTimeLabels'

export async function listActionsSql(
  storage: StorageExpoSQLite,
  auth: AuthId,
  vargs: Validation.ValidListActionsArgs
): Promise<ListActionsResult> {
  const userId = auth.userId!
  const limit = vargs.limit
  const offset = vargs.offset

  const r: ListActionsResult = { totalActions: 0, actions: [] }

  // Parse BRC-114 time labels
  const { from: actionTimeFrom, to: actionTimeTo, timeFilterRequested, remainingLabels: ordinaryLabelsPreSpecOp } =
    parseBrc114ActionTimeLabels(vargs.labels)
  const createdAtFrom = actionTimeFrom !== undefined ? new Date(actionTimeFrom) : undefined
  const createdAtTo = actionTimeTo !== undefined ? new Date(actionTimeTo) : undefined

  // Separate specOp labels from ordinary labels
  let specOp: any = undefined
  let specOpLabels: string[] = []
  let labels: string[] = []
  for (const label of ordinaryLabelsPreSpecOp) {
    if (isListActionsSpecOp(label)) {
      specOp = getLabelToSpecOp()[label]
    } else {
      labels.push(label)
    }
  }

  // Handle specOp label interception
  if (specOp?.labelsToIntercept !== undefined) {
    const intercept = specOp.labelsToIntercept as string[]
    const labels2 = labels
    labels = []
    if (intercept.length === 0) {
      specOpLabels = labels2
    }
    for (const label of labels2) {
      if (intercept.indexOf(label) >= 0) {
        specOpLabels.push(label)
      } else {
        labels.push(label)
      }
    }
  }

  // Resolve labels to labelIds
  let labelIds: number[] = []
  if (labels.length > 0) {
    const foundLabels = await storage.findTxLabels({
      partial: { userId, isDeleted: false } as any
    })
    for (const tl of foundLabels) {
      if (labels.includes((tl as any).label)) {
        labelIds.push((tl as any).txLabelId)
      }
    }
  }

  const isQueryModeAll = vargs.labelQueryMode === 'all'
  if (isQueryModeAll && labelIds.length < labels.length) return r
  if (!isQueryModeAll && labelIds.length === 0 && labels.length > 0) return r

  // Determine statuses to query
  const stati: string[] = specOp?.setStatusFilter
    ? specOp.setStatusFilter()
    : ['completed', 'unprocessed', 'sending', 'unproven', 'unsigned', 'nosend', 'nonfinal']

  // Find transactions
  const txs = await storage.findTransactions(
    {
      partial: { userId },
      status: stati as any,
      from: createdAtFrom,
      to: createdAtTo,
      paged: { limit, offset },
      noRawTx: true
    },
    labelIds.length > 0 ? labelIds : undefined,
    isQueryModeAll
  )

  // Count total
  if (txs.length === limit) {
    r.totalActions = await storage.countTransactions(
      { partial: { userId }, status: stati as any, from: createdAtFrom, to: createdAtTo } as any,
      labelIds.length > 0 ? labelIds : undefined,
      isQueryModeAll
    )
  } else {
    r.totalActions = (offset || 0) + txs.length
  }

  // Apply specOp post-processing
  if (specOp?.postProcess) {
    await specOp.postProcess(storage, auth, vargs, specOpLabels, txs)
  }

  // Build action objects
  for (const tx of txs) {
    const wtx: any = {
      txid: tx.txid || '',
      satoshis: tx.satoshis || 0,
      status: tx.status,
      isOutgoing: !!tx.isOutgoing,
      description: tx.description || '',
      version: tx.version || 0,
      lockTime: tx.lockTime || 0
    }
    r.actions.push(wtx)
  }

  // Include labels, inputs, outputs if requested
  if (vargs.includeLabels || vargs.includeInputs || vargs.includeOutputs) {
    await Promise.all(txs.map(async (tx, i) => {
      const action = r.actions[i] as any

      if (vargs.includeLabels) {
        action.labels = (await storage.getLabelsForTransactionId(tx.transactionId)).map(l => l.label)
        if (timeFilterRequested) {
          const ts = tx.created_at ? new Date(tx.created_at as any).getTime() : NaN
          if (!Number.isNaN(ts)) {
            const timeLabel = makeBrc114ActionTimeLabel(ts)
            if (!action.labels.includes(timeLabel)) action.labels.push(timeLabel)
          }
        }
      }

      if (vargs.includeOutputs) {
        const outputs = await storage.findOutputs({
          partial: { transactionId: tx.transactionId },
          noScript: !vargs.includeOutputLockingScripts
        })
        action.outputs = []
        for (const o of outputs) {
          const ox = await storage.extendOutput(o, true, true) as any
          const wo: any = {
            satoshis: o.satoshis || 0,
            spendable: !!o.spendable,
            tags: (ox.tags?.map((t: any) => t.tag)) || [],
            outputIndex: Number(o.vout),
            outputDescription: (o as any).outputDescription || '',
            basket: ox.basket?.name || ''
          }
          if (vargs.includeOutputLockingScripts && o.lockingScript) {
            wo.lockingScript = typeof o.lockingScript === 'string'
              ? o.lockingScript
              : Array.from(o.lockingScript as any).map((b: any) => b.toString(16).padStart(2, '0')).join('')
          }
          action.outputs.push(wo)
        }
      }

      if (vargs.includeInputs) {
        const inputs = await storage.findOutputs({
          partial: { spentBy: tx.transactionId } as any,
          noScript: !vargs.includeInputSourceLockingScripts
        })
        action.inputs = []
        if (inputs.length > 0) {
          const rawTx = await storage.getRawTxOfKnownValidTransaction(tx.txid)
          let bsvTx: any = undefined
          if (rawTx) {
            const { Transaction } = await import('@bsv/sdk')
            bsvTx = Transaction.fromBinary(rawTx)
          }
          for (const o of inputs) {
            await storage.extendOutput(o, true, true)
            const input = bsvTx?.inputs.find((v: any) => v.sourceTXID === (o as any).txid && v.sourceOutputIndex === o.vout)
            const wo: any = {
              sourceOutpoint: `${(o as any).txid}.${o.vout}`,
              sourceSatoshis: o.satoshis || 0,
              inputDescription: (o as any).outputDescription || '',
              sequenceNumber: input?.sequence || 0
            }
            action.inputs.push(wo)
            if (vargs.includeInputSourceLockingScripts) {
              wo.sourceLockingScript = typeof o.lockingScript === 'string'
                ? o.lockingScript
                : Array.from(o.lockingScript as any || []).map((b: any) => b.toString(16).padStart(2, '0')).join('')
            }
            if (vargs.includeInputUnlockingScripts) {
              wo.unlockingScript = input?.unlockingScript?.toHex()
            }
          }
        }
      }
    }))
  }

  return r
}
