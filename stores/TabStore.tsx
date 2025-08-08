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

    // Initialize navigation history for new tab - only add valid URLs to history
    if (
      safeInitialUrl &&
      safeInitialUrl !== kNEW_TAB_URL &&
      safeInitialUrl !== 'about:blank' &&
      isValidUrl(safeInitialUrl)
    ) {
      this.tabNavigationHistories[newTab.id] = [safeInitialUrl]
      this.tabHistoryIndexes[newTab.id] = 0
    } else {
      // For new tabs with blank URLs, start with empty history
      this.tabNavigationHistories[newTab.id] = []
      this.tabHistoryIndexes[newTab.id] = -1
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
    const history = this.tabNavigationHistories[tabId]
    const currentIndex = this.tabHistoryIndexes[tabId]

    console.log(
      `🔙 [TAB_STORE] goBack(): tabId=${tabId}, currentIndex=${currentIndex}, history=${history?.length} items`
    )

    // Log detailed webView ref information
    console.log(`🔙 [TAB_STORE] WebView ref details for tab ${tabId}:`, {
      hasTab: !!tab,
      hasWebViewRef: !!tab?.webviewRef,
      webViewRefCurrent: !!tab?.webviewRef?.current,
      webViewRefType: typeof tab?.webviewRef?.current,
      webViewMethods: tab?.webviewRef?.current ? Object.getOwnPropertyNames(tab.webviewRef.current) : []
    })

    if (tab && history && currentIndex > 0) {
      const newIndex = currentIndex - 1
      const url = history[newIndex]

      console.log(`🔙 [TAB_STORE] Going back to: ${url} (index ${newIndex})`)

      this.tabHistoryIndexes[tabId] = newIndex

      // Update tab's canGoBack/canGoForward based on new position
      tab.canGoBack = newIndex > 0
      tab.canGoForward = newIndex < history.length - 1

      // Update tab URL and navigate the WebView
      tab.url = url
      tab.title = url

      // Navigate the WebView to the URL
      if (tab.webviewRef.current) {
        console.log(`🔙 [TAB_STORE] Injecting JavaScript navigation to: ${url}`)
        try {
          tab.webviewRef.current.injectJavaScript(`window.location.href = "${url}";`)
        } catch (error) {
          console.error(`🔙 [TAB_STORE] Error injecting JavaScript:`, error)
        }
      } else {
        console.warn(`🔙 [TAB_STORE] Cannot navigate - WebView ref not available`)
      }

      console.log(
        `🔙 [TAB_STORE] Updated tab ${tabId} to URL: ${url}, canGoBack: ${tab.canGoBack}, canGoForward: ${tab.canGoForward}`
      )

      this.saveTabs()
    } else {
      console.log(
        `🔙 [TAB_STORE] Cannot go back: tab=${!!tab}, history=${history?.length}, currentIndex=${currentIndex}`
      )
    }
  }

  goForward(tabId: number) {
    const tab = this.tabs.find(t => t.id === tabId)
    const history = this.tabNavigationHistories[tabId]
    const currentIndex = this.tabHistoryIndexes[tabId]

    console.log(`goForward(): tabId=${tabId}, currentIndex=${currentIndex}, history=${history?.length} items`)

    if (tab && history && currentIndex < history.length - 1) {
      const newIndex = currentIndex + 1
      const url = history[newIndex]

      console.log(`🔜 Going forward to: ${url} (index ${newIndex})`)

      this.tabHistoryIndexes[tabId] = newIndex

      // Update tab's canGoBack/canGoForward based on new position
      tab.canGoBack = newIndex > 0
      tab.canGoForward = newIndex < history.length - 1

      // Update tab URL and navigate the WebView
      tab.url = url
      tab.title = url

      // Navigate the WebView to the URL
      if (tab.webviewRef.current) {
        tab.webviewRef.current.injectJavaScript(`window.location.href = "${url}";`)
      }

      console.log(
        `🔜 Updated tab ${tabId} to URL: ${url}, canGoBack: ${tab.canGoBack}, canGoForward: ${tab.canGoForward}`
      )

      this.saveTabs()
    } else {
      console.log(`Cannot go forward: tab=${!!tab}, history=${history?.length}, currentIndex=${currentIndex}`)
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

    console.log(`handleNavigationStateChange(): tabId=${tabId}, url=${navState.url}, loading=${navState.loading}`)

    if (!tab) {
      console.log(`handleNavigationStateChange(): Tab ${tabId} not found, skipping`)
      return
    }

    // Always update loading state
    tab.isLoading = navState.loading

    // Only update URL and history when navigation completes and we have a valid URL
    const currentUrl = navState.url || kNEW_TAB_URL

    if (!navState.loading && currentUrl && isValidUrl(currentUrl)) {
      // Only update if URL actually changed
      if (currentUrl !== tab.url) {
        console.log(`handleNavigationStateChange(): URL changed for tab ${tabId} from "${tab.url}" to "${currentUrl}"`)
        tab.url = currentUrl

        // Update title
        if (navState.title && navState.title.trim() !== '') {
          tab.title = navState.title
        } else {
          tab.title = currentUrl
        }

        // Only add to history if it's not about:blank and it's a real navigation
        if (currentUrl !== 'about:blank' && currentUrl !== kNEW_TAB_URL) {
          const history = this.tabNavigationHistories[tabId] || []
          const currentIndex = this.tabHistoryIndexes[tabId] ?? -1

          // Check if this URL is already at our current position
          if (currentUrl !== history[currentIndex]) {
            console.log(`📝 Adding new URL to history: ${currentUrl}`)
            // Remove any forward history and add the new URL
            const newHistory = currentIndex >= 0 ? history.slice(0, currentIndex + 1) : []
            newHistory.push(currentUrl)
            this.tabNavigationHistories[tabId] = newHistory
            this.tabHistoryIndexes[tabId] = newHistory.length - 1

            // Update navigation capabilities based on our history
            const newIndex = this.tabHistoryIndexes[tabId]
            tab.canGoBack = newIndex > 0
            tab.canGoForward = false // Always false since we just added the latest

            console.log(
              `🧭 Navigation updated: canGoBack=${tab.canGoBack}, canGoForward=${tab.canGoForward}, historyIndex=${newIndex}/${newHistory.length - 1}`
            )
          }
        }

        this.saveTabs()
      }
    }

    console.log(`handleNavigationStateChange(): Final tab state:`, {
      id: tab.id,
      url: tab.url,
      title: tab.title,
      isLoading: tab.isLoading,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward
    })
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
