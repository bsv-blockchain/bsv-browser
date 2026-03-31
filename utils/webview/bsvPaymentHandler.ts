import type { WalletInterface } from '@bsv/sdk'

const BRC29_PROTOCOL_ID = [2, '3241645161d8'] as const
const HEADER_PREFIX = 'x-bsv-'

interface PaymentCacheEntry {
  html: string
  timestamp: number
}

const paymentCache = new Map<string, PaymentCacheEntry>()

export class BsvPaymentHandler {
  private wallet: WalletInterface
  private cacheTimeoutMs = 30 * 60 * 1000 // 30 minutes

  constructor(wallet: WalletInterface) {
    this.wallet = wallet
  }

  async handle402(url: string, status: number, headers: Record<string, string>): Promise<string | null> {
    const cacheKey = url
    const cached = paymentCache.get(cacheKey)
    
    if (cached && (Date.now() - cached.timestamp) < this.cacheTimeoutMs) {
      console.log('Using cached paid content for:', url)
      return cached.html
    }

    const satsHeader = headers[`${HEADER_PREFIX}sats`] || headers['x-bsv-sats']
    const serverHeader = headers[`${HEADER_PREFIX}server`] || headers['x-bsv-server']
    
    if (!satsHeader || !serverHeader) {
      console.warn('402 response missing required payment headers')
      return null
    }

    const satoshisRequired = parseInt(satsHeader)
    console.log(`Payment required: ${satoshisRequired} sats for ${url}`)

    try {
      // Create payment using BRC-29
      const serverIdentityKey = serverHeader
      const derivationPrefix = btoa(`prefix-${Date.now()}`)
      const derivationSuffix = btoa(`suffix-${Math.random()}`)
      
      const { publicKey: derivedPubKey } = await this.wallet.getPublicKey({
        protocolID: BRC29_PROTOCOL_ID,
        keyID: `${derivationPrefix} ${derivationSuffix}`,
        counterparty: serverIdentityKey,
        forSelf: true
      })

      const actionResult = await this.wallet.createAction({
        description: `Payment for article: ${new URL(url).pathname}`,
        outputs: [{
          satoshis: satoshisRequired,
          lockingScript: `76a914${derivedPubKey.slice(2)}88ac`, // Simplified P2PKH
          customInstructions: JSON.stringify({
            derivationPrefix,
            derivationSuffix,
            payee: serverIdentityKey
          })
        }]
      })

      const txBase64 = Buffer.from(actionResult.tx || '').toString('base64')
      const txid = '0000000000000000000000000000000000000000000000000000000000000000' // placeholder
      const outpoint = `${txid}.0`

      const paymentHeaders = {
        [`${HEADER_PREFIX}sender`]: await this.wallet.getPublicKey({ identityKey: true }),
        [`${HEADER_PREFIX}beef`]: txBase64,
        [`${HEADER_PREFIX}prefix`]: derivationPrefix,
        [`${HEADER_PREFIX}suffix`]: derivationSuffix,
        [`${HEADER_PREFIX}outpoint`]: outpoint
      }

      // Retry with payment headers
      const response = await fetch(url, {
        headers: {
          ...paymentHeaders,
          'Accept': 'text/html'
        }
      })

      if (response.ok) {
        const html = await response.text()
        paymentCache.set(cacheKey, {
          html,
          timestamp: Date.now()
        })
        console.log('Payment successful, cached content for:', url)
        return html
      }
      
      console.error('Payment retry failed with status:', response.status)
      return null
    } catch (error) {
      console.error('Payment handling failed:', error)
      return null
    }
  }

  clearCache() {
    paymentCache.clear()
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