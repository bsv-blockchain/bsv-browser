// stores/TabStore.tsx
import { createRef } from 'react'
import { makeAutoObservable, runInAction } from 'mobx'
import { WebView } from 'react-native-webview'
import { LayoutAnimation } from 'react-native'
import { Tab } from '@/shared/types/browser'
import { kNEW_TAB_URL } from '@/shared/constants'
import { isValidUrl, normalizeUrlForHistory } from '@/utils/generalHelpers'
import { deleteThumbnail } from '@/utils/thumbnailService'
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { WebViewNavigation } from 'react-native-webview'
const STORAGE_KEYS = { TABS: 'tabs', ACTIVE: 'activeTabId' }

export class TabStore {
  tabs: Tab[] = [] // Always initialize as an array
  activeTabId = 1
  showTabsView = false
  isInitialized = false // Add initialization flag
  private nextId = 1
  private tabNavigationHistories: { [tabId: number]: { url: string; title: string }[] } = {} // Track navigation history per tab
  private tabHistoryIndexes: { [tabId: number]: number } = {} // Track current position in history per tab
  // Tab IDs for which the next navigation state change is a programmatic history jump
  // (goBack / goForward / navigateToHistoryIndex). handleNavigationStateChange skips the
  // history-append logic for these so jumps are never mistaken for new navigations.
  //
  // This is a Map<tabId, remainingCount> instead of a Set because both
  // onNavigationStateChange and onLoadEnd call handleNavigationStateChange with
  // loading=false for the same navigation event.  Using a countdown of 2 ensures
  // both callbacks are treated as jumps and neither one spuriously appends a new
  // history entry (which would make back/forward look like a page refresh).
  private pendingHistoryJumps: Map<number, number> = new Map()
  constructor() {
    console.log('TabStore constructor called')
    makeAutoObservable(this)
  }

  async initializeTabs() {
    if (this.isInitialized) return

    await this.loadTabs()

    // This logic is now safe because loadTabs has completed.
    if (this.tabs.length === 0) {
      console.log('No tabs found after loading, creating a new initial tab.')
      this.newTab()
    }

    // Use runInAction to safely update the state after async operations
    runInAction(() => {
      this.isInitialized = true
    })
  }

  createTab(url?: string | null): Tab {
    // Ensure url is never null or undefined
    const safeUrl = url && isValidUrl(url) ? url : kNEW_TAB_URL
    return {
      id: this.nextId++,
      url: safeUrl,
      title: 'New Tab',
      webviewRef: createRef<WebView>(),
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
      isDesktopMode: false
    }
  }

  newTab = (initialUrl?: string | null) => {
    console.log(`newTab() called with initialUrl=${initialUrl}`)
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)

    // Ensure initialUrl is never null or undefined
    const safeInitialUrl = initialUrl || kNEW_TAB_URL
    const newTab = this.createTab(safeInitialUrl)
    this.tabs.push(newTab)
    this.activeTabId = newTab.id

    // Initialize navigation history for new tab
    // ALWAYS include the new tab page as the first entry so users can navigate back to it
    if (
      safeInitialUrl &&
      safeInitialUrl !== kNEW_TAB_URL &&
      safeInitialUrl !== 'about:blank' &&
      isValidUrl(safeInitialUrl)
    ) {
      // Start with new tab page, then add the initial URL
      this.tabNavigationHistories[newTab.id] = [
        { url: kNEW_TAB_URL, title: 'New Tab' },
        { url: safeInitialUrl, title: safeInitialUrl }
      ]
      this.tabHistoryIndexes[newTab.id] = 1 // Currently on the initial URL
    } else {
      // For new tabs, start with new tab page in history
      this.tabNavigationHistories[newTab.id] = [{ url: kNEW_TAB_URL, title: 'New Tab' }]
      this.tabHistoryIndexes[newTab.id] = 0 // Currently on new tab page
    }

