// stores/TabStore.tsx
import { createRef } from 'react'
import { makeAutoObservable } from 'mobx'
import { WebView } from 'react-native-webview'
import { LayoutAnimation } from 'react-native'
import { Tab } from '@/shared/types/browser'
import { kNEW_TAB_URL } from '@/shared/constants'
import { isValidUrl } from '@/utils/generalHelpers'
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { WebViewNavigation } from 'react-native-webview'
export class TabStore {
  tabs: Tab[] = [] // Always initialize as an array
  activeTabId = 1
  showTabsView = false
  // True while a tab switch is waiting for the target page's first paint.
  // Drives a full-screen loading overlay so the previous tab's content is
  // never visible after the user taps a different tab.
  switchLoading = false
  private nextId = 1
  private isSwitchingTabs = false
  private switchLoadingTimeout: ReturnType<typeof setTimeout> | null = null
  private tabNavigationHistories: { [tabId: number]: string[] } = {} // Track navigation history per tab
  private tabHistoryIndexes: { [tabId: number]: number } = {} // Track current position in history per tab

  constructor() {
    console.log('TabStore constructor called')
    makeAutoObservable(this)
    // Preserve existing tabs during hot reload
    if (this.tabs.length === 0) {
      this.loadTabs().catch(console.error)
    }

    // Ensure we always have at least one tab after construction
    setTimeout(() => {
      if (this.tabs.length === 0) {
        this.newTab()
      }
    }, 0)
  }

  createTab(url: string = kNEW_TAB_URL): Tab {
    console.log(`createTab(): url=${url}, tabid=${this.nextId + 1}`)
    const safeUrl = isValidUrl(url) ? url : kNEW_TAB_URL
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

  newTab = (initialUrl: string = kNEW_TAB_URL) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
    const newTab = this.createTab(initialUrl)
    this.tabs.push(newTab)
    this.activeTabId = newTab.id

    // Initialize navigation history for new tab - only add valid URLs to history
    if (initialUrl && initialUrl !== kNEW_TAB_URL && initialUrl !== 'about:blank' && isValidUrl(initialUrl)) {
      this.tabNavigationHistories[newTab.id] = [initialUrl]
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
      this.activeTabId = this.tabs[0].id
      return this.tabs[0]
    }

    // If no tabs at all, create one
    if (!tab && this.tabs.length === 0) {
      this.newTab()
      return this.tabs[0] || null
    }

    return tab || null
  }

  setActiveTab(id: number) {
    const tab = this.tabs.find(t => t.id === id)
    if (tab) {
      const isSameTab = id === this.activeTabId
      this.isSwitchingTabs = true
      this.activeTabId = id

      // Show the loading overlay immediately (same MobX commit as the active
      // tab change) for real web pages so the old page never flashes. Homepage
      // (kNEW_TAB_URL) renders natively with no WebView load event, so skip it.
      const targetIsWebPage = tab.url !== kNEW_TAB_URL && tab.url.startsWith('http')
      this.switchLoading = !isSameTab && targetIsWebPage

      // Safety net: clear the overlay even if no load event fires.
      if (this.switchLoadingTimeout) clearTimeout(this.switchLoadingTimeout)
      if (this.switchLoading) {
        this.switchLoadingTimeout = setTimeout(() => this.clearSwitchLoading(), 8000)
      }

      setTimeout(() => {
        this.isSwitchingTabs = false
      }, 100) // Reduced timeout
    }
  }

  clearSwitchLoading() {
    if (this.switchLoadingTimeout) {
      clearTimeout(this.switchLoadingTimeout)
      this.switchLoadingTimeout = null
    }
    this.switchLoading = false
  }

  setShowTabsView(show: boolean) {
    this.showTabsView = show
  }

  updateTab(id: number, patch: Partial<Tab>) {
    const tab = this.tabs.find(t => t.id === id)
    if (tab) {
      const newUrl = patch.url
      if (newUrl && !isValidUrl(newUrl)) {
        patch.url = kNEW_TAB_URL
      }
      Object.assign(tab, patch)
      this.saveTabs()
    }
  }

  goBack(tabId: number) {
    const tab = this.tabs.find(t => t.id === tabId)
    const history = this.tabNavigationHistories[tabId]
    const currentIndex = this.tabHistoryIndexes[tabId]
    console.log(
      `goBack(): tabId=${tabId}, currentIndex=${currentIndex}, history=${history?.length} items, canGoBack=${tab?.canGoBack}`
    )

    if (tab && history && currentIndex > 0) {
      const newIndex = currentIndex - 1
      const url = history[newIndex]

      console.log(`🔙 Going back to: ${url} (index ${newIndex})`)

      this.tabHistoryIndexes[tabId] = newIndex

      // Update tab's canGoBack/canGoForward based on new position
      tab.canGoBack = newIndex > 0
      tab.canGoForward = newIndex < history.length - 1

      // Navigate WebView to the URL
      if (tab.webviewRef.current) {
        tab.webviewRef.current.injectJavaScript(`window.location.href = "${url}";`)
      }
    } else {
      console.log(`Cannot go back: tab=${!!tab}, history=${history?.length}, currentIndex=${currentIndex}`)
    }
  }

