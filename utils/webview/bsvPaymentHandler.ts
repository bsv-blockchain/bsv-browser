import { PublicKey, Utils, Random } from '@bsv/sdk'
import type { WalletInterface, WalletProtocol } from '@bsv/sdk'
import { getErrorPage } from './errorPages'
import { handleUrlDownload } from './downloadHandler'

const BRC29_PROTOCOL_ID: WalletProtocol = [2, '3241645161d8']
const HEADER_PREFIX = 'x-bsv-'

interface PaymentCacheEntry {
  html: string
  timestamp: number
}

const paymentCache = new Map<string, PaymentCacheEntry>()
const inFlightPayments = new Map<string, Promise<string | null>>()

function safeOrigin(u: string): string {
  try { return new URL(u).origin } catch { return '' }
}

/**
 * Parse a filename out of an HTTP Content-Disposition header, honoring both
 * the legacy `filename="..."` and the RFC 5987 `filename*=UTF-8''...` form.
 */
function parseFilenameFromContentDisposition(value: string | null | undefined): string | null {
  if (!value) return null
  // filename*=UTF-8''<percent-encoded>   (RFC 5987 — preferred when present)
  const ext = value.match(/filename\*\s*=\s*([^']+)''([^;]+)/i)
  if (ext) {
    try { return decodeURIComponent(ext[2].trim()) } catch { /* fall through */ }
  }
  // filename="..." or filename=...
  const plain = value.match(/filename\s*=\s*("([^"]+)"|([^;]+))/i)
  if (plain) {
    const v = (plain[2] || plain[3] || '').trim()
    if (v) return v
  }
  return null
}

/**
 * Parse the same params out of an S3-style presigned URL (the AWS SDK adds
 * `response-content-disposition` and `response-content-type` query params
 * when the GetObjectCommand was given those overrides).
 */
function paramsFromPresignedUrl(rawUrl: string): { filename: string | null; mimeType: string | null } {
  try {
    const u = new URL(rawUrl)
    const cd = u.searchParams.get('response-content-disposition')
    const ct = u.searchParams.get('response-content-type')
    return {
      filename: parseFilenameFromContentDisposition(cd),
      mimeType: ct || null
    }
  } catch {
    return { filename: null, mimeType: null }
  }
}

/**
 * Lightweight confirmation page shown briefly after a paid download has been
 * handed off to the native downloader. The OS share-sheet is the real UI;
 * this is just so the WebView shows something coherent instead of garbage
 * binary bytes injected as HTML.
 */
function buildDownloadStartedHtml(filename?: string | null): string {
  const escName = (filename ? String(filename) : 'file').replace(/[<>&"']/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c] as string
  ))
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Download started</title>
<style>
  html,body{margin:0;height:100%;}
  body{background:#0d0905;color:#f3e9d2;
       font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;
       display:flex;align-items:center;justify-content:center;padding:24px;
       text-align:center;}
  .wrap{max-width:380px;}
  .saved{font-size:18px;margin-bottom:8px;}
  .filename{color:#d9a86a;font-style:italic;word-break:break-all;}
  .hint{margin-top:18px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#8a7d62;}
  button{margin-top:18px;background:transparent;color:#f3e9d2;border:1px solid #3a2c1a;
         padding:10px 18px;font:500 14px system-ui,sans-serif;cursor:pointer;}
  button:hover{border-color:#5a401e;}
</style>
</head><body>
<div class="wrap">
  <div class="saved">Saved <span class="filename">${escName}</span></div>
  <div class="hint">// pick "Save to Files" or "Save Image" in the share sheet</div>
  <button onclick="(function(){try{history.back()}catch(e){}})()">Back</button>
</div>
</body></html>`
}

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
        // If the paid endpoint redirected us cross-origin (typical of paid
        // file downloads — e.g. dropular.link/f/abc → presigned R2 URL),
        // fetch has already followed the redirect and we now hold the
        // binary body. Don't try to inject those bytes as HTML. Hand the
        // resolved URL back to the WebView via a meta-refresh / location
        // replace so the OS native downloader can handle the attachment.
        const requestOrigin = safeOrigin(url)
        const responseOrigin = safeOrigin(response.url)
        const isCrossOriginRedirect =
          response.redirected && responseOrigin !== '' && responseOrigin !== requestOrigin

        if (isCrossOriginRedirect) {
          try { await response.body?.cancel() } catch { /* ignore */ }
          // Pull filename + mimeType out of either the response headers or
          // (more reliably for S3/R2 presigned URLs) the query params the
          // signer baked into the URL itself.
          const cdHeader = response.headers.get('content-disposition')
          const ctHeader = response.headers.get('content-type')
          const params = paramsFromPresignedUrl(response.url)
          const filename = parseFilenameFromContentDisposition(cdHeader) ?? params.filename ?? undefined
          const mimeType = ctHeader || params.mimeType || undefined
          // Run the OS download natively (we're already in the RN runtime,
          // no need to round-trip through the WebView via postMessage).
          // Intentionally NOT awaited: handleUrlDownload presents a share
          // sheet which we don't want to block the WebView on.
          handleUrlDownload(response.url, mimeType, filename).catch(() => { /* surfaced via share sheet */ })
          // Intentionally NOT cached — the presigned URL expires shortly
          // and the payment cache would hand out a stale signature.
          return buildDownloadStartedHtml(filename)
        }

        const contentType = response.headers.get('content-type') || ''
        if (contentType && !/text\/html/i.test(contentType)) {
          // Same-origin, but the paid endpoint returned a non-HTML asset.
          // Same treatment: hand the URL to the native downloader.
          try { await response.body?.cancel() } catch { /* ignore */ }
          const filename = parseFilenameFromContentDisposition(response.headers.get('content-disposition')) ?? undefined
          handleUrlDownload(response.url || url, contentType, filename).catch(() => {})
          return buildDownloadStartedHtml(filename)
        }

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
