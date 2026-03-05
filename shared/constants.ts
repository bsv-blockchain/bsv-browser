import { Bookmark } from './types/browser'

export const kNEW_TAB_URL = 'about:blank'
export const DEFAULT_HOMEPAGE_URL = 'https://mobile.bsvb.tech/landing.html'

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
