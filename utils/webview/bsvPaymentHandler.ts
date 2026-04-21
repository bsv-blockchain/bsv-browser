import { PublicKey, Utils, Random } from '@bsv/sdk'
import type { WalletInterface, WalletProtocol } from '@bsv/sdk'
import { getErrorPage } from './errorPages'

const BRC29_PROTOCOL_ID: WalletProtocol = [2, '3241645161d8']
const HEADER_PREFIX = 'x-bsv-'

interface PaymentCacheEntry {
  html: string
  timestamp: number
}

const paymentCache = new Map<string, PaymentCacheEntry>()
const inFlightPayments = new Map<string, Promise<string | null>>()

export class BsvPaymentHandler {
  readonly wallet: WalletInterface
  readonly cacheTimeoutMs = 30 * 60 * 1000 // 30 minutes

  constructor(wallet: WalletInterface) {
    this.wallet = wallet
  }

  async handle402(url: string, status: number, headers: Record<string, string>): Promise<string | null> {
    const cacheKey = url
    const cached = paymentCache.get(cacheKey)

    if (cached && (Date.now() - cached.timestamp) < this.cacheTimeoutMs) {
      return cached.html
    }

    // Coalesce concurrent calls for the same URL into a single payment
    const existing = inFlightPayments.get(cacheKey)
    if (existing) {
      return existing
    }

    const paymentPromise = this._doPayment(url, headers)
    inFlightPayments.set(cacheKey, paymentPromise)

    try {
      return await paymentPromise
    } finally {
      inFlightPayments.delete(cacheKey)
    }
  }

  private async _doPayment(url: string, headers: Record<string, string>): Promise<string | null> {
    let satsHeader: string | undefined = headers[`${HEADER_PREFIX}sats`] || headers['x-bsv-sats']
    let serverHeader: string | undefined = headers[`${HEADER_PREFIX}server`] || headers['x-bsv-server']

    // WebView onHttpError and native navigations don't expose response headers.
    // If we got nothing, re-fetch the URL ourselves to read the 402 headers.
    if (!satsHeader && !serverHeader) {
      try {
        const probeRes = await fetch(url, { method: 'GET' })
        if (probeRes.status === 402) {
          satsHeader = probeRes.headers.get(`${HEADER_PREFIX}sats`) || undefined
          serverHeader = probeRes.headers.get(`${HEADER_PREFIX}server`) || undefined
        }
      } catch {
        return getErrorPage(402)
      }
    }

    if (!satsHeader || !serverHeader) {
      return getErrorPage(402)
    }

    const satoshisRequired = Number.parseInt(satsHeader)

    try {
      const serverIdentityKey = serverHeader
      const derivationPrefix = Utils.toBase64(Random(8))
      const timestamp = String(Date.now())
      // Server derives suffix as Buffer.from(time).toString('base64') — match it exactly
      const derivationSuffix = btoa(timestamp)
      const originator = new URL(url).origin

      const { publicKey: derivedPubKey } = await this.wallet.getPublicKey({
        protocolID: BRC29_PROTOCOL_ID,
        keyID: `${derivationPrefix} ${derivationSuffix}`,
        counterparty: serverIdentityKey
      }, originator)

      const pkh = PublicKey.fromString(derivedPubKey).toHash('hex') as string

      const { publicKey: senderIdentityKey } = await this.wallet.getPublicKey({ identityKey: true }, originator)

      const actionResult = await this.wallet.createAction({
        description: `Paid Content: ${new URL(url).pathname}`,
        outputs: [{
          satoshis: satoshisRequired,
          lockingScript: `76a914${pkh}88ac`,
          outputDescription: '402 web payment',
          customInstructions: JSON.stringify({
            derivationPrefix,
            derivationSuffix,
            serverIdentityKey
          }),
          tags: ['402-payment']
        }],
        labels: ['402-payment'],
        options: {
          randomizeOutputs: false
        }
      }, originator)

      const txBase64 = Utils.toBase64(actionResult.tx as number[])
      const vout = '0'

      const paymentHeaders: Record<string, string> = {
        [`${HEADER_PREFIX}sender`]: senderIdentityKey,
        [`${HEADER_PREFIX}beef`]: txBase64,
        [`${HEADER_PREFIX}nonce`]: derivationPrefix,
        [`${HEADER_PREFIX}time`]: timestamp,
        [`${HEADER_PREFIX}vout`]: vout
      }

      const response = await fetch(url, {
        headers: {
          ...paymentHeaders,
          Accept: 'text/html'
        } as HeadersInit
      })

      if (response.ok) {
        const html = await response.text()
        paymentCache.set(url, { html, timestamp: Date.now() })
        return html
      }

      return getErrorPage(402)
    } catch {
      return getErrorPage(402)
    }
  }

  clearCache() {
    paymentCache.clear()
    inFlightPayments.clear()
  }
}

// Singleton instance (will be initialized with wallet from context)
let paymentHandler: BsvPaymentHandler | null = null

export function getPaymentHandler(wallet?: WalletInterface): BsvPaymentHandler | null {
  if (wallet && !paymentHandler) {
    paymentHandler = new BsvPaymentHandler(wallet)
  }
  return paymentHandler
}
