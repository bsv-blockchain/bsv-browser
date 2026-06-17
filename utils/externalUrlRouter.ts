const DUPLICATE_URL_WINDOW_MS = 2500

let pendingInitialBrowserUrl: string | null = null
let lastHandledUrl: string | null = null
let lastHandledAt = 0

export function isExternalBrowserUrl(url: string | null | undefined): boolean {
  if (!url) return false
  const lower = url.toLowerCase()
  return lower.startsWith('http://') || lower.startsWith('https://')
}

function normalizeForDedupe(url: string): string {
  try {
    return new URL(url).toString()
  } catch {
    return url
  }
}

export function setPendingInitialBrowserUrl(url: string) {
  if (isExternalBrowserUrl(url)) pendingInitialBrowserUrl = url
}

export function consumePendingInitialBrowserUrl(): string | null {
  const url = pendingInitialBrowserUrl
  pendingInitialBrowserUrl = null
  return url
}

/**
 * iOS may surface a cold-start URL through both Expo Router's native-intent
 * hook and React Native Linking. Suppress only the duplicate delivery window;
 * the same URL can still be opened again later as an intentional new action.
 */
export function shouldHandleExternalBrowserUrl(url: string, now = Date.now()): boolean {
  const normalized = normalizeForDedupe(url)
  if (normalized === lastHandledUrl && now - lastHandledAt < DUPLICATE_URL_WINDOW_MS) {
    return false
  }

  lastHandledUrl = normalized
  lastHandledAt = now
  return true
}

export function externalUrlsMatch(a: string, b: string): boolean {
  return normalizeForDedupe(a) === normalizeForDedupe(b)
}

export function resetExternalUrlRouterForTests() {
  pendingInitialBrowserUrl = null
  lastHandledUrl = null
  lastHandledAt = 0
}
