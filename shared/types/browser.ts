import type { WebView } from 'react-native-webview'

export type Tab = {
  id: number
  // The live URL the page is currently showing — drives the address bar and
  // history. Updated freely from WebView navigation events (incl. SPA route /
  // fragment changes). Does NOT drive the WebView source, so mirroring the
  // page's own client-side navigation here never forces a reload.
  url: string
  // The URL we command the WebView to load — drives source.uri. Only changes on
  // explicit navigation (address bar, homepage, deep link, restore). Decoupled
  // from `url` so passive nav-state updates can't navigate the page away.
  sourceUrl: string
  title: string
  webviewRef: React.RefObject<WebView<any> | null>
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
  isDesktopMode: boolean
  thumbnailUri?: string
  // Host the current thumbnail represents. Recapture is skipped while a tab stays
  // on the same host and triggered when it changes (see the host-change effect).
  thumbnailHost?: string
  // Bumped on every capture. Appended to the thumbnail URI at render so expo-image
  // (which caches by URI) reloads the new bitmap — the file path is constant per
  // tab, so without this an overwritten thumbnail keeps showing the stale image.
  thumbnailVersion?: number
}
export type HistoryEntry = { title: string; url: string; timestamp: number }
export type Bookmark = { title: string; url: string; added: number }
