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

export class BsvPaymentHandler {
  readonly wallet: WalletInterface
  readonly cacheTimeoutMs = 30 * 60 * 1000 // 30 minutes

  constructor(wallet: WalletInterface) {
    this.wallet = wallet
  }

  async handle402(url: string, status: number, headers: Record<string, string>): Promise<string | null> {
    console.log('[PaymentHandler] handle402 called for', url, 'status:', status)
    console.log('[PaymentHandler] Received headers:', Object.keys(headers))
    console.log('[PaymentHandler] Full headers keys:', Object.keys(headers))

    const cacheKey = url
    const cached = paymentCache.get(cacheKey)
    
    if (cached && (Date.now() - cached.timestamp) < this.cacheTimeoutMs) {
      console.log('[PaymentHandler] Using cached paid content for:', url)
      return cached.html
    }

    let satsHeader: string | undefined = headers[`${HEADER_PREFIX}sats`] || headers['x-bsv-sats']
    let serverHeader: string | undefined = headers[`${HEADER_PREFIX}server`] || headers['x-bsv-server']

    // WebView onHttpError and native navigations don't expose response headers.
    // If we got nothing, re-fetch the URL ourselves to read the 402 headers.
    if (!satsHeader && !serverHeader) {
      console.log('[PaymentHandler] No headers from WebView, re-fetching to read 402 headers...')
      try {
        const probeRes = await fetch(url, { method: 'GET' })
        console.log('[PaymentHandler] Probe response status:', probeRes.status)
        if (probeRes.status === 402) {
          satsHeader = probeRes.headers.get(`${HEADER_PREFIX}sats`) || undefined
          serverHeader = probeRes.headers.get(`${HEADER_PREFIX}server`) || undefined
          console.log('[PaymentHandler] Probe got sats:', satsHeader, 'server:', serverHeader?.substring(0, 20) + '...')
        }
      } catch (e) {
        console.error('[PaymentHandler] Probe fetch failed:', e)
      }
    }

    if (!satsHeader || !serverHeader) {
      console.warn('[PaymentHandler] 402 response missing required payment headers after probe')
      return getErrorPage(402)
    }

    const satoshisRequired = Number.parseInt(satsHeader)
    console.log(`Payment required: ${satoshisRequired} sats for ${url}`)

    try {
      console.log('[PaymentHandler] Creating payment for', url)
      // Create payment using BRC-29
      const serverIdentityKey = serverHeader
      const derivationPrefix = Utils.toBase64(Random(8))
      const derivationSuffix = Utils.toBase64(Random(8))
      console.log('[PaymentHandler] Derivation prefix/suffix generated')
      
      console.log('[PaymentHandler] Calling getPublicKey with protocol for counterparty', serverIdentityKey.substring(0, 20) + '...')
      const originator = new URL(url).origin
      const { publicKey: derivedPubKey } = await this.wallet.getPublicKey({
        protocolID: BRC29_PROTOCOL_ID,
        keyID: `${derivationPrefix} ${derivationSuffix}`,
        counterparty: serverIdentityKey
      }, originator)
      console.log('[PaymentHandler] Derived pubkey length:', derivedPubKey?.length)

      const pkh = PublicKey.fromString(derivedPubKey).toHash('hex') as string
      
      const { publicKey: senderIdentityKey } = await this.wallet.getPublicKey({ identityKey: true }, originator)
      console.log('[PaymentHandler] Sender identity key:', senderIdentityKey.substring(0, 20) + '...')

      console.log('[PaymentHandler] Calling createAction...')
      const actionResult = await this.wallet.createAction({
        description: `402 payment for: ${new URL(url).pathname}`,
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
      console.log('[PaymentHandler] Action result txid:', actionResult.txid, 'tx length:', actionResult.tx?.length || 0)

      const { publicKey: senderIdentity } = await this.wallet.getPublicKey({ identityKey: true }, originator)
      console.log('[PaymentHandler] Sender identity key:', senderIdentity.substring(0, 20) + '...')

      const paymentHeaders: Record<string, string> = {
        [`${HEADER_PREFIX}sender`]: senderIdentity,
        [`${HEADER_PREFIX}beef`]: txBase64,
        [`${HEADER_PREFIX}prefix`]: derivationPrefix,
        [`${HEADER_PREFIX}suffix`]: derivationSuffix,
        [`${HEADER_PREFIX}vout`]: vout
      }
      console.log('[PaymentHandler] Sending payment headers:', Object.keys(paymentHeaders))

      // Retry with payment headers
      console.log('[PaymentHandler] Retrying fetch with payment headers...')
      const response = await fetch(url, {
        headers: {
          ...paymentHeaders,
          Accept: 'text/html'
        } as HeadersInit
      })

      console.log('[PaymentHandler] Retry response status:', response.status, 'ok:', response.ok)
      if (response.ok) {
        const html = await response.text()
        paymentCache.set(cacheKey, {
          html,
          timestamp: Date.now()
        })
        console.log('[PaymentHandler] Payment successful, cached content for:', url)
        return html
      }
      
      console.log('[PaymentHandler] Payment retry failed with status:', response.status)
      return getErrorPage(402)
    } catch (error) {
      console.log('[PaymentHandler] Payment handling failed:', error)
      return getErrorPage(402)
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