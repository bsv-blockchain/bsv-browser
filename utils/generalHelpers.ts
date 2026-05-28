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
    let changed = false
    for (const param of TRANSIENT_QUERY_PARAMS) {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.delete(param)
        changed = true
      }
    }
    if (!changed) return url
    return parsed.toString()
  } catch {
    return url
  }
}
