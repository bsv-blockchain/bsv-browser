import AsyncStorage from '@react-native-async-storage/async-storage'
import type { WebViewNavigation } from 'react-native-webview'
import { TabStore } from '@/stores/TabStore'
import { kNEW_TAB_URL } from '@/shared/constants'

jest.mock('@/utils/thumbnailService', () => ({ deleteThumbnail: jest.fn() }))
jest.mock('@/utils/perf', () => ({ perf: { mark: () => jest.fn() } }))
jest.mock('@bsv/expo-wallet-toolbox/core/deviceTier', () => ({
  maxTabsForTier: () => 4,
  warmPoolSizeForTier: () => 1
}))
jest.mock('@bsv/expo-wallet-toolbox/core/logging', () => ({ devLog: jest.fn() }))

const cover = 'https://reader.example/publication/book'
const page = 'https://reader.example/read/book/1'
const nav = (url: string, loading: boolean, title = 'Book'): WebViewNavigation => ({
  url,
  loading,
  title,
  canGoBack: true,
  canGoForward: false,
  navigationType: 'other',
  lockIdentifier: 0
})

describe('native tab navigation', () => {
  beforeEach(async () => {
    jest.useFakeTimers()
    await AsyncStorage.clear()
  })
  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it('retains a loading-start-only reader route through tab changes and process restoration', async () => {
    const store = new TabStore()
    store.newTab(cover)
    store.handleNavigationStateChange(1, nav(cover, false, 'Cover'))
    store.handleNavigationStateChange(1, nav(page, true, 'Cover'))
    expect(store.activeTab?.url).toBe(page)
    expect(store.activeTab?.isLoading).toBe(true)
    // Passive navigation must not issue a second load or trust a stale title.
    expect(store.activeTab?.sourceUrl).toBe(cover)
    store.handleNavigationStateChange(1, nav(page, true, 'Cover'))
    store.newTab()
    store.closeTab(2)
    expect(store.activeTab?.url).toBe(page)
    await store.flushTabs()
    const history = JSON.parse((await AsyncStorage.getItem('tabNavigationHistories'))!)['1']
    expect(history.map((entry: { url: string }) => entry.url)).toEqual([kNEW_TAB_URL, cover, page])
    expect(history[2].title).toBe(page)
    const restored = new TabStore()
    await restored.loadTabs()
    expect(restored.activeTab?.url).toBe(page)
    restored.handleNavigationStateChange(1, nav('javascript:alert(1)', true))
    expect(restored.activeTab?.url).toBe(page)
  })

  it('preserves the forward stack through both completion callbacks of a history jump', async () => {
    const store = new TabStore()
    store.newTab(cover)
    store.handleNavigationStateChange(1, nav(cover, false))
    store.handleNavigationStateChange(1, nav(page, true))
    store.activeTab!.webviewRef.current = { injectJavaScript: jest.fn() } as never
    store.goBack(1)
    expect(store.activeTab?.url).toBe(cover)
    store.handleNavigationStateChange(1, nav(cover, true))
    store.handleNavigationStateChange(1, nav(cover, false))
    store.handleNavigationStateChange(1, nav(cover, false))
    expect(store.activeTab?.canGoForward).toBe(true)
    store.goForward(1)
    expect(store.activeTab?.url).toBe(page)
    store.handleNavigationStateChange(1, nav(page, false))
    store.handleNavigationStateChange(1, nav(page, false))
    await store.flushTabs()
    const history = JSON.parse((await AsyncStorage.getItem('tabNavigationHistories'))!)['1']
    expect(history.map((entry: { url: string }) => entry.url)).toEqual([kNEW_TAB_URL, cover, page])
  })
})