    this.saveTabs()
  }

  get activeTab(): Tab | null {
    const tab = this.tabs.find(t => t.id === this.activeTabId)

    // If no tab found but we have tabs, fix the activeTabId to point to the first tab
    if (!tab && this.tabs.length > 0) {
      runInAction(() => {
        this.activeTabId = this.tabs[0].id
      })
      return this.tabs[0]
    }

    return tab || null
  }

  setActiveTab(id: number) {
    const targetTab = this.tabs.find(t => t.id === id)
    console.log(`setActiveTab(): Switching from tab ${this.activeTabId} to tab ${id}`)

    if (targetTab && targetTab.id !== this.activeTabId) {
      console.log(`setActiveTab(): Setting activeTabId=${id}`)
      this.activeTabId = id
      this.saveActive().catch(e => console.error('saveActive failed', e))
    } else if (!targetTab) {
      console.warn(`setActiveTab(): Target tab ${id} not found`)
    } else {
      console.log(`setActiveTab(): Tab ${id} is already active, no change needed`)
    }
  }
  async saveActive() {
    await AsyncStorage.setItem(STORAGE_KEYS.ACTIVE, String(this.activeTabId))
  }
  setShowTabsView(show: boolean) {
    this.showTabsView = show
  }

  updateTab(id: number, patch: Partial<Tab>) {
    const tab = this.tabs.find(t => t.id === id)
    if (tab) {
      // Handle URL updates with null safety
      if ('url' in patch) {
        const newUrl = patch.url
        if (!newUrl || newUrl === null || newUrl === undefined || !isValidUrl(newUrl)) {
          patch.url = kNEW_TAB_URL
        }
      }

      const newUrl = patch.url
      const urlChanging = 'url' in patch && newUrl !== tab.url && newUrl && newUrl !== kNEW_TAB_URL

      // Log significant updates for debugging
      if ('url' in patch && newUrl !== tab.url) {
        console.log(`updateTab(): Updating tab ${id} URL from "${tab.url}" to "${newUrl}"`)
      }

      Object.assign(tab, patch)

      // When the URL changes via user navigation (address bar submit, suggestion tap, etc.),
      // immediately record the new entry in the tab's history. Use the URL as a placeholder
      // title — handleNavigationStateChange will update it once the page title arrives.
      // Also mark as a pending jump so handleNavigationStateChange doesn't double-append.
      if (urlChanging && newUrl) {
        const history = this.tabNavigationHistories[id] || []
        const currentIndex = this.tabHistoryIndexes[id] ?? -1
        const newHistory =
          currentIndex >= 0 ? history.slice(0, currentIndex + 1) : [{ url: kNEW_TAB_URL, title: 'New Tab' }]
        newHistory.push({ url: newUrl, title: newUrl })
        this.tabNavigationHistories[id] = newHistory
        this.tabHistoryIndexes[id] = newHistory.length - 1
        tab.canGoBack = newHistory.length > 1
        tab.canGoForward = false
        this.pendingHistoryJumps.set(id, 2)
      }

      this.saveTabs()
    } else {
      console.warn(`updateTab(): Tab with id ${id} not found`)
    }
  }

  goBack(tabId: number) {
    const tab = this.tabs.find(t => t.id === tabId)
    const history = this.tabNavigationHistories[tabId] || []
    const currentIndex = this.tabHistoryIndexes[tabId] ?? -1

    console.log(`🔙 [TAB_STORE] goBack(): tabId=${tabId}`)

    // Log detailed webView ref information
    console.log(`🔙 [TAB_STORE] WebView ref details for tab ${tabId}:`, {
      hasTab: !!tab,
      hasWebViewRef: !!tab?.webviewRef,
      webViewRefCurrent: !!tab?.webviewRef?.current,
      webViewRefType: typeof tab?.webviewRef?.current,
      canGoBack: tab?.canGoBack,
      historyLength: history.length,
      currentIndex: currentIndex
    })

    if (!tab || !tab.webviewRef.current) {
      console.log(`🔙 [TAB_STORE] Cannot go back: missing tab or webview ref`)
      return
    }

    // HYBRID APPROACH: Use custom history for new tab scenarios, WebView native for others
    // The first history entry is always kNEW_TAB_URL (about:blank), which acts as a sentinel.
    // We never navigate back to it — the back button should be disabled before reaching it.
    const minNavigableIndex = history.length > 0 && history[0]?.url === kNEW_TAB_URL ? 1 : 0

    if (history.length > 1 && currentIndex > minNavigableIndex) {
      // Use custom history navigation for new tab page scenarios
      const newIndex = currentIndex - 1
      const entry = history[newIndex]
      const url = entry.url

      console.log(`🔙 [TAB_STORE] Using custom history navigation to: ${url} (index ${newIndex})`)

      this.tabHistoryIndexes[tabId] = newIndex

      // Update tab's navigation state based on new position
      tab.canGoBack = newIndex > minNavigableIndex
      tab.canGoForward = newIndex < history.length - 1

      // Navigate to the URL
      tab.url = url
      tab.title = entry.title || url

      this.pendingHistoryJumps.set(tabId, 2)
      try {
        if (url === kNEW_TAB_URL) {
          // Navigate to new tab page
          tab.webviewRef.current.injectJavaScript(`window.location.href = "about:blank";`)
        } else {
          tab.webviewRef.current.injectJavaScript(`window.location.href = "${url}";`)
        }
        console.log(`🔙 [TAB_STORE] Successfully navigated to: ${url}`)
      } catch (error) {
        console.error(`🔙 [TAB_STORE] Error navigating to ${url}:`, error)
      }

      this.saveTabs()
    } else if (tab.canGoBack) {
      // Fall back to WebView's native goBack for regular navigation
      console.log(`🔙 [TAB_STORE] Using WebView native goBack()`)
      try {
        tab.webviewRef.current.goBack()
        console.log(`🔙 [TAB_STORE] Successfully called WebView goBack()`)
      } catch (error) {
        console.error(`🔙 [TAB_STORE] Error calling WebView goBack():`, error)
      }
    } else {
      console.log(`🔙 [TAB_STORE] Cannot go back:`, {
        hasTab: !!tab,
        canGoBack: tab?.canGoBack || false,
        hasWebViewRef: !!tab?.webviewRef?.current,
        historyLength: history.length,
        currentIndex: currentIndex
      })
    }
  }

  goForward(tabId: number) {
    const tab = this.tabs.find(t => t.id === tabId)
    console.log(`🔜 [TAB_STORE] goForward(): tabId=${tabId}`)

    if (!tab) {
      console.log(`🔜 [TAB_STORE] Tab ${tabId} not found`)
      return
    }

    const history = this.tabNavigationHistories[tabId] || []
    const currentIndex = this.tabHistoryIndexes[tabId] ?? -1

    console.log(`🔜 [TAB_STORE] Navigation state:`, {
      historyLength: history.length,
      currentIndex,
      canGoForward: tab.canGoForward,
      currentUrl: tab.url,
      history: history.map((h, i) => `${i === currentIndex ? '→' : ' '} ${h.url}`)
    })

    // Use custom history navigation if we have meaningful history
    if (history.length > 1 && currentIndex < history.length - 1) {
      console.log(`🔜 [TAB_STORE] Using custom history navigation`)
      const newIndex = currentIndex + 1
      const entry = history[newIndex]
      const url = entry.url

      console.log(`🔜 [TAB_STORE] Navigating forward to index ${newIndex}: ${url}`)

      // Update history index
      this.tabHistoryIndexes[tabId] = newIndex

      // The first entry is always the new-tab sentinel; never count it as a navigable back target.
      const minNavigableIndex = history.length > 0 && history[0]?.url === kNEW_TAB_URL ? 1 : 0

      // Update tab's navigation state based on new position
      tab.canGoBack = newIndex > minNavigableIndex
      tab.canGoForward = newIndex < history.length - 1

      // Navigate to the URL
      tab.url = url

      this.pendingHistoryJumps.set(tabId, 2)
      try {
        tab.webviewRef.current?.injectJavaScript(`window.location.href = "${url}";`)
      } catch (error) {
        console.error(`🔜 [TAB_STORE] Error navigating forward to ${url}:`, error)
      }

      console.log(
        `🔜 [TAB_STORE] Updated navigation state: canGoBack=${tab.canGoBack}, canGoForward=${tab.canGoForward}`
      )
    } else if (tab.canGoForward && tab.webviewRef.current) {
      // Fall back to WebView's native goForward() for single-page scenarios
      console.log(`🔜 [TAB_STORE] Using WebView native goForward()`)
      try {
        tab.webviewRef.current.goForward()
        console.log(`🔜 [TAB_STORE] Successfully called WebView goForward()`)
      } catch (error) {
        console.error(`🔜 [TAB_STORE] Error calling WebView goForward():`, error)
      }
    } else {
      console.log(`🔜 [TAB_STORE] Cannot go forward:`, {
        hasTab: !!tab,
        canGoForward: tab.canGoForward,
        hasWebViewRef: !!tab.webviewRef?.current,
        historyLength: history.length,
        currentIndex
      })
    }
  }

  /** Returns the navigation history and current index for a given tab (used by HistoryPopover). */
  getNavigationHistory(tabId: number): { entries: { url: string; title: string }[]; currentIndex: number } {
    return {
      entries: this.tabNavigationHistories[tabId] || [],
      currentIndex: this.tabHistoryIndexes[tabId] ?? -1
    }
  }

  /** Jump directly to a specific index in the tab's navigation history. */
  navigateToHistoryIndex(tabId: number, index: number) {
    const tab = this.tabs.find(t => t.id === tabId)
    const history = this.tabNavigationHistories[tabId] || []

    if (!tab || !tab.webviewRef.current || index < 0 || index >= history.length) {
      console.log(`🎯 [TAB_STORE] navigateToHistoryIndex(): invalid state`, {
        tabId,
        index,
        historyLength: history.length
      })
      return
    }

    const entry = history[index]
    const url = entry.url

    console.log(`🎯 [TAB_STORE] navigateToHistoryIndex(): tabId=${tabId}, index=${index}, url=${url}`)

    this.tabHistoryIndexes[tabId] = index
    tab.canGoBack = index > 0
    tab.canGoForward = index < history.length - 1
    tab.url = url
    tab.title = entry.title || url

    this.pendingHistoryJumps.set(tabId, 2)
    try {
      if (url === kNEW_TAB_URL) {
        tab.webviewRef.current.injectJavaScript(`window.location.href = "about:blank";`)
      } else {
        tab.webviewRef.current.injectJavaScript(`window.location.href = "${url}";`)
      }
    } catch (error) {
      console.error(`🎯 [TAB_STORE] Error navigating to history index ${index}:`, error)
    }

    this.saveTabs()
  }

  toggleDesktopMode(tabId: number) {
    const tab = this.tabs.find(t => t.id === tabId)
    if (tab) {
      tab.isDesktopMode = !tab.isDesktopMode
      this.saveTabs()
    }
  }

  closeTab = (id: number) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
    const tabIndex = this.tabs.findIndex(t => t.id === id)
    if (tabIndex === -1) return
    const tab = this.tabs[tabIndex]
    if (tab.webviewRef?.current) {
      // Add cleanup before removing tab
      tab.webviewRef.current.stopLoading()
      tab.webviewRef.current.clearCache?.(true)
      tab.webviewRef.current.clearHistory?.()
    }
    deleteThumbnail(id)

    delete this.tabNavigationHistories[id]
    delete this.tabHistoryIndexes[id]
    this.tabs.splice(tabIndex, 1)

    if (this.tabs.length === 0) {
      this.newTab()
      return
    }

    // If we're closing the active tab, switch to another tab
    if (this.activeTabId === id) {
      const newActiveTab = this.tabs[Math.max(tabIndex - 1, 0)]
      this.setActiveTab(newActiveTab.id)
    }

    this.saveTabs()
  }

  handleNavigationStateChange(tabId: number, navState: WebViewNavigation) {
    const tab = this.tabs.find(t => t.id === tabId)

    if (!tab) {
      console.log(`handleNavigationStateChange(): Tab ${tabId} not found, skipping`)
      return
    }

    // Always update loading state
    tab.isLoading = navState.loading

    // Note: Navigation state will be calculated after history updates to ensure accuracy

    // Only update URL and history when navigation completes and we have a valid URL
    const rawUrl = navState.url || kNEW_TAB_URL
    // Normalize the URL to strip transient challenge parameters (e.g. Cloudflare __cf_chl_tk)
    // that would otherwise cause redirect loops to be treated as distinct navigations.
    const currentUrl = normalizeUrlForHistory(rawUrl)

    if (!navState.loading && currentUrl && isValidUrl(currentUrl)) {
      // Countdown-based jump detection: each programmatic navigation sets the count to 2
      // because both onNavigationStateChange and onLoadEnd fire handleNavigationStateChange
      // with loading=false for the same event.  Decrementing on each loading=false call
      // ensures both are suppressed without letting a stale token block a future organic
      // navigation.
      const jumpCount = this.pendingHistoryJumps.get(tabId) ?? 0
      const isJump = jumpCount > 0
      if (isJump) {
        const remaining = jumpCount - 1
        if (remaining <= 0) {
          this.pendingHistoryJumps.delete(tabId)
        } else {
          this.pendingHistoryJumps.set(tabId, remaining)
        }
      }

      const history = this.tabNavigationHistories[tabId] || []
      const currentIndex = this.tabHistoryIndexes[tabId] ?? -1

      // Update tab.url to whatever the WebView actually landed on (handles redirects etc.)
      if (currentUrl !== tab.url) {
        tab.url = currentUrl
      }

      // Always update the title on the current history entry when a real title arrives.
      // We intentionally do NOT write navState.title when first creating an entry (done
      // in updateTab/goBack/goForward/navigateToHistoryIndex with the URL as placeholder)
      // because the first navState event after a URL change still carries the *previous*
      // page's title. Title correction happens here, safely, once the page has settled.
      const freshTitle = navState.title?.trim() || ''
      if (freshTitle) {
        tab.title = freshTitle
        // Also update the history entry for the current position
        if (history[currentIndex]) {
          history[currentIndex].title = freshTitle
        }
      }

      // If this was a programmatic jump (goBack / goForward / navigateToHistoryIndex /
      // updateTab URL change), the history entry is already recorded — skip append logic.
      if (!isJump && currentUrl !== 'about:blank') {
        if (currentUrl !== history[currentIndex]?.url) {
          // Genuine new navigation — append to history, truncating any forward stack.
          if (currentUrl === kNEW_TAB_URL) {
            const newTabIndex = history.findIndex(e => e.url === kNEW_TAB_URL)
            if (newTabIndex >= 0) {
              this.tabHistoryIndexes[tabId] = newTabIndex
            } else {
              history.unshift({ url: kNEW_TAB_URL, title: 'New Tab' })
              this.tabHistoryIndexes[tabId] = 0
            }
          } else {
            // Use URL as placeholder title — it will be corrected above on the next event
            // once the page has set its <title>.
            const newHistory =
              currentIndex >= 0 ? history.slice(0, currentIndex + 1) : [{ url: kNEW_TAB_URL, title: 'New Tab' }]
            newHistory.push({ url: currentUrl, title: currentUrl })
            this.tabNavigationHistories[tabId] = newHistory
            this.tabHistoryIndexes[tabId] = newHistory.length - 1
          }
        }
      }

      this.saveTabs()
    }

    // HYBRID APPROACH: Calculate navigation state after history updates
    // This ensures canGoBack/canGoForward reflect the current history state
    const finalHistory = this.tabNavigationHistories[tabId] || []
    const finalCurrentIndex = this.tabHistoryIndexes[tabId] ?? -1

    // Use custom history logic if we have meaningful history (more than just current page)
    // Otherwise fall back to WebView's native state.
    // The first history entry is always kNEW_TAB_URL (about:blank), which acts as a sentinel —
    // we never navigate back to it, so the minimum navigable index is 1 in that case.
    const finalMinNavigableIndex = finalHistory.length > 0 && finalHistory[0]?.url === kNEW_TAB_URL ? 1 : 0
    if (finalHistory.length > 1) {
      tab.canGoBack = finalCurrentIndex > finalMinNavigableIndex
      tab.canGoForward = finalCurrentIndex < finalHistory.length - 1
      console.log(
        `🔄 Using custom navigation state: canGoBack=${tab.canGoBack}, canGoForward=${tab.canGoForward}, historyIndex=${finalCurrentIndex}/${finalHistory.length - 1}`
      )
    } else {
      // Fall back to WebView's native state for single-page scenarios
      tab.canGoBack = navState.canGoBack
      tab.canGoForward = navState.canGoForward
    }
  }

  async clearAllTabs() {
    console.log('clearAllTabs() called')
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
    this.nextId = 1
    const tabIds = this.tabs.map(t => t.id)
    tabIds.forEach(id => this.closeTab(id))
    this.saveTabs()
  }

  // Initialize with mock tabs for testing
  initializeWithMockTabs(count: number = 6) {
    console.log(`Initializing with ${count} mock tabs`)

    // Clear existing tabs
    this.tabs = []
    this.tabNavigationHistories = {}
    this.tabHistoryIndexes = {}

    // Create blank tabs
    for (let i = 0; i < count; i++) {
      const mockTab = this.createTab() // Creates blank tab
      mockTab.title = `Tab ${i + 1}`
      this.tabs.push(mockTab)

      // Initialize empty navigation history for blank tabs
      this.tabNavigationHistories[mockTab.id] = []
      this.tabHistoryIndexes[mockTab.id] = -1
    }

    // Set first tab as active
    if (this.tabs.length > 0) {
      this.activeTabId = this.tabs[0].id
    }

    console.log(`${count} mock tabs created`)
    this.saveTabs()
  }

  async saveTabs() {
    const serializable = this.tabs.map(({ webviewRef, ...rest }) => rest)
    await AsyncStorage.multiSet([
      [STORAGE_KEYS.TABS, JSON.stringify(serializable)],
      [STORAGE_KEYS.ACTIVE, String(this.activeTabId)]
    ])
  }

  async loadTabs() {
    try {
      const [[, tabsJson], [, activeIdStr]] = await AsyncStorage.multiGet([STORAGE_KEYS.TABS, STORAGE_KEYS.ACTIVE])

      const parsed = tabsJson ? JSON.parse(tabsJson) : []
      const withRefs = parsed.map((t: any) => ({
        ...t,
        webviewRef: createRef<WebView>()
      }))

      runInAction(() => {
        // Reset navigation flags to false: tabNavigationHistories is in-memory only
        // and is not persisted, so stale canGoBack/canGoForward values from the previous
        // session would leave the back button enabled with no history behind it.
        this.tabs = withRefs.map((t: any) => ({ ...t, canGoBack: false, canGoForward: false }))
        const maxId = Math.max(0, ...withRefs.map((t: any) => t.id))
        this.nextId = maxId + 1

        const restored = Number(activeIdStr)
        this.activeTabId = this.tabs.some((t: any) => t.id === restored) ? restored : (this.tabs[0]?.id ?? 1)
      })
    } catch (e) {
      console.error('loadTabs failed', e)
      runInAction(() => {
        this.tabs = []
        this.activeTabId = 1
      })
    }
  }
}

const tabStore = new TabStore()
export default tabStore
