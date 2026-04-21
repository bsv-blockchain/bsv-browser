import { Platform } from 'react-native'
import { Bookmark } from './types/browser'

export const kNEW_TAB_URL = 'about:blank'
export const DEFAULT_HOMEPAGE_URL = 'https://mobile.bsvb.tech/landing.html'

/**
 * Minimum bottom inset (px) for Android devices.
 * Keeps UI above the OS navigation bar even when safe-area-context reports 0.
 */
export const ANDROID_MIN_BOTTOM_INSET = 24

/**
 * Height of the AddressBar wrapper in pixels.
 * paddingTop(4) + pill(44) = 48px
 */
export const ADDRESS_BAR_HEIGHT = 48

/**
 * Returns a safe bottom inset that respects a platform-appropriate minimum.
 * On Android, enforces at least ANDROID_MIN_BOTTOM_INSET to handle devices
 * where safe-area-context does not report the OS navigation bar height.
 */
export function safeBottomInset(bottom: number): number {
  return Platform.OS === 'android' ? Math.max(bottom, ANDROID_MIN_BOTTOM_INSET) : bottom
}

export interface SearchEngine {
  id: string
  label: string
  /** URL template — `%s` is replaced with the encoded query */
  urlTemplate: string
  icon: string
}

export const SEARCH_ENGINES: SearchEngine[] = [
  { id: 'brave', label: 'Brave', urlTemplate: 'https://search.brave.com/search?q=%s', icon: 'shield-outline' },
  { id: 'google', label: 'Google', urlTemplate: 'https://www.google.com/search?q=%s', icon: 'logo-google' },
  { id: 'bing', label: 'Bing', urlTemplate: 'https://www.bing.com/search?q=%s', icon: 'search-outline' },
  { id: 'duckduckgo', label: 'DuckDuckGo', urlTemplate: 'https://duckduckgo.com/?q=%s', icon: 'eye-off-outline' },
  {
    id: 'startpage',
    label: 'Startpage',
    urlTemplate: 'https://www.startpage.com/sp/search?query=%s',
    icon: 'lock-closed-outline'
  }
]

export const DEFAULT_SEARCH_ENGINE_ID = 'startpage'

/** Auto-approve transactions below this satoshi amount without showing the spend modal */
export const DEFAULT_AUTO_APPROVE_THRESHOLD = 100_000
/** Minimum milliseconds between auto-approved transactions (global, origin-agnostic) */
export const AUTO_APPROVE_COOLDOWN_MS = 10_000
/** AsyncStorage key for persisted auto-approve threshold */
export const AUTO_APPROVE_STORAGE_KEY = 'autoApproveThreshold'
/** AsyncStorage key for display currency preference */
export const DISPLAY_CURRENCY_STORAGE_KEY = 'displayCurrency'

export const defaultBookmarks: Bookmark[] = [
  // { title: 'BSV Association', url: 'https://bitcoinsv.com', added: 0 },
  // { title: 'Project Babbage', url: 'https://projectbabbage.com', added: 0 },
  // { title: 'Google', url: 'https://google.com', added: 0 },
  // { title: 'YouTube', url: 'https://youtube.com', added: 0 },
  // { title: 'Twitter', url: 'https://twitter.com', added: 0 },
  // { title: 'Facebook', url: 'https://facebook.com', added: 0 },
  // { title: 'GitHub', url: 'https://github.com', added: 0 },
  // { title: 'StackOverflow', url: 'https://stackoverflow.com', added: 0 },
  // { title: 'Reddit', url: 'https://reddit.com', added: 0 },
  // { title: 'Medium', url: 'https://medium.com', added: 0 }
]
