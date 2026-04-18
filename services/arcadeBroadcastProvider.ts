import { Beef, Transaction } from '@bsv/sdk'
import type {
  PostBeefResult,
  PostTxResultForTxid
} from '@bsv/wallet-toolbox-mobile/out/src/sdk'

/**
 * Create an Arcade-specific broadcast service that posts EF-format transactions.
 * Pure function — no React dependencies.
 */
export function createArcadeBroadcastService(
  arcadeUrl: string,
  callbackToken: string
) {
  return {
    name: 'Arcade',
    service: async (beef: Beef, txids: string[]): Promise<PostBeefResult> => {
      const r: PostBeefResult = { name: 'Arcade', status: 'success', txidResults: [] }
      try {
        const tx = Transaction.fromBEEF(beef.toBinary())
        const ef = tx.toEF()
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 30_000)
        let response: Response
        try {
          response = await fetch(`${arcadeUrl}/tx`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-CallbackToken': callbackToken,
              'X-FullStatusUpdates': 'true'
            },
            body: new Uint8Array(ef),
            signal: controller.signal
          })
        } finally {
          clearTimeout(timeout)
        }
        const data = await response.json()
        console.log(`[Arcade] POST /tx ${response.status}`, JSON.stringify(data))
        const txResult: PostTxResultForTxid = {
          txid: data.txid || txids[0],
          status: response.ok ? 'success' : 'error',
          notes: [{ when: new Date().toISOString(), what: 'arcadePostEF', txStatus: data.txStatus }]
        }
        if (data.txStatus === 'DOUBLE_SPEND_ATTEMPTED') {
          txResult.doubleSpend = true
          txResult.status = 'error'
        }
        r.txidResults.push(txResult)
        r.status = txResult.status
      } catch (err: any) {
        console.log(`[Arcade] POST /tx error: ${err.message}`)
        r.status = 'error'
        r.txidResults.push({
          txid: txids[0],
          status: 'error',
          serviceError: true,
          data: err.message
        })
      }
      return r
    }
  }
}
