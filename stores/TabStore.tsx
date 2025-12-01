// stores/TabStore.tsx
import { createRef } from 'react'
import { makeAutoObservable, runInAction } from 'mobx'
import { WebView } from 'react-native-webview'
import { LayoutAnimation } from 'react-native'
import { Tab } from '@/shared/types/browser'
import { kNEW_TAB_URL } from '@/shared/constants'
import { isValidUrl } from '@/utils/generalHelpers'
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { WebViewNavigation } from 'react-native-webview'
const STORAGE_KEYS = { TABS: 'tabs', ACTIVE: 'activeTabId' }

export class TabStore {
  tabs: Tab[] = [] // Always initialize as an array
  activeTabId = 1
  showTabsView = false
  isInitialized = false // Add initialization flag
  private nextId = 1
  private tabNavigationHistories: { [tabId: number]: string[] } = {} // Track navigation history per tab
  private tabHistoryIndexes: { [tabId: number]: number } = {} // Track current position in history per tab
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
      isLoading: false
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
      this.tabNavigationHistories[newTab.id] = [kNEW_TAB_URL, safeInitialUrl]
      this.tabHistoryIndexes[newTab.id] = 1 // Currently on the initial URL
    } else {
      // For new tabs, start with new tab page in history
      this.tabNavigationHistories[newTab.id] = [kNEW_TAB_URL]
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

      // Log significant updates for debugging
      if ('url' in patch && patch.url !== tab.url) {
        console.log(`updateTab(): Updating tab ${id} URL from "${tab.url}" to "${patch.url}"`)
      }

      Object.assign(tab, patch)
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
    if (history.length > 1 && currentIndex > 0) {
      // Use custom history navigation for new tab page scenarios
      const newIndex = currentIndex - 1
      const url = history[newIndex]
      
      console.log(`🔙 [TAB_STORE] Using custom history navigation to: ${url} (index ${newIndex})`)
      
      this.tabHistoryIndexes[tabId] = newIndex
      
      // Update tab's navigation state based on new position
      tab.canGoBack = newIndex > 0
      tab.canGoForward = newIndex < history.length - 1
      
      // Navigate to the URL
      tab.url = url
      tab.title = url
      
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
      history: history.map((h, i) => `${i === currentIndex ? '→' : ' '} ${(h as any)?.url || h}`)
    })

    // Use custom history navigation if we have meaningful history
    if (history.length > 1 && currentIndex < history.length - 1) {
      console.log(`🔜 [TAB_STORE] Using custom history navigation`)
      const newIndex = currentIndex + 1
      const targetEntry = history[newIndex]
      const url = (targetEntry as any)?.url || targetEntry
      
      console.log(`🔜 [TAB_STORE] Navigating forward to index ${newIndex}: ${url}`)
      
      // Update history index
      this.tabHistoryIndexes[tabId] = newIndex
      
      // Update tab's navigation state based on new position
      tab.canGoBack = newIndex > 0
      tab.canGoForward = newIndex < history.length - 1
      
      // Navigate to the URL
      tab.url = url
      
      console.log(`🔜 [TAB_STORE] Updated navigation state: canGoBack=${tab.canGoBack}, canGoForward=${tab.canGoForward}`)
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
    const currentUrl = navState.url || kNEW_TAB_URL

    if (!navState.loading && currentUrl && isValidUrl(currentUrl)) {
      // Only update if URL actually changed
      if (currentUrl !== tab.url) {
        tab.url = currentUrl

        // Update title
        if (navState.title && navState.title.trim() !== '') {
          tab.title = navState.title
        } else {
          tab.title = currentUrl
        }

        // Add to history for real navigations (excluding about:blank but including new tab page)
        if (currentUrl !== 'about:blank') {
          const history = this.tabNavigationHistories[tabId] || []
          const currentIndex = this.tabHistoryIndexes[tabId] ?? -1

          // Check if this URL is already at our current position
          if (currentUrl !== history[currentIndex]) {
            console.log(`📝 Adding URL to history: ${currentUrl}`)
            
            // For new tab page, ensure it's always the first entry
            if (currentUrl === kNEW_TAB_URL) {
              // If navigating back to new tab page, update index but don't add duplicate
              const newTabIndex = history.indexOf(kNEW_TAB_URL)
              if (newTabIndex >= 0) {
                this.tabHistoryIndexes[tabId] = newTabIndex
              } else {
                // This shouldn't happen with our new initialization, but handle it gracefully
                history.unshift(kNEW_TAB_URL)
                this.tabHistoryIndexes[tabId] = 0
              }
            } else {
              // For regular URLs, remove any forward history and add the new URL
              const newHistory = currentIndex >= 0 ? history.slice(0, currentIndex + 1) : [kNEW_TAB_URL]
              newHistory.push(currentUrl)
              this.tabNavigationHistories[tabId] = newHistory
              this.tabHistoryIndexes[tabId] = newHistory.length - 1
            }

            console.log(
              `🧭 Navigation updated: canGoBack=${tab.canGoBack}, canGoForward=${tab.canGoForward}, historyIndex=${this.tabHistoryIndexes[tabId]}/${history.length - 1}`
            )
          }
        }

        this.saveTabs()
      }
    }

    // HYBRID APPROACH: Calculate navigation state after history updates
    // This ensures canGoBack/canGoForward reflect the current history state
    const finalHistory = this.tabNavigationHistories[tabId] || []
    const finalCurrentIndex = this.tabHistoryIndexes[tabId] ?? -1
    
    // Use custom history logic if we have meaningful history (more than just current page)
    // Otherwise fall back to WebView's native state
    if (finalHistory.length > 1) {
      tab.canGoBack = finalCurrentIndex > 0
      tab.canGoForward = finalCurrentIndex < finalHistory.length - 1
      console.log(`🔄 Using custom navigation state: canGoBack=${tab.canGoBack}, canGoForward=${tab.canGoForward}, historyIndex=${finalCurrentIndex}/${finalHistory.length - 1}`)
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
        this.tabs = withRefs
        const maxId = Math.max(0, ...withRefs.map((t: any) => t.id))
        this.nextId = maxId + 1

        const restored = Number(activeIdStr)
        this.activeTabId = withRefs.some((t: any) => t.id === restored) ? restored : (withRefs[0]?.id ?? 1)
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
