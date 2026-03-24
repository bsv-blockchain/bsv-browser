import type { WebView } from 'react-native-webview'

export type Tab = {
  id: number
  url: string
  title: string
  webviewRef: React.RefObject<WebView<any> | null>
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
  isDesktopMode: boolean
}
export type HistoryEntry = { title: string; url: string; timestamp: number }
export type Bookmark = { title: string; url: string; added: number }
