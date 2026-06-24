import { kNEW_TAB_URL } from '@/shared/constants'

// Helper function to validate URL
export function isValidUrl(url: string): boolean {
  if (!url) return false
  try {
    new URL(url.startsWith('http') ? url : `https://${url}`)
    return url.startsWith('http://') || url.startsWith('https://') || url === kNEW_TAB_URL
  } catch {
    return false
  }
}

/**
 * Query parameters that are transient tokens added by security challenge flows
 * (Cloudflare, etc.). These cause redirect loops when treated as distinct URLs:
 *   page → page?__cf_chl_tk=... → page → page?__cf_chl_tk=... (∞)
 * Stripping them before comparison/storage breaks the loop.
 */
const TRANSIENT_QUERY_PARAMS = [
  '__cf_chl_tk', // Cloudflare challenge token
  '__cf_chl_rt_tk', // Cloudflare challenge retry token
  '__cf_chl_f_tk', // Cloudflare challenge flow token
  '__cf_chl_captcha_tk', // Cloudflare captcha token
  '__cf_chl_managed_tk' // Cloudflare managed challenge token
]

/**
 * Strips transient challenge/tracking parameters from a URL so that the
 * "clean" URL and its challenge-decorated variant are treated as the same page.
 */
export function normalizeUrlForHistory(url: string): string {
  try {
    const parsed = new URL(url)
    for (const param of TRANSIENT_QUERY_PARAMS) {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.delete(param)
      }
    }

    // URL.toString() also canonicalizes equivalent spellings such as
    // `https://example.com/.?x=1` and `https://example.com/?x=1`. Keeping the
    // controlled WebView source in that canonical form prevents websites and
    // manifests from bouncing between equivalent URLs forever.
    return parsed.toString()
  } catch {
    return url
  }
}

// Code points that are legal inside a JSON string but break a JS string literal
// (or crash older WebKit when injected): LINE SEPARATOR and PARAGRAPH SEPARATOR.
// Built from numeric code points so no raw separator byte exists in this source.
const LINE_SEP = 0x2028
const PARA_SEP = 0x2029
const JS_STRING_UNSAFE = new RegExp('[' + String.fromCharCode(LINE_SEP, PARA_SEP) + ']', 'g')

/**
 * Build a safe `window.location.href = …;` script for WebView.injectJavaScript().
 *
 * Interpolating a URL straight into a template literal (`href = "${url}"`) breaks
 * the instant the URL contains a double-quote, backslash, newline, or one of the
 * separators above — the injected source becomes a syntax error. On iOS a syntax
 * error in injectJavaScript kills the WebContent process
 * (onContentProcessDidTerminate), which reads to the user as an app crash. This is
 * the exact failure mode for arbitrary deep-linked URLs (the default-browser case).
 *
 * JSON.stringify yields a valid JS string literal for every input except those two
 * separators, which we escape explicitly.
 *
 * The new-tab sentinel (about:blank) maps through unchanged — it has no real URL.
 */
export function buildLocationHrefScript(url: string): string {
  const target = url === kNEW_TAB_URL ? 'about:blank' : url
  const literal = JSON.stringify(target).replace(JS_STRING_UNSAFE, ch => '\\u' + ch.charCodeAt(0).toString(16))
  return `window.location.href = ${literal};true;`
}
