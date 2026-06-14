import { isExternalBrowserUrl, setPendingInitialBrowserUrl } from '@/utils/externalUrlRouter'

export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  try {
    if (path?.toLowerCase().startsWith('peerpay:')) {
      return `/payments?peerpay=${encodeURIComponent(path)}`
    }

    // http/https links are opened in-browser by useDeepLinking, which reads the
    // raw URL via Linking.getInitialURL / the 'url' event and opens a tab itself.
    // Returning the raw URL here makes Expo Router try to match it as an app
    // route, fail, and flash the +not-found screen ("Page could not be found.")
    // before the tab loads. Send Expo Router to index so the browser renders
    // immediately and the tab shows its own loading state.
    if (isExternalBrowserUrl(path)) {
      if (initial) setPendingInitialBrowserUrl(path)
      return '/'
    }

    return path || '/'
  } catch {
    return '/'
  }
}
