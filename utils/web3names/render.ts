/**
 * Pure rendering helpers for web3 sites — dependency-free and unit-testable
 * anywhere (openWeb3Site.ts wires them to the app's crypto and tx source).
 */

/**
 * React-Native glue: turn a classified web3 address into a tab URL.
 *
 * Delivery is a data: URI — the content bytes were already verified against
 * the SIGNED txid (content addressing), so the WebView renders exactly what
 * the chain holds, with no origin powers, cookies, or network identity.
 * Failures render an honest inline page with the resolver's reason code —
 * never a silent fallback.
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Hard ceiling on inline-rendered content — a polite refusal beats a frozen bridge. */
export const MAX_INLINE_BYTES = 400 * 1024

export function bytesToBase64 (bytes: Uint8Array): string {
  const parts: string[] = []
  const chunk: string[] = []
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0
    chunk.push(
      B64[a >> 2],
      B64[((a & 3) << 4) | (b >> 4)],
      i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '=',
      i + 2 < bytes.length ? B64[c & 63] : '='
    )
    if (chunk.length >= 4096) {
      parts.push(chunk.join(''))
      chunk.length = 0
    }
  }
  parts.push(chunk.join(''))
  return parts.join('')
}

export const htmlToDataUri = (html: string): string => `data:text/html;base64,${bytesToBase64(new TextEncoder().encode(html))}`

export const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }) as Record<string, string>)[c])

export function web3ErrorPage (name: string, reason: string): string {
  return htmlToDataUri(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<body style="font-family:-apple-system,sans-serif;background:#fafaf7;color:#16181a;display:flex;min-height:90vh;align-items:center;justify-content:center">` +
      `<div style="max-width:420px;padding:24px;text-align:center"><div style="font-size:40px">&#9888;&#65039;</div>` +
      `<h2 style="font-weight:600">${esc(name)}</h2>` +
      `<p style="color:#5a5e66;line-height:1.5">${esc(reason)}</p>` +
      `<p style="font-size:12px;color:#9a9ea6">web3 name resolution &middot; independently verifiable &middot; odnca.org</p></div>`
  )
}


export function web3TooLargePage (name: string, bytes: number): string {
  const kb = Math.round(bytes / 1024)
  return web3ErrorPage(name, `This on-chain site is ${kb} KB — larger than the browser will render inline (limit ${Math.round(MAX_INLINE_BYTES / 1024)} KB).`)
}

/** Instant feedback page shown while the name resolves — no dead air after enter. */
export function web3SplashPage (name: string): string {
  return htmlToDataUri(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<body style="font-family:-apple-system,sans-serif;background:#fafaf7;color:#16181a;display:flex;min-height:90vh;align-items:center;justify-content:center">` +
      `<div style="text-align:center"><div style="width:28px;height:28px;margin:0 auto 14px;border:3px solid #d8dad2;border-top-color:#16181a;border-radius:50%;animation:s 0.8s linear infinite"></div>` +
      `<style>@keyframes s{to{transform:rotate(360deg)}}</style>` +
      `<div style="font-family:ui-monospace,monospace;font-size:15px">${esc(name)}</div>` +
      `<div style="font-size:12px;color:#9a9ea6;margin-top:6px">resolving on-chain&hellip;</div></div>`
  )
}
