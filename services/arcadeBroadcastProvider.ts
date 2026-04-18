import { Beef, Transaction, Utils } from '@bsv/sdk'
import type {
  PostBeefResult,
  PostTxResultForTxid
} from '@bsv/wallet-toolbox-mobile/out/src/sdk'

/**
 * Shared response handling for ARC-compatible services (Arcade, Taal, GorillaPool).
 * Maps txStatus to the correct PostTxResultForTxid fields.
 */
function handleArcResponse(
  serviceName: string,
  response: Response,
  data: any,
  txids: string[]
): PostTxResultForTxid {
  const txResult: PostTxResultForTxid = {
    txid: data.txid || txids[0],
    status: 'error',
    notes: [{
      when: new Date().toISOString(),
      what: `${serviceName}PostEF`,
      txStatus: data.txStatus,
      httpStatus: response.status
    }]
  }
  if (data.txStatus === 'DOUBLE_SPEND_ATTEMPTED') {
    txResult.doubleSpend = true
  } else if (
    response.ok &&
    (data.txStatus === 'SEEN_ON_NETWORK' || data.txStatus === 'MINED' || !data.txStatus)
  ) {
    txResult.status = 'success'
  } else if (data.txStatus === 'REJECTED' || !response.ok) {
    txResult.serviceError = true
  }
  return txResult
}

/**
 * Convert BEEF to EF-format binary for ARC-compatible endpoints.
 */
function beefToEF(beef: Beef): Uint8Array {
  const tx = Transaction.fromBEEF(beef.toBinary())
  return new Uint8Array(tx.toEF())
}

/**
 * Create an ARC-compatible broadcast service that posts EF-format transactions.
 */
function createArcBroadcastService(
  name: string,
  arcUrl: string,
  headers: Record<string, string>
) {
  return {
    name,
    service: async (beef: Beef, txids: string[]): Promise<PostBeefResult> => {
      const r: PostBeefResult = { name, status: 'success', txidResults: [] }
      try {
        const ef = beefToEF(beef)
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 30_000)
        let response: Response
        try {
          response = await fetch(`${arcUrl}/tx`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              ...headers
            },
            body: ef,
            signal: controller.signal
          })
        } finally {
          clearTimeout(timeout)
        }
        const data = await response.json()
        console.log(`[${name}] POST /tx ${response.status}`, JSON.stringify(data))
        const txResult = handleArcResponse(name, response, data, txids)
        r.txidResults.push(txResult)
        r.status = txResult.status
      } catch (err: any) {
        console.log(`[${name}] POST /tx error: ${err.message}`)
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

/**
 * Arcade broadcast service — EF format with callback token for SSE updates.
 */
export function createArcadeBroadcastService(arcadeUrl: string, callbackToken: string) {
  return createArcBroadcastService('Arcade', arcadeUrl, {
    'X-CallbackToken': callbackToken,
    'X-FullStatusUpdates': 'true'
  })
}

/**
 * Taal ARC broadcast service — EF format.
 */
export function createTaalBroadcastService(arcUrl: string, apiKey?: string) {
  const headers: Record<string, string> = {}
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  return createArcBroadcastService('TaalArc', arcUrl, headers)
}

/**
 * GorillaPool ARC broadcast service — EF format.
 */
export function createGorillaPoolBroadcastService(arcUrl: string) {
  return createArcBroadcastService('GorillaPoolArc', arcUrl, {})
}

/**
 * WhatsOnChain broadcast service — raw tx hex.
 */
export function createWocBroadcastService(chain: string, apiKey?: string) {
  const baseUrl =
    chain === 'main'
      ? 'https://api.whatsonchain.com/v1/bsv/main'
      : chain === 'test'
        ? 'https://api.whatsonchain.com/v1/bsv/test'
        : 'https://api.whatsonchain.com/v1/bsv/main'
  const name = 'WhatsOnChain'

  return {
    name,
    service: async (beef: Beef, txids: string[]): Promise<PostBeefResult> => {
      const r: PostBeefResult = { name, status: 'success', txidResults: [] }
      try {
        const tx = Transaction.fromBEEF(beef.toBinary())
        const rawHex = Utils.toHex(tx.toBinary())
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 30_000)
        let response: Response
        try {
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Accept': 'text/plain'
          }
          if (apiKey) headers['woc-api-key'] = apiKey
          response = await fetch(`${baseUrl}/tx/raw`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ txhex: rawHex }),
            signal: controller.signal
          })
        } finally {
          clearTimeout(timeout)
        }
        const body = await response.text()
        console.log(`[${name}] POST /tx/raw ${response.status}`, body)
        const txResult: PostTxResultForTxid = {
          txid: txids[0],
          status: 'error',
          notes: [{ when: new Date().toISOString(), what: 'wocPostRawTx', httpStatus: response.status }]
        }
        if (response.ok) {
          txResult.status = 'success'
        } else if (body.includes('already in the mempool')) {
          txResult.status = 'success'
        } else if (body.includes('mempool-conflict') || body.includes('Missing inputs')) {
          txResult.doubleSpend = true
        } else {
          txResult.serviceError = true
        }
        r.txidResults.push(txResult)
        r.status = txResult.status
      } catch (err: any) {
        console.log(`[${name}] POST /tx/raw error: ${err.message}`)
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