  goForward(tabId: number) {
    const tab = this.tabs.find(t => t.id === tabId)
    const history = this.tabNavigationHistories[tabId]
    const currentIndex = this.tabHistoryIndexes[tabId]
    console.log(
      `goForward(): tabId=${tabId}, currentIndex=${currentIndex}, history=${history?.length} items, canGoForward=${tab?.canGoForward}`
    )

    if (tab && history && currentIndex < history.length - 1) {
      const newIndex = currentIndex + 1
      const url = history[newIndex]

      console.log(`🔜 Going forward to: ${url} (index ${newIndex})`)

      this.tabHistoryIndexes[tabId] = newIndex

      // Update tab's canGoBack/canGoForward based on new position
      tab.canGoBack = newIndex > 0
      tab.canGoForward = newIndex < history.length - 1

      // Navigate WebView to the URL
      if (tab.webviewRef.current) {
        tab.webviewRef.current.injectJavaScript(`window.location.href = "${url}";`)
      }
    } else {
      console.log(`Cannot go forward: tab=${!!tab}, history=${history?.length}, currentIndex=${currentIndex}`)
    }
  }

  closeTab = (id: number) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
    const tabIndex = this.tabs.findIndex(t => t.id === id)
    if (tabIndex === -1) return

    this.tabs.splice(tabIndex, 1)

    // Clear navigation history for closed tab
    delete this.tabNavigationHistories[id]
    delete this.tabHistoryIndexes[id]

    if (this.tabs.length === 0) {
      this.newTab()
      return
    }

    if (this.activeTabId === id) {
      this.activeTabId = this.tabs[Math.max(tabIndex - 1, 0)].id
    }
    this.saveTabs()
  }

  handleNavigationStateChange(tabId: number, navState: WebViewNavigation) {
    const tab = this.tabs.find(t => t.id === tabId)

    // Only process navigation events for the currently active tab
    if (!tab || tabId !== this.activeTabId || this.isSwitchingTabs) {
      return
    }

    console.log(
      `handleNavigationStateChange(): tabId=${tabId}, url=${navState.url}, webview_canGoBack=${navState.canGoBack}, webview_canGoForward=${navState.canGoForward}`
    )

    // Always update loading state and basic tab info
    tab.isLoading = navState.loading
    tab.url = navState.url
    tab.title = navState.title || navState.url

    // Only update navigation state and history when navigation completes
    // and exclude about:blank URLs from history
    if (
      !navState.loading &&
      navState.url &&
      navState.url !== 'about:blank' &&
      navState.url !== kNEW_TAB_URL &&
      isValidUrl(navState.url)
    ) {
      const history = this.tabNavigationHistories[tabId] || []
      const currentIndex = this.tabHistoryIndexes[tabId] ?? -1

      // Check if this URL is already in our history at the current position
      if (navState.url !== history[currentIndex]) {
        // Check if this is a back/forward navigation within our tracked history
        const urlIndex = history.indexOf(navState.url)

        if (urlIndex !== -1) {
          // This is back/forward navigation - update index
          console.log(`📍 Found URL in history at index ${urlIndex}, updating position`)
          this.tabHistoryIndexes[tabId] = urlIndex
        } else {
          // This is new navigation - add to history
          console.log(`📝 Adding new URL to history: ${navState.url}`)
          const newHistory = currentIndex >= 0 ? history.slice(0, currentIndex + 1) : []
          newHistory.push(navState.url)
          this.tabNavigationHistories[tabId] = newHistory
          this.tabHistoryIndexes[tabId] = newHistory.length - 1
        }
      }

      // Update tab's canGoBack/canGoForward based on our tracked history
      const currentHistory = this.tabNavigationHistories[tabId] || []
      const currentIdx = this.tabHistoryIndexes[tabId] ?? -1

      const prevCanGoBack = tab.canGoBack
      const prevCanGoForward = tab.canGoForward

      tab.canGoBack = currentIdx > 0
      tab.canGoForward = currentIdx < currentHistory.length - 1

      console.log(
        `🧭 Navigation state: canGoBack=${tab.canGoBack}, canGoForward=${tab.canGoForward}, historyIndex=${currentIdx}/${currentHistory.length - 1}`
      )

      // Log state changes
      if (prevCanGoBack !== tab.canGoBack || prevCanGoForward !== tab.canGoForward) {
        console.log(
          `🔄 Navigation state changed: canGoBack: ${prevCanGoBack} → ${tab.canGoBack}, canGoForward: ${prevCanGoForward} → ${tab.canGoForward}`
        )
      }

      this.saveTabs()
    }
  }

  async saveTabs() {
    if (!this.tabs) this.tabs = [] // Prevent undefined
    const serializableTabs = this.tabs.map(({ webviewRef, ...rest }) => rest)
    await AsyncStorage.setItem('tabs', JSON.stringify(serializableTabs)).catch(console.error)
  }

  async loadTabs() {
    const savedTabs = await AsyncStorage.getItem('tabs')
    if (savedTabs) {
      const parsedTabs = JSON.parse(savedTabs).map((tab: any) => ({
        ...tab,
        webviewRef: createRef<WebView>()
      }))
      this.tabs = parsedTabs

      // Update nextId to be higher than any existing tab id
      const maxId = Math.max(...parsedTabs.map((t: Tab) => t.id), 0)
      this.nextId = maxId + 1

      // Ensure activeTabId points to a valid tab
      if (parsedTabs.length > 0) {
        const activeTabExists = parsedTabs.some((t: Tab) => t.id === this.activeTabId)
        if (!activeTabExists) {
          this.activeTabId = parsedTabs[0].id
        }
      }
    } else {
      // No saved tabs, create initial tab
      this.tabs = []
      this.newTab() // This will create a tab and set it as active
    }
  }
}

const tabStore = new TabStore()
export default tabStore
