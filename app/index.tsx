 
import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import {
  Animated,
  Dimensions,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  FlatList,
  Keyboard,
  TouchableWithoutFeedback,
  KeyboardAvoidingView,
  ScrollView,
  Modal as RNModal,
  BackHandler,
  InteractionManager,
  ActivityIndicator
} from 'react-native'
import { StatusBar } from 'expo-status-bar'
import * as Haptics from 'expo-haptics'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { WebView, WebViewMessageEvent, WebViewNavigation } from 'react-native-webview'
import {
  GestureHandlerRootView,
  Swipeable,
  PanGestureHandler,
  State as GestureState
} from 'react-native-gesture-handler'
import { TabView, SceneMap } from 'react-native-tab-view'
import Fuse from 'fuse.js'
import { Ionicons } from '@expo/vector-icons'
import { observer } from 'mobx-react-lite'
import { router } from 'expo-router'

import { useTheme } from '@/context/theme/ThemeContext'
import { useWallet } from '@/context/WalletContext'
import { WalletInterface, LookupResolver, Transaction , Utils } from '@bsv/sdk'
import { RecommendedApps } from '@/components/RecommendedApps'
import { useLocalStorage } from '@/context/LocalStorageProvider'
import Balance from '@/components/Balance'
import type { Bookmark, HistoryEntry, Tab } from '@/shared/types/browser'
import { DEFAULT_HOMEPAGE_URL } from '@/shared/constants'
import { HistoryList } from '@/components/HistoryList'
import { isValidUrl } from '@/utils/generalHelpers'
import tabStore from '../stores/TabStore'
import bookmarkStore from '@/stores/BookmarkStore'
import SettingsScreen from './settings'
import IdentityScreen from './identity'
import { useTranslation } from 'react-i18next'
import { useBrowserMode } from '@/context/BrowserModeContext'
import TrustScreen from './trust'
/* -------------------------------------------------------------------------- */
/*                                   HELPERS                                   */
/* -------------------------------------------------------------------------- */

// Removed: getPendingUrl, clearPendingUrl - no longer needed with direct navigation
import { useWebAppManifest } from '@/hooks/useWebAppManifest'
import { buildInjectedJavaScript } from '@/utils/webview/injectedPolyfills'
import PermissionModal from '@/components/PermissionModal'
import PermissionsScreen from '@/components/PermissionsScreen'
import BottomDrawer from '@/components/BottomDrawer'
import {
  PermissionType,
  PermissionState,
  getDomainPermissions,
  setDomainPermission,
  getPermissionState,
  checkPermissionForDomain
} from '@/utils/permissionsManager'
import { getPermissionScript } from '@/utils/permissionScript'
import { createWebViewMessageRouter } from '@/utils/webview/messageRouter'

/* -------------------------------------------------------------------------- */
/*                                   CONSTS                                   */
/* -------------------------------------------------------------------------- */

const kNEW_TAB_URL = 'about:blank'
const HISTORY_KEY = 'history'

function getInjectableJSMessage(message: any = {}) {
  const messageString = JSON.stringify(message)
  return `
    (function() {
      window.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify(${messageString})
      }));
    })();
  `
}

/* -------------------------------------------------------------------------- */
/*                                 COMPONENTS                                 */
/* -------------------------------------------------------------------------- */
function StarDrawer({
  BookmarksScene,
  HistoryScene,
  colors,
  styles,
  index,
  setIndex
}: {
  BookmarksScene: React.ComponentType
  HistoryScene: React.ComponentType
  colors: any
  styles: any
  index: number
  setIndex: (index: number) => void
}) {
  const { t } = useTranslation()
  const routes = useMemo(
    () => [
      { key: 'bookmarks', title: t('bookmarks') },
      { key: 'history', title: t('history') }
    ],
    [t]
  )
  const renderScene = useMemo(
    () =>
      SceneMap({
        bookmarks: BookmarksScene,
        history: HistoryScene
      }),
    [BookmarksScene, HistoryScene]
  )
  return (
    <View style={{ flex: 1 }}>
      <TabView
        navigationState={{ index, routes }}
        onIndexChange={setIndex}
        renderScene={renderScene}
        lazy={false}
        renderTabBar={props => (
          <View style={styles.starTabBar}>
            {props.navigationState.routes.map((r, i) => (
              <TouchableOpacity
                key={r.key}
                style={[styles.starTab, i === index && { borderBottomColor: colors.primary }]}
                onPress={() => setIndex(i)}
              >
                <Text
                  style={[
                    styles.starTabLabel,
                    {
                      color: i === index ? colors.primary : colors.textSecondary
                    }
                  ]}
                >
                  {r.title}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      />
    </View>
  )
}

/* -------------------------------------------------------------------------- */
/*                                  BROWSER                                   */
/* -------------------------------------------------------------------------- */

function Browser() {
  /* --------------------------- theme / basic hooks -------------------------- */
  const { colors, isDark } = useTheme()
  const insets = useSafeAreaInsets()
  const { t, i18n } = useTranslation()
  const { isWeb2Mode } = useBrowserMode()
  useEffect(() => {
    // hydrate from AsyncStorage once
    tabStore.initializeTabs()
  }, [])

  /* ----------------------------- language headers ----------------------------- */
  // Map i18n language codes to proper HTTP Accept-Language header values
  const getAcceptLanguageHeader = useCallback(() => {
    const languageMap: Record<string, string> = {
      en: 'en-US,en;q=0.9',
      zh: 'zh-CN,zh;q=0.9,en;q=0.8',
      es: 'es-ES,es;q=0.9,en;q=0.8',
      hi: 'hi-IN,hi;q=0.9,en;q=0.8',
      fr: 'fr-FR,fr;q=0.9,en;q=0.8',
      ar: 'ar-SA,ar;q=0.9,en;q=0.8',
      pt: 'pt-BR,pt;q=0.9,en;q=0.8',
      bn: 'bn-BD,bn;q=0.9,en;q=0.8',
      ru: 'ru-RU,ru;q=0.9,en;q=0.8',
      id: 'id-ID,id;q=0.9,en;q=0.8'
    }

    const currentLanguage = i18n.language || 'en'
    return languageMap[currentLanguage] || 'en-US,en;q=0.9'
  }, [i18n.language])

  /* ----------------------------- wallet context ----------------------------- */
  const { managers } = useWallet()
  const [wallet, setWallet] = useState<WalletInterface | undefined>()
  useEffect(() => {
    // Only initialize wallet if not in web2 mode
    if (!isWeb2Mode && managers?.walletManager?.authenticated) {
      setWallet(managers.walletManager)
    } else if (isWeb2Mode) {
      setWallet(undefined)
    }
  }, [managers, isWeb2Mode])

  /* ---------------------------- storage helpers ----------------------------- */
  const { getItem, setItem } = useLocalStorage()

  /* -------------------------------- history -------------------------------- */
  const loadHistory = useCallback(async (): Promise<HistoryEntry[]> => {
    const raw = await getItem(HISTORY_KEY)
    const data = raw ? (JSON.parse(raw) as HistoryEntry[]) : []
    return data.map(h => ({
      ...h,
      url: isValidUrl(h.url) ? h.url : kNEW_TAB_URL
    }))
  }, [getItem])

  const [history, setHistory] = useState<HistoryEntry[]>([])
  useEffect(() => {
    loadHistory().then(setHistory)
  }, [loadHistory])

  const saveHistory = useCallback(
    async (list: HistoryEntry[]) => {
      setHistory(list)
      await setItem(HISTORY_KEY, JSON.stringify(list))
    },
    [setItem]
  )

  const pushHistory = useCallback(
    async (entry: HistoryEntry) => {
      if (history.length && history[0].url.replace(/\/$/, '') === entry.url.replace(/\/$/, '')) return
      const next = [entry, ...history].slice(0, 500)
      await saveHistory(next)
    },
    [history, saveHistory]
  )

  const removeHistoryItem = useCallback(
    async (url: string) => {
      const next = history.filter(h => h.url !== url)
      await saveHistory(next)
    },
    [history, saveHistory]
  )

  const clearHistory = useCallback(async () => {
    await saveHistory([])
  }, [saveHistory])

  /* -------------------------------- bookmarks ------------------------------- */
  const [removedDefaultApps, setRemovedDefaultApps] = useState<string[]>([])

  // Homepage URL (configurable in settings)
  const [homepageUrl, setHomepageUrlState] = useState(DEFAULT_HOMEPAGE_URL)

  // Homepage customization settings
  const [homepageSettings, setHomepageSettings] = useState({
    showBookmarks: true,
    showRecentApps: true,
    showRecommendedApps: true
  })

  // Load homepage settings and homepage URL from storage
  useEffect(() => {
    const loadHomepageSettings = async () => {
      try {
        const savedSettings = await getItem('homepageSettings')
        if (savedSettings) {
          const parsedSettings = JSON.parse(savedSettings)
          setHomepageSettings(prev => ({ ...prev, ...parsedSettings }))
        }
        const storedHomepage = await getItem('homepageUrl')
        if (storedHomepage) {
          setHomepageUrlState(storedHomepage)
        }
      } catch (error) {
        console.error('Error loading homepage settings:', error)
      }
    }
    loadHomepageSettings()
  }, [getItem])

  const updateHomepageSettings = useCallback(
    async (newSettings: Partial<typeof homepageSettings>) => {
      const updatedSettings = { ...homepageSettings, ...newSettings }
      setHomepageSettings(updatedSettings)
      try {
        await setItem('homepageSettings', JSON.stringify(updatedSettings))
      } catch (error) {
        console.error('Error saving homepage settings:', error)
      }
    },
    [homepageSettings, setItem]
  )


  const addBookmark = useCallback((title: string, url: string) => {
    // Only add bookmarks for valid URLs that aren't the new tab page
    if (url && url !== kNEW_TAB_URL && isValidUrl(url) && !url.includes('about:blank')) {
      bookmarkStore.addBookmark(title, url)
    }
  }, [])

  const removeBookmark = useCallback((url: string) => {
    bookmarkStore.removeBookmark(url)
  }, [])

  const removeDefaultApp = useCallback((url: string) => {
    setRemovedDefaultApps(prev => [...prev, url])
  }, [])

  /* ---------------------------------- tabs --------------------------------- */
  /* ---------------------------------- tabs --------------------------------- */
  const activeTab = tabStore.activeTab // Should never be null due to TabStore guarantees

  /* -------------------------- ui / animation state -------------------------- */
  const addressEditing = useRef(false)
  const [addressText, setAddressText] = useState(kNEW_TAB_URL)
  const [addressFocused, setAddressFocused] = useState(false)
  const [, setAddressBarHeight] = useState(0)

  const [keyboardVisible, setKeyboardVisible] = useState(false)
  const [, setKeyboardHeight] = useState(0)
  const iosSoftKeyboardShown = useRef(false)

  const [showInfoDrawer, setShowInfoDrawer] = useState(false)
  const [infoDrawerRoute, setInfoDrawerRoute] = useState<
    'root' | 'identity' | 'settings' | 'security' | 'trust' | 'permissions'
  >('root')

  const [showTabsView, setShowTabsView] = useState(false)
  const [showStarDrawer, setShowStarDrawer] = useState(false)
  const [starTabIndex, setStarTabIndex] = useState(0)
  const starDrawerAnim = useRef(new Animated.Value(0)).current
  const [isDesktopView, setIsDesktopView] = useState(false)
  const [isToggleDesktopCooldown, setIsToggleDesktopCooldown] = useState(false)

  const addressInputRef = useRef<TextInput>(null)
  const { fetchManifest, getStartUrl, shouldRedirectToStartUrl } = useWebAppManifest()
  const [isFullscreen, setIsFullscreen] = useState(false)
  const activeCameraStreams = useRef<Set<string>>(new Set())

  // Safety check - if somehow activeTab is null, force create a new tab
  // This is done after all hooks to avoid violating Rules of Hooks
  useEffect(() => {
    if (tabStore.isInitialized && !activeTab) {
      tabStore.newTab()
      Keyboard.dismiss()
      setAddressFocused(false)
    }
  }, [activeTab])

  // On first launch, navigate the initial tab to the homepage URL
  const hasSetHomepage = useRef(false)
  useEffect(() => {
    if (hasSetHomepage.current) return
    if (activeTab && (activeTab.url === kNEW_TAB_URL || activeTab.url === 'about:blank') && homepageUrl) {
      hasSetHomepage.current = true
      tabStore.updateTab(tabStore.activeTabId, { url: homepageUrl })
      setAddressText(homepageUrl)
    }
  }, [homepageUrl, activeTab, activeTab?.url])

  // Auto-focus address bar on new tab
  useEffect(() => {
    if (activeTab && activeTab.url === kNEW_TAB_URL && !addressFocused) {
      // Small delay to ensure rendering is complete
      setTimeout(() => {
        addressInputRef.current?.focus()
      }, 100)
    }
  }, [activeTab, activeTab?.id, activeTab?.url, addressFocused])

  const [permissionModalVisible, setPermissionModalVisible] = useState(false)

  // Pending permission request state (for generic PermissionModal)
  const [pendingPermission, setPendingPermission] = useState<PermissionType | null>(null)
  const [pendingDomain, setPendingDomain] = useState<string | null>(null)
  const [pendingCallback, setPendingCallback] = useState<((granted: boolean) => void) | null>(null)
  const [permissionsDeniedForCurrentDomain, setPermissionsDeniedForCurrentDomain] = useState<PermissionType[]>([])

  /* ------------------------------ keyboard hook ----------------------------- */
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'

    const showSub = Keyboard.addListener(showEvent, event => {
      setKeyboardVisible(true)
      const height = event.endCoordinates.height
      setKeyboardHeight(height)
      if (Platform.OS === 'ios') iosSoftKeyboardShown.current = true
    })
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardVisible(false)
      setKeyboardHeight(0)

      const shouldHandleHide = Platform.OS === 'ios' ? iosSoftKeyboardShown.current : true
      setTimeout(() => {
        if (shouldHandleHide && (addressEditing.current || addressInputRef.current?.isFocused())) {
          addressEditing.current = false
          setAddressFocused(false)
          setAddressSuggestions([])
          addressInputRef.current?.blur()
        }
        if (Platform.OS === 'ios') iosSoftKeyboardShown.current = false
      }, 50)
    })
    return () => {
      showSub.remove()
      hideSub.remove()
    }
  }, [])

  const updateActiveTab = useCallback(
    (patch: Partial<Tab>) => {
      const raw = patch.url?.trim()
      if (raw) {
        if (!isValidUrl(raw)) {
          // Try only adding https:// (no other fixes)
          const candidate =
            raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw.replace(/^\/+/, '')}`

          if (candidate !== raw && isValidUrl(candidate)) {
            patch.url = candidate
          } else if (raw !== kNEW_TAB_URL) {
            patch.url = kNEW_TAB_URL
          }
        }
      }

      tabStore.updateTab(tabStore.activeTabId, patch)
    },
    []
  )

  // Manifest checking useEffect
  useEffect(() => {
    if (!activeTab) return

    let isCancelled = false

    const handleManifest = async () => {
      if (activeTab.url === kNEW_TAB_URL || !activeTab.url.startsWith('http') || activeTab.isLoading) {
        return
      }

      if (isCancelled) return

      // console.log('Checking manifest for:', activeTab.url);

      try {
        const manifestData = await fetchManifest(activeTab.url)

        if (isCancelled) return

        if (manifestData) {
          // console.log('Found manifest for', activeTab.url, manifestData);

          if (manifestData.babbage?.protocolPermissions) {
            // console.log('Found Babbage protocol permissions:', manifestData.babbage.protocolPermissions);
          }

          const url = new URL(activeTab.url)
          if (shouldRedirectToStartUrl(manifestData, activeTab.url) && url.pathname === '/') {
            const startUrl = getStartUrl(manifestData, activeTab.url)
            // console.log('Redirecting to start_url:', startUrl);
            updateActiveTab({ url: startUrl })
            setAddressText(startUrl)
          }
        }
      } catch (error) {
        console.error('Error in manifest handling:', error)
      }
    }

    const timeoutId = setTimeout(() => {
      if (activeTab && !activeTab.isLoading && activeTab.url !== kNEW_TAB_URL && activeTab.url.startsWith('http')) {
        handleManifest()
      }
    }, 1000)

    return () => {
      isCancelled = true
      clearTimeout(timeoutId)
    }
  }, [activeTab, fetchManifest, getStartUrl, shouldRedirectToStartUrl, updateActiveTab])

  /* -------------------------------------------------------------------------- */
  /*                                 UTILITIES                                  */
  /* -------------------------------------------------------------------------- */
  const domainForUrl = useCallback((u: string): string => {
    try {
      if (u === kNEW_TAB_URL) return ''
      const { hostname } = new URL(u)
      return hostname
    } catch {
      return u
    }
  }, [])

  // Cache denied permissions per current domain for quick access and JS injection
  const updateDeniedPermissionsForDomain = useCallback(
    async (urlString: string) => {
      try {
        const domain = domainForUrl(urlString)
        if (!domain) {
          setPermissionsDeniedForCurrentDomain([])
          return
        }
        const domainPerms = await getDomainPermissions(domain)
        const denied = Object.entries(domainPerms)
          .filter(([, state]) => state === 'deny')
          .map(([perm]) => perm as PermissionType)
        setPermissionsDeniedForCurrentDomain(denied)
      } catch (e) {
        console.warn('Failed updating denied permissions cache', e)
      }
    },
    [domainForUrl]
  )

  useEffect(() => {
    if (activeTab?.url) {
      updateDeniedPermissionsForDomain(activeTab.url)
    }
  }, [activeTab, updateDeniedPermissionsForDomain])
  /* -------------------------------------------------------------------------- */
  /*                              ADDRESS HANDLING                              */
  /* -------------------------------------------------------------------------- */

  // Overlay lookup for non-URL queries
  const performOverlayLookup = useCallback(async (searchParam: string) => {
    try {
      const overlay = new LookupResolver()
      const response = await overlay.query({
        service: 'ls_apps',
        query: { name: searchParam }
      }, 10000)
      if (response?.outputs?.length) {
        const searchResults = response.outputs.map((o: any) => {
          try {
            const data = JSON.parse(Utils.toUTF8(
              Transaction.fromBEEF(o.beef).outputs[0].lockingScript.chunks[2].data as number[]
            ))
            return data.domain
          } catch {
            return null
          }
        }).filter(Boolean) as string[]

        if (searchResults.length === 1) {
          // Single result: navigate directly
          const domain = searchResults[0]
          const url = domain.startsWith('http') ? domain : `https://${domain}`
          updateActiveTab({ url })
        } else if (searchResults.length > 1) {
          // Multiple results: show as suggestions
          setAddressSuggestions(searchResults.map(domain => ({
            title: domain,
            url: domain.startsWith('http') ? domain : `https://${domain}`,
            timestamp: Date.now()
          })))
        }
      }
    } catch (error) {
      console.warn('[OverlayLookup] Search failed:', error)
    }
  }, [updateActiveTab])

  const onAddressSubmit = useCallback(() => {
    let entry = addressText.trim()

    // Check if entry already has a protocol prefix
    const hasProtocol = /^[a-z]+:\/\//i.test(entry)

    // Check for IP address format - basic IPv4 pattern
    const isIpAddress = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/i.test(entry)

    // Check if it's likely a URL (protocol, www, domain, or IP address)
    const isProbablyUrl = hasProtocol || /^(www\.|([A-Za-z0-9\-]+\.)+[A-Za-z]{2,})(\/|$)/i.test(entry) || isIpAddress

    if (entry === '') {
      entry = kNEW_TAB_URL
    } else if (!isProbablyUrl) {
      // Not a URL — query the BSV app overlay
      performOverlayLookup(entry)
      addressEditing.current = false
      return
    } else if (!hasProtocol) {
      // Add appropriate protocol based on whether it's an IP address or regular domain
      if (isIpAddress) {
        entry = 'http://' + entry
      } else {
        entry = 'https://' + entry
      }
    }
    // URLs with protocol (like https://) pass through unchanged

    if (!isValidUrl(entry)) {
      entry = kNEW_TAB_URL
    }

    updateActiveTab({ url: entry })
    addressEditing.current = false
  }, [addressText, updateActiveTab, performOverlayLookup])

  /* -------------------------------------------------------------------------- */
  /*                               TAB NAVIGATION                               */
  /* -------------------------------------------------------------------------- */
  const navBack = useCallback(() => {
    const currentTab = tabStore.activeTab
    if (currentTab && currentTab.canGoBack) {
      console.log('⬅️ Navigating Back:', {
        currentUrl: currentTab.url,
        canGoBack: currentTab.canGoBack,
        canGoForward: currentTab.canGoForward,
        timestamp: new Date().toISOString()
      })
      tabStore.goBack(currentTab.id)
    } else {
      console.log('⬅️ Cannot Navigate Back:', {
        currentUrl: currentTab?.url || 'No active tab',
        canGoBack: currentTab?.canGoBack || false,
        timestamp: new Date().toISOString()
      })
    }
  }, [])

  const navFwd = useCallback(() => {
    const currentTab = tabStore.activeTab
    if (currentTab && currentTab.canGoForward) {
      console.log('➡️ Navigating Forward:', {
        currentUrl: currentTab.url,
        canGoBack: currentTab.canGoBack,
        canGoForward: currentTab.canGoForward,
        timestamp: new Date().toISOString()
      })
      tabStore.goForward(currentTab.id)
    } else {
      console.log('➡️ Cannot Navigate Forward:', {
        currentUrl: currentTab?.url || 'No active tab',
        canGoForward: currentTab?.canGoForward || false,
        timestamp: new Date().toISOString()
      })
    }
  }, [])

  const navReloadOrStop = useCallback(() => {
    const currentTab = tabStore.activeTab
    if (!currentTab) return

    if (currentTab.isLoading) {
      console.log('🛑 Stopping Page Load:', {
        url: currentTab.url,
        canGoBack: currentTab.canGoBack,
        canGoForward: currentTab.canGoForward,
        timestamp: new Date().toISOString()
      })
      return currentTab.webviewRef?.current?.stopLoading()
    } else {
      console.log('🔄 Reloading Page:', {
        url: currentTab.url,
        canGoBack: currentTab.canGoBack,
        canGoForward: currentTab.canGoForward,
        timestamp: new Date().toISOString()
      })
      return currentTab.webviewRef?.current?.reload()
    }
  }, [])

  const toggleDesktopView = useCallback(() => {
    // Prevent multiple rapid presses during cooldown
    if (isToggleDesktopCooldown) return

    const currentTab = tabStore.activeTab

    setIsToggleDesktopCooldown(true)
    setIsDesktopView(prev => !prev)

    // Reload the current page to apply the new user agent
    if (currentTab && currentTab.url !== kNEW_TAB_URL) {
      currentTab.webviewRef?.current?.reload()
    }

    // Reset cooldown after reload animation/loading time
    setTimeout(() => {
      setIsToggleDesktopCooldown(false)
    }, 1500) // 1.5 second cooldown to allow for reload
  }, [isToggleDesktopCooldown])

  // User agent strings
  const mobileUserAgent =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
  const desktopUserAgent =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'

  useEffect(() => {
    if (tabStore.tabs.length === 0 && tabStore.isInitialized) {
      tabStore.newTab()
      setAddressFocused(false)
      Keyboard.dismiss()
    }
  }, [])
  useEffect(() => {
    if (activeTab && !addressEditing.current) {
      setAddressText(activeTab.url)
    }
  }, [activeTab])

  const dismissKeyboard = useCallback(() => {
    addressInputRef.current?.blur()
    Keyboard.dismiss()
  }, [])

  const responderProps =
    addressFocused && keyboardVisible
      ? {
          onStartShouldSetResponder: () => true,
          onResponderRelease: dismissKeyboard
        }
      : {}

  // Unified permission decision handler for PermissionModal
  const onDecision = useCallback(
    async (granted: boolean) => {
      setPermissionModalVisible(false)

      if (!pendingDomain || !pendingPermission) {
        throw new Error('No pending permission found')
      }

      const domain = pendingDomain
      const permission = pendingPermission
      const decisionStart = Date.now()
      console.log('[Metanet] PermissionModal decision', { domain, permission, granted })

      try {
        if (pendingDomain && pendingPermission) {
          // Persist domain-level choice
          console.log('[Metanet] Persisting domain permission', {
            domain: pendingDomain,
            permission: pendingPermission,
            state: granted ? 'allow' : 'deny'
          })
          await setDomainPermission(pendingDomain, pendingPermission, granted ? 'allow' : 'deny')

          // If enabling OS-backed permissions, proactively request OS permission so it appears in system settings
          try {
            const osBacked: PermissionType[] = ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION'] as any
            if (granted && osBacked.includes(pendingPermission)) {
              await checkPermissionForDomain(pendingDomain, pendingPermission)
            }
          } catch (e) {
            console.warn('[Metanet] OS permission request failed (non-fatal)', e)
          }

          // Update denied list cache used by injection
          console.log('[Metanet] Updating denied-permissions cache for current tab', {
            url: activeTab?.url || ''
          })
          await updateDeniedPermissionsForDomain(activeTab?.url || '')

          // Live-update the page (remove from pending + fire change event)
          if (activeTab?.url && domainForUrl(activeTab.url) === pendingDomain && activeTab.webviewRef?.current) {
            const updatedDenied = granted
              ? permissionsDeniedForCurrentDomain.filter(p => p !== pendingPermission)
              : [...new Set([...permissionsDeniedForCurrentDomain, pendingPermission])]

            console.log('[Metanet] Injecting permissionchange into page', {
              permission: pendingPermission,
              state: granted ? 'granted' : 'denied'
            })
            const js = `
            (function () {
              try {
                if (!Array.isArray(window.__metanetDeniedPermissions)) window.__metanetDeniedPermissions = [];
                if (!Array.isArray(window.__metanetPendingPermissions)) window.__metanetPendingPermissions = [];

                window.__metanetDeniedPermissions = ${JSON.stringify(updatedDenied)};
                window.__metanetPendingPermissions = window.__metanetPendingPermissions.filter(p => p !== '${pendingPermission}');
                
                const evt = new CustomEvent('permissionchange', {
                  detail: { permission: '${pendingPermission}', state: '${granted ? 'granted' : 'denied'}' }
                });
                document.dispatchEvent(evt);
              } catch (e) { console.error('[Metanet] permissionchange injection error', e); }
            })();
          `
            activeTab.webviewRef.current.injectJavaScript(js)
            console.log('[Metanet] permissionchange injected')
          }
        }
      } finally {
        // 2) Resolve the page-side awaiter no matter what
        console.log('[Metanet] Resolving pendingCallback for permission decision', { granted })
        pendingCallback?.(granted)

        // 3) Clear pending state
        setPendingDomain(null)
        setPendingPermission(null)
        setPendingCallback(null)

        console.log('[Metanet] Permission flow complete', {
          domain,
          permission,
          granted,
          elapsedMs: Date.now() - decisionStart
        })
      }
    },
    [pendingDomain, pendingPermission, activeTab, permissionsDeniedForCurrentDomain, pendingCallback, domainForUrl, updateDeniedPermissionsForDomain]
  )

  // Handle permission changes from PermissionsScreen
  const handlePermissionChange = useCallback(
    async (permission: PermissionType, state: PermissionState) => {
      try {
        const url = activeTab?.url
        const domain = url ? domainForUrl(url) : ''

        // Persist change (PermissionsScreen also persists, but this keeps Browser state consistent)
        if (domain) {
          await setDomainPermission(domain, permission, state)
        }

        // If enabling OS-backed permissions from the Permissions screen, proactively request OS permission
        try {
          const osBacked: PermissionType[] = ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION'] as any
          if (domain && state === 'allow' && osBacked.includes(permission)) {
            await checkPermissionForDomain(domain, permission)
          }
        } catch (e) {
          console.warn('[Metanet] OS permission request (from PermissionsScreen) failed (non-fatal)', e)
        }

        // Update denied permissions cache
        if (url) {
          await updateDeniedPermissionsForDomain(url)
        }

        // Inject permissionchange event into WebView for immediate UI updates
        if (activeTab?.webviewRef?.current) {
          const stateStr = state === 'allow' ? 'granted' : state === 'deny' ? 'denied' : 'prompt'
          const js = `
            (function () {
              try {
                const evt = new CustomEvent('permissionchange', { detail: { permission: '${permission}', state: '${stateStr}' } });
                document.dispatchEvent(evt);
              } catch (e) {}
            })();
          `
          activeTab.webviewRef.current.injectJavaScript(js)
        }
      } catch (e) {
        console.warn('Failed handling permission change', e)
      }
    },
    [activeTab, domainForUrl, updateDeniedPermissionsForDomain]
  )

  /* -------------------------------------------------------------------------- */
  /*                           WEBVIEW MESSAGE HANDLER                          */
  /* -------------------------------------------------------------------------- */

  // === 1. Injected JS ============================================
  const injectedJavaScript = useMemo(
    () => buildInjectedJavaScript(getAcceptLanguageHeader()),
    [getAcceptLanguageHeader]
  )

  // === 2. RN ⇄ WebView message bridge ========================================
  // Centralized router for fullscreen and permission-related messages
  const routeWebViewMessage = useMemo(
    () =>
      createWebViewMessageRouter({
        getActiveTab: () => tabStore.activeTab,
        domainForUrl,
        getPermissionState,
        setPendingDomain: (d: string) => setPendingDomain(d),
        setPendingPermission: (p: PermissionType) => setPendingPermission(p),
        setPendingCallback: (cb: (granted: boolean) => void) => setPendingCallback(() => cb),
        setPermissionModalVisible: (v: boolean) => setPermissionModalVisible(v),
        activeCameraStreams,
        setIsFullscreen: (v: boolean) => setIsFullscreen(v)
      }),
    [domainForUrl, setPermissionModalVisible]
  )

  const handleMessage = useCallback(
    async (event: WebViewMessageEvent) => {
      // Safety check - if activeTab is undefined, we cannot process messages
      if (!activeTab) {
        console.warn('Cannot process WebView message: activeTab is undefined')
        return
      }

      const sendResponseToWebView = (id: string, result: any) => {
        if (!activeTab || !activeTab.webviewRef?.current) return

        const message = {
          type: 'CWI',
          id,
          isInvocation: false,
          result,
          status: 'ok'
        }

        activeTab.webviewRef.current.injectJavaScript(getInjectableJSMessage(message))
      }

      let msg
      try {
        msg = JSON.parse(event.nativeEvent.data)
      } catch (error) {
        console.error('Failed to parse WebView message:', error)
        return
      }

      if (msg.type === 'CONSOLE') {
        const logPrefix = '[WebView]'
        switch (msg.method) {
          case 'log':
            console.log(logPrefix, ...msg.args)
            break
          case 'warn':
            console.warn(logPrefix, ...msg.args)
            break
          case 'error':
            console.error(logPrefix, ...msg.args)
            break
          case 'info':
            console.info(logPrefix, ...msg.args)
            break
          case 'debug':
            console.debug(logPrefix, ...msg.args)
            break
        }
        return
      }
      console.log('WebView message received:', msg.type, msg)
      // Delegate permission/fullscreen-related messages to central router
      if (await routeWebViewMessage(msg)) return

      // Handling of wallet before api call.
      if (msg.call && (!wallet || isWeb2Mode)) {
        // Show Web3 setup prompt if a website tries to use Web3 features
        if (!wallet && !isWeb2Mode) {
          router.push('/config')
          // showWeb3Benefits(
          //   // onContinue - stay in Web2 mode
          //   () => {
          //     console.log('User chose to continue without Web3')
          //   },
          //   // onGoToLogin - set up Web3 identity
          //   () => {
          //     router.push('/config')
          //   }
          // )
        }
        return
      }

      // Handle wallet API calls
      const origin = activeTab.url.replace(/^https?:\/\//, '').split('/')[0]
      let response: any

      try {
        switch (msg.call) {
          case 'getPublicKey':
          case 'revealCounterpartyKeyLinkage':
          case 'revealSpecificKeyLinkage':
          case 'encrypt':
          case 'decrypt':
          case 'createHmac':
          case 'verifyHmac':
          case 'createSignature':
          case 'verifySignature':
          case 'createAction':
          case 'signAction':
          case 'abortAction':
          case 'listActions':
          case 'internalizeAction':
          case 'listOutputs':
          case 'relinquishOutput':
          case 'acquireCertificate':
          case 'listCertificates':
          case 'proveCertificate':
          case 'relinquishCertificate':
          case 'discoverByIdentityKey':
          case 'isAuthenticated':
          case 'waitForAuthentication':
          case 'getHeight':
          case 'getHeaderForHeight':
          case 'discoverByAttributes':
          case 'getNetwork':
          case 'getVersion':
            response = await (wallet as any)[msg.call](typeof msg.args !== 'undefined' ? msg.args : {}, origin)
            break
          default:
            throw new Error('Unsupported method.')
        }
        sendResponseToWebView(msg.id, response)
      } catch (error) {
        console.error('Error processing wallet API call:', msg.call, error)
        sendResponseToWebView(msg.id, { error: error?.message || 'unknown error' })
      }
    },
    [activeTab, wallet, routeWebViewMessage, isWeb2Mode]
  )

  /* -------------------------------------------------------------------------- */
  /*                      NAV STATE CHANGE → HISTORY TRACKING                   */
  /* -------------------------------------------------------------------------- */
  const handleNavStateChange = (navState: WebViewNavigation) => {
    // Safety check - if activeTab is undefined, we cannot process navigation
    if (!activeTab) {
      console.warn('Cannot handle navigation state change: activeTab is undefined')
      return
    }

    // Ignore favicon requests for about:blank
    if (navState.url?.includes('favicon.ico') && activeTab.url === kNEW_TAB_URL) {
      return
    }

    // Clean up camera streams when navigating away from a page
    if (navState.url !== activeTab.url && activeCameraStreams.current.has(activeTab.id.toString())) {
      console.log('Cleaning up camera streams for tab navigation')
      activeCameraStreams.current.delete(activeTab.id.toString())

      // Inject script to stop any active media streams
      activeTab.webviewRef?.current?.injectJavaScript(`
        (function() {
          if (window.__activeMediaStreams) {
            window.__activeMediaStreams.forEach(stream => {
              stream.getTracks().forEach(track => track.stop());
            });
            window.__activeMediaStreams = [];
          }
        })();
      `)
    }

    // Make sure we're updating the correct tab's navigation state
    tabStore.handleNavigationStateChange(activeTab.id, navState)

    if (!addressEditing.current) setAddressText(navState.url)

    if (!navState.loading && navState.url !== kNEW_TAB_URL) {

      pushHistory({
        title: navState.title || navState.url,
        url: navState.url,
        timestamp: Date.now()
      }).catch(() => {})
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                          SHARE                                             */
  /* -------------------------------------------------------------------------- */
  const shareCurrent = useCallback(async () => {
    const currentTab = tabStore.activeTab
    if (!currentTab) return

    try {
      await Share.share({ message: currentTab.url })
    } catch (err) {
      console.warn('Share cancelled/failed', err)
    }
  }, [])

  /* -------------------------------------------------------------------------- */
  /*                 DRAWERS (STAR, PERMISSIONS, TRUSTS, INFO)                  */
  /* -------------------------------------------------------------------------- */
  // const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [isDrawerAnimating, setIsDrawerAnimating] = useState(false)
  const windowHeight = Dimensions.get('window').height
  const drawerFullHeight = windowHeight * 0.75
  const translateY = useRef(new Animated.Value(drawerFullHeight)).current

  const [showPermissionsDrawer, setShowPermissionsDrawer] = useState(false)
  const [permissionsOrigin, setPermissionsOrigin] = useState<string>('')
  const [showTrustDrawer, setShowTrustDrawer] = useState(false)
  const [permissionsCloseInstant, setPermissionsCloseInstant] = useState(false)
  const [trustCloseInstant, setTrustCloseInstant] = useState(false)
  const [showIdentityDrawer, setShowIdentityDrawer] = useState(false)
  const [identityCloseInstant, setIdentityCloseInstant] = useState(false)
  const [showSettingsDrawer, setShowSettingsDrawer] = useState(false)
  const [settingsCloseInstant, setSettingsCloseInstant] = useState(false)

  const closeStarDrawer = useCallback(() => {
    const runCloseDrawer = () => {
      Keyboard.dismiss()
      setIsDrawerAnimating(true)

      Animated.spring(translateY, {
        toValue: drawerFullHeight,
        useNativeDriver: true,
        tension: 100,
        friction: 8
      }).start()

      setTimeout(() => {
        setShowStarDrawer(false)
        setIsDrawerAnimating(false)
      }, 300)
    }
    if (isDrawerAnimating) {
      translateY.stopAnimation(() => {
        runCloseDrawer()
      })
      return
    }
    runCloseDrawer()
  }, [isDrawerAnimating, drawerFullHeight, translateY])

  const onPanGestureEvent = useRef(
    Animated.event([{ nativeEvent: { translationY: translateY } }], {
      useNativeDriver: true
    })
  ).current

  const onPanHandlerStateChange = useCallback(
    (event: any) => {
      if (event.nativeEvent.oldState === GestureState.ACTIVE) {
        if (isDrawerAnimating) return
        setIsDrawerAnimating(true)

        const { translationY, velocityY } = event.nativeEvent

        const shouldClose = translationY > drawerFullHeight / 3 || velocityY > 800
        const targetValue = shouldClose ? drawerFullHeight : 0

        Animated.spring(translateY, {
          toValue: targetValue,
          useNativeDriver: true,
          tension: 100,
          friction: 8,
          velocity: velocityY / 500
        }).start()

        if (shouldClose) {
          Keyboard.dismiss()
          setTimeout(() => {
            setShowStarDrawer(false)
            setIsDrawerAnimating(false)
          }, 150)
        } else {
          setIsDrawerAnimating(false)
        }
      }
    },
    [drawerFullHeight, translateY, isDrawerAnimating]
  )

  useEffect(() => {
    if (showStarDrawer) {
      setIsDrawerAnimating(true)
      translateY.setValue(drawerFullHeight)
      Animated.spring(translateY, {
        toValue: 0,
        useNativeDriver: true,
        tension: 100,
        friction: 8
      }).start(() => {
        setIsDrawerAnimating(false)
      })
    }
  }, [showStarDrawer, drawerFullHeight, translateY])

  const togglePermissionsDrawer = useCallback((open: boolean) => {
    setShowPermissionsDrawer(open)
  }, [])

  const toggleStarDrawer = useCallback(
    (open: boolean) => {
      setShowStarDrawer(open)
      Animated.timing(starDrawerAnim, {
        toValue: 1,
        duration: 250,
        useNativeDriver: true
      }).start()
    },
    [starDrawerAnim]
  )

  const handleSetStartingUrl = useCallback(
    (url: string) => {
      updateActiveTab({ url })
      toggleStarDrawer(false)
    },
    [updateActiveTab, toggleStarDrawer]
  )

  /* ---------------------------- clear history modal ------------------------- */
  const [clearConfirmVisible, setClearConfirmVisible] = useState(false)

  const showClearConfirm = useCallback(() => {
    setClearConfirmVisible(true)
  }, [])

  // BookmarksScene will be defined after toggleInfoDrawer

  const HistoryScene = React.useCallback(() => {
    return (
      <HistoryList
        history={history}
        onSelect={u => {
          updateActiveTab({ url: u })
          toggleStarDrawer(false)
        }}
        onDelete={removeHistoryItem}
        onClear={() => showClearConfirm()}
      />
    )
  }, [history, updateActiveTab, toggleStarDrawer, removeHistoryItem, showClearConfirm])

  const handleConfirmClearAll = useCallback(() => {
    clearHistory()
    setClearConfirmVisible(false)
  }, [clearHistory])

  const closeClearConfirm = useCallback(() => {
    setClearConfirmVisible(false)
  }, [])

  /* -------------------------------------------------------------------------- */
  /*                         ADDRESS BAR AUTOCOMPLETE                           */
  /* -------------------------------------------------------------------------- */

  const fuseRef = useRef(
    new Fuse<HistoryEntry | Bookmark>([], {
      keys: ['title', 'url'],
      threshold: 0.4
    })
  )
  useEffect(() => {
    fuseRef.current.setCollection([...history, ...bookmarkStore.bookmarks])
  }, [history])
  const [addressSuggestions, setAddressSuggestions] = useState<(HistoryEntry | Bookmark)[]>([])

  const onChangeAddressText = useCallback((txt: string) => {
    setAddressText(txt)
    if (txt.trim().length === 0) {
      setAddressSuggestions([])
      return
    }
    const results = fuseRef.current
      .search(txt)
      .slice(0, 10) // Get more results initially
      .map(r => r.item)

    // Remove duplicates based on URL
    const uniqueResults = results
      .filter((item, index, self) => index === self.findIndex(t => t.url === item.url))
      .slice(0, 5) // Then limit to 5 unique results

    setAddressSuggestions(uniqueResults)
  }, [])

  /* -------------------------------------------------------------------------- */
  /*                              INFO DRAWER NAV                               */
  /* -------------------------------------------------------------------------- */
  const toggleInfoDrawer = useCallback((open: boolean, route: typeof infoDrawerRoute = 'root') => {
    console.log('toggleInfoDrawer called with:', { open, route, isFullscreen, showInfoDrawer })
    setInfoDrawerRoute(route)
    setShowInfoDrawer(open)
    console.log('After setShowInfoDrawer, new value should be:', open)
  }, [isFullscreen, showInfoDrawer])

  const BookmarksScene = useMemo(() => {
    const Comp: React.FC = () => (
      <RecommendedApps
        includeBookmarks={bookmarkStore.bookmarks
          .filter(bookmark => {
            // Filter out invalid URLs to prevent favicon errors
            return (
              bookmark.url &&
              bookmark.url !== kNEW_TAB_URL &&
              isValidUrl(bookmark.url) &&
              !bookmark.url.includes('about:blank')
            )
          })
          .reverse()}
        setStartingUrl={handleSetStartingUrl}
        onRemoveBookmark={removeBookmark}
        onRemoveDefaultApp={removeDefaultApp}
        removedDefaultApps={removedDefaultApps}
        hideHeader={true}
        showOnlyBookmarks={true}
      />
    )
    Comp.displayName = 'BookmarksScene'
    return Comp
  }, [
    handleSetStartingUrl,
    removeBookmark,
    removeDefaultApp,
    removedDefaultApps
  ])

  const infoDrawerHeightPercent = infoDrawerRoute === 'root' ? 0.75 : 0.9

  /* -------------------------------------------------------------------------- */
  /*                               DRAWER HANDLERS                              */
  /* -------------------------------------------------------------------------- */

  const drawerHandlers = useMemo(
    () => ({
      identity: () => {
        setShowIdentityDrawer(true)
        toggleInfoDrawer(false)
      },
      security: () => setInfoDrawerRoute('security'),
      trust: () => {
        setShowTrustDrawer(true)
        toggleInfoDrawer(false)
      },
      settings: () => {
        setShowSettingsDrawer(true)
        toggleInfoDrawer(false)
      },
      permissions: () => {
        const origin = activeTab?.url ? domainForUrl(activeTab.url) : ''
        setPermissionsOrigin(origin)
        togglePermissionsDrawer(true)
        toggleInfoDrawer(false)
      },
      toggleDesktopView: () => {
        toggleDesktopView()
        toggleInfoDrawer(false)
      },
      addBookmark: () => {
        // Only add bookmark if activeTab exists and URL is valid and not new tab page
        if (
          activeTab &&
          activeTab.url &&
          activeTab.url !== kNEW_TAB_URL &&
          isValidUrl(activeTab.url) &&
          !activeTab.url.includes('about:blank')
        ) {
          addBookmark(activeTab.title || t('untitled'), activeTab.url)
          toggleInfoDrawer(false)
        }
      },
      backToHomepage: () => {
        updateActiveTab({ url: homepageUrl })
        setAddressText(homepageUrl)
        toggleInfoDrawer(false)
      },
      goToLogin: () => {
        router.push('/auth/mnemonic')
        toggleInfoDrawer(false)
      }
    }),
    [
      activeTab,
      addBookmark,
      domainForUrl,
      homepageUrl,
      toggleInfoDrawer,
      updateActiveTab,
      setAddressText,
      toggleDesktopView,
      togglePermissionsDrawer,
      t
    ]
  )

  /* -------------------------------------------------------------------------- */
  /*                                  RENDER                                    */
  /* -------------------------------------------------------------------------- */

  const showAddressBar = Platform.OS === 'android' ? !keyboardVisible || addressFocused : true
  const showBottomBar = Platform.OS === 'android' ? !(keyboardVisible || addressFocused) : !(keyboardVisible && addressFocused)

  // Exit fullscreen on back button or gesture when in fullscreen
  useEffect(() => {
    if (isFullscreen) {
      const backHandler = () => {
        setIsFullscreen(false)
        // Notify webview that fullscreen exited
        activeTab?.webviewRef.current?.injectJavaScript(`
          window.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({
              type: 'FULLSCREEN_CHANGE',
              isFullscreen: false
            })
          }));
        `)
        return true // Prevent default back behavior
      }

      // Add back button listener for Android
      if (Platform.OS === 'android') {
        const subscription = BackHandler.addEventListener('hardwareBackPress', backHandler)
        return () => subscription.remove()
      }
    }
  }, [isFullscreen, activeTab?.webviewRef])

  const starDrawerAnimatedStyle = useMemo(
    () => [
      styles.starDrawer,
      {
        backgroundColor: colors.background,
        height: drawerFullHeight,
        top: windowHeight - drawerFullHeight,
        transform: [{ translateY }]
      }
    ],
    [colors.background, drawerFullHeight, windowHeight, translateY]
  )

  const addressDisplay = addressFocused ? addressText : domainForUrl(addressText)

  const [ready, setReady] = useState(false)

  useEffect(() => {
    const handle = InteractionManager.runAfterInteractions(() => {
      setReady(true)
    })
    return () => handle.cancel?.()
  }, [])
  if (!tabStore.isInitialized) {
    // don’t render the browser UI until tabs are loaded or created
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    )
  }
  const uri = typeof activeTab?.url === 'string' && activeTab.url.length > 0 ? activeTab.url : 'about:blank'
  if (!ready) {
    return (
      <View
        style={styles.loaderContainer}
        onLayout={() => {
          /* ensures layout has happened */
        }}
      >
        <ActivityIndicator size="large" />
      </View>
    )
  }

  const isBackDisabled = !activeTab?.canGoBack || activeTab?.url === kNEW_TAB_URL
  const isForwardDisabled = !activeTab?.canGoForward || activeTab?.url === kNEW_TAB_URL

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        enabled={Platform.OS === 'ios' && addressFocused}
        behavior="padding"
        keyboardVerticalOffset={0}
      >
        <SafeAreaView
          edges={['top', 'left', 'right']}  
          style={[
            styles.container,
            {
              backgroundColor: colors.inputBackground
            }
          ]}
        >
          <StatusBar style={isDark ? 'light' : 'dark'} hidden={isFullscreen} />

          {activeTab?.url === kNEW_TAB_URL ? (
            <RecommendedApps
              includeBookmarks={bookmarkStore.bookmarks
                .filter(bookmark => {
                  return (
                    bookmark.url &&
                    bookmark.url !== kNEW_TAB_URL &&
                    isValidUrl(bookmark.url) &&
                    !bookmark.url.includes('about:blank')
                  )
                })
                .reverse()}
              setStartingUrl={url => updateActiveTab({ url })}
              onRemoveBookmark={removeBookmark}
              onRemoveDefaultApp={removeDefaultApp}
              removedDefaultApps={removedDefaultApps}
              homepageSettings={homepageSettings}
              onUpdateHomepageSettings={updateHomepageSettings}
            />
          ) : activeTab ? (
            <View style={{ flex: 1 }} {...responderProps}>
              {isFullscreen && (
                <TouchableOpacity
                  style={{
                    position: 'absolute',
                    top: insets.top + 10,
                    right: 20,
                    zIndex: 1000,
                    backgroundColor: 'rgba(0,0,0,0.5)',
                    borderRadius: 20,
                    width: 40,
                    height: 40,
                    justifyContent: 'center',
                    alignItems: 'center'
                  }}
                  onPress={() => {
                    setIsFullscreen(false)
                    activeTab?.webviewRef.current?.injectJavaScript(`
                      window.dispatchEvent(new MessageEvent('message', {
                        data: JSON.stringify({
                          type: 'FULLSCREEN_CHANGE',
                          isFullscreen: false
                        })
                      }));
                    `)
                  }}
                >
                  <Ionicons name="contract-outline" size={20} color="white" />
                </TouchableOpacity>
              )}
              <WebView
                ref={activeTab?.webviewRef}
                source={{
                  uri: uri,
                  headers: {
                    'Accept-Language': getAcceptLanguageHeader()
                  }
                }}
                originWhitelist={['https://*', 'http://*']}
                onMessage={handleMessage}
                injectedJavaScript={injectedJavaScript}
                injectedJavaScriptBeforeContentLoaded={getPermissionScript(
                  permissionsDeniedForCurrentDomain,
                  pendingPermission
                )}
                onNavigationStateChange={handleNavStateChange}
                userAgent={isDesktopView ? desktopUserAgent : mobileUserAgent}
                allowsFullscreenVideo={true}
                mediaPlaybackRequiresUserAction={false}
                allowsInlineMediaPlayback={true}
                // Enable WebView geolocation on Android (actual OS permission is requested via our modal flow)
                geolocationEnabled
                // Deny all WebView permissions to prevent native camera access
                onPermissionRequest={() => false}
                androidLayerType={Platform.OS === 'android' ? 'software' : 'hardware'}
                androidHardwareAccelerationDisabled={Platform.OS === 'android'}
                onError={(syntheticEvent: any) => {
                  const { nativeEvent } = syntheticEvent
                  if (nativeEvent.url?.includes('favicon.ico') && activeTab?.url === kNEW_TAB_URL) {
                    return
                  }
                  console.warn('WebView error:', nativeEvent)
                }}
                onHttpError={(syntheticEvent: any) => {
                  const { nativeEvent } = syntheticEvent
                  if (nativeEvent.url?.includes('favicon.ico') && activeTab?.url === kNEW_TAB_URL) {
                    return
                  }
                  console.warn('WebView HTTP error:', nativeEvent)
                }}
                onLoadEnd={(navState: any) =>
                  tabStore.handleNavigationStateChange(activeTab.id, { ...navState, loading: false })
                }
                javaScriptEnabled
                domStorageEnabled
                allowsBackForwardNavigationGestures
                containerStyle={{ backgroundColor: colors.background }}
                style={{ flex: 1 }}
              />
            </View>
          ) : null}
          {!isFullscreen && showAddressBar && (
            <View
              onLayout={e => setAddressBarHeight(e.nativeEvent.layout.height)}
              style={[
                styles.addressBar,
                {
                  backgroundColor: colors.inputBackground,
                  borderColor: colors.inputBorder,
                  paddingTop: 7,
                  paddingBottom: 7,
                  marginBottom: 0,
                  zIndex: 10,
                  elevation: 10
                }
              ]}
              pointerEvents={showTabsView ? 'none' : 'auto'}
            >
              {/* deggen: Back Button unless address bar is active, in which case it's the share button */}
              {addressFocused ? null : (
                <TouchableOpacity
                  style={activeTab?.canGoForward ? styles.addressBarBackButton : styles.addressBarIcon}
                  disabled={isBackDisabled}
                  onPress={navBack}
                  activeOpacity={0.6}
                  delayPressIn={0.1}
                >
                  <Ionicons name="arrow-back" size={26} color={!isBackDisabled ? colors.textPrimary : '#cccccc'} />
                </TouchableOpacity>
              )}

              {activeTab?.canGoForward && (
                <TouchableOpacity
                  style={styles.addressBarForwardButton}
                  disabled={isForwardDisabled}
                  onPress={() => {
                    console.log('🔘 Forward Button Pressed:', {
                      canGoForward: activeTab?.canGoForward,
                      url: activeTab?.url,
                      isNewTab: activeTab?.url === kNEW_TAB_URL,
                      disabled: isForwardDisabled
                    })
                    navFwd()
                  }}
                  activeOpacity={0.6}
                  delayPressIn={0.1}
                >
                  <Ionicons
                    name="arrow-forward"
                    size={26}
                    color={!isForwardDisabled ? colors.textPrimary : '#cccccc'}
                  />
                </TouchableOpacity>
              )}

              {/* deggen: I think we need to focus on usability and this icon has no function, it should be in the URL bar or something, not here looking like a button. 
              {!addressFocused && !activeTab?.isLoading && activeTab?.url.startsWith('https') && (
                <Ionicons name="lock-closed" size={16} color={colors.textSecondary} style={styles.padlock} />
              )} */}

              <TextInput
                ref={addressInputRef}
                editable
                value={addressDisplay === 'new-tab-page' ? '' : addressDisplay}
                onChangeText={onChangeAddressText}
                onFocus={() => {
                  addressEditing.current = true
                  setAddressFocused(true)
                  // Set the text to empty if it's the new tab URL
                  if (activeTab?.url === kNEW_TAB_URL) {
                    setAddressText('')
                  }
                  setTimeout(() => {
                    const textToSelect = activeTab?.url === kNEW_TAB_URL ? '' : addressText
                    addressInputRef.current?.setNativeProps({
                      selection: { start: 0, end: textToSelect.length }
                    })
                  }, 0)
                }}
                onBlur={() => {
                  addressEditing.current = false
                  setAddressFocused(false)
                  setAddressSuggestions([])
                  // Reset to the actual URL when losing focus
                  if (!addressEditing.current) {
                    setAddressText(activeTab?.url ? activeTab.url : kNEW_TAB_URL)
                  }
                }}
                onSubmitEditing={onAddressSubmit}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="go"
                style={[
                  styles.addressInput,
                  {
                    flex: 1,
                    backgroundColor: colors.background,
                    color: colors.textPrimary,
                    textAlign: addressFocused ? 'left' : 'center',
                    height: 35, // Add explicit height for iOS
                    fontSize: 18,
                    paddingVertical: 8, // Add padding for better appearance
                    borderRadius: 5
                  }
                ]}
                placeholder={t('search_placeholder')}
                placeholderTextColor={colors.textSecondary}
              />

              <TouchableOpacity
                onPress={addressFocused ? () => setAddressText('') : navReloadOrStop}
                style={styles.addressBarIcon}
              >
                <Ionicons
                  name={addressFocused || activeTab?.isLoading ? 'close-circle' : 'refresh'}
                  size={26}
                  color={colors.primary}
                />
              </TouchableOpacity>

              {/* {!addressFocused && activeTab?.url !== kNEW_TAB_URL && (
                <TouchableOpacity onPress={toggleDesktopView} style={styles.addressBarIcon}>
                  <Ionicons
                    name={isDesktopView ? 'phone-portrait' : 'desktop'}
                    size={20}
                    color={isDesktopView ? colors.primary : colors.textSecondary}
                  />
                </TouchableOpacity>
              )} */}
            </View>
          )}

          {!isFullscreen && addressFocused && addressSuggestions.length > 0 && (
            <View style={[styles.suggestionBox, { backgroundColor: colors.paperBackground }]}>
              {addressSuggestions.map((entry: HistoryEntry | Bookmark, i: number) => (
                <TouchableOpacity
                  key={`suggestion-${i}-${entry.url}`}
                  onPress={() => {
                    // Dismiss keyboard and hide suggestions first
                    addressInputRef.current?.blur()
                    Keyboard.dismiss()
                    setAddressFocused(false)
                    setAddressSuggestions([])

                    // Then load the page
                    setAddressText(entry.url)
                    updateActiveTab({ url: entry.url })
                    addressEditing.current = false
                  }}
                  style={styles.suggestionItem}
                >
                  <Text numberOfLines={1} style={[styles.suggestionTitle, { color: colors.textPrimary }]}>
                    {entry.title}
                  </Text>
                  <Text numberOfLines={1} style={[styles.suggestionUrl, { color: colors.textSecondary }]}>
                    {entry.url}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {!isFullscreen && showTabsView && (
            <TabsView
              onDismiss={() => setShowTabsView(false)}
              setAddressText={setAddressText}
              colors={colors}
              setAddressFocused={setAddressFocused}
            />
          )}

          {!isFullscreen && (showStarDrawer || isDrawerAnimating) && (
            <View style={StyleSheet.absoluteFill}>
              <Pressable style={styles.backdrop} onPress={closeStarDrawer} />
              <Animated.View style={starDrawerAnimatedStyle}>
                <PanGestureHandler
                  onGestureEvent={onPanGestureEvent}
                  onHandlerStateChange={onPanHandlerStateChange}
                  activeOffsetY={10}
                  failOffsetX={[-20, 20]}
                >
                  <Animated.View style={styles.drawerHandleArea}>
                    <View style={styles.handleBar} />
                  </Animated.View>
                </PanGestureHandler>
                <View style={{ flex: 1 }}>
                  <StarDrawer
                    BookmarksScene={BookmarksScene}
                    HistoryScene={HistoryScene}
                    colors={colors}
                    styles={styles}
                    index={starTabIndex}
                    setIndex={setStarTabIndex}
                  />
                </View>
              </Animated.View>
            </View>
          )}

          {!isFullscreen && (
            <>
              {/* Identity Drawer */}
              <BottomDrawer
                visible={showIdentityDrawer}
                onClose={() => setShowIdentityDrawer(false)}
                heightPercent={0.9}
                backgroundColor={colors.background}
                backdropOpacity={0.7}
                closeInstantly={identityCloseInstant}
              >
                <View style={[styles.subDrawerHeader, { borderBottomColor: colors.textSecondary + '33' }]}> 
                  <TouchableOpacity
                    onPress={() => {
                      setIdentityCloseInstant(true)
                      setShowIdentityDrawer(false)
                      setTimeout(() => setIdentityCloseInstant(false), 0)
                      setInfoDrawerRoute('root')
                      toggleInfoDrawer(true)
                    }}
                    activeOpacity={0.6}
                    delayPressIn={0}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  >
                    <Text style={[styles.backBtn, { color: colors.primary }]}>‹ {t('back')}</Text>
                  </TouchableOpacity>
                  <Text style={[styles.subDrawerTitle, { color: colors.textPrimary }]}>{t('identity')}</Text>
                  <View style={{ width: 60 }} />
                </View>
                <View style={styles.subDrawerContent}>
                  <IdentityScreen />
                </View>
              </BottomDrawer>

              {/* Settings Drawer */}
              <BottomDrawer
                visible={showSettingsDrawer}
                onClose={() => setShowSettingsDrawer(false)}
                heightPercent={0.9}
                backgroundColor={colors.background}
                backdropOpacity={0.7}
                closeInstantly={settingsCloseInstant}
              >
                <View style={[styles.subDrawerHeader, { borderBottomColor: colors.textSecondary + '33' }]}> 
                  <TouchableOpacity
                    onPress={() => {
                      setSettingsCloseInstant(true)
                      setShowSettingsDrawer(false)
                      setTimeout(() => setSettingsCloseInstant(false), 0)
                      setInfoDrawerRoute('root')
                      toggleInfoDrawer(true)
                    }}
                    activeOpacity={0.6}
                    delayPressIn={0}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  >
                    <Text style={[styles.backBtn, { color: colors.primary }]}>‹ {t('back')}</Text>
                  </TouchableOpacity>
                  <Text style={[styles.subDrawerTitle, { color: colors.textPrimary }]}>{t('settings')}</Text>
                  <View style={{ width: 60 }} />
                </View>
                <View style={styles.subDrawerContent}>
                  <SettingsScreen />
                </View>
              </BottomDrawer>

              <BottomDrawer
                visible={showPermissionsDrawer}
                onClose={() => setShowPermissionsDrawer(false)}
                heightPercent={0.9}
                backgroundColor={colors.background}
                backdropOpacity={0.7}
                closeInstantly={permissionsCloseInstant}
              >
                <View style={[styles.subDrawerHeader, { borderBottomColor: colors.textSecondary + '33' }]}> 
                  <TouchableOpacity
                    onPress={() => {
                      setPermissionsCloseInstant(true)
                      setShowPermissionsDrawer(false)
                      setTimeout(() => setPermissionsCloseInstant(false), 0)
                      setInfoDrawerRoute('root')
                      toggleInfoDrawer(true)
                    }}
                    activeOpacity={0.6}
                    delayPressIn={0}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  >
                    <Text style={[styles.backBtn, { color: colors.primary }]}>‹ {t('back')}</Text>
                  </TouchableOpacity>
                  <Text style={[styles.subDrawerTitle, { color: colors.textPrimary }]}>{t('permissions')}</Text>
                  <View style={{ width: 60 }} />
                </View>
                <View style={styles.subDrawerContent}>
                  <PermissionsScreen origin={permissionsOrigin} onPermissionChange={handlePermissionChange} />
                </View>
              </BottomDrawer>

              <BottomDrawer
                visible={showTrustDrawer}
                onClose={() => setShowTrustDrawer(false)}
                heightPercent={0.9}
                backgroundColor={colors.background}
                backdropOpacity={0.7}
                closeInstantly={trustCloseInstant}
              >
                <View style={[styles.subDrawerHeader, { borderBottomColor: colors.textSecondary + '33' }]}> 
                  <TouchableOpacity
                    onPress={() => {
                      setTrustCloseInstant(true)
                      setShowTrustDrawer(false)
                      setTimeout(() => setTrustCloseInstant(false), 0)
                      setInfoDrawerRoute('root')
                      toggleInfoDrawer(true)
                    }}
                    activeOpacity={0.6}
                    delayPressIn={0}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  >
                    <Text style={[styles.backBtn, { color: colors.primary }]}>‹ {t('back')}</Text>
                  </TouchableOpacity>
                  <Text style={[styles.subDrawerTitle, { color: colors.textPrimary }]}>{t('trust_network')}</Text>
                  <View style={{ width: 60 }} />
                </View>
                <View style={styles.subDrawerContent}>
                  <TrustScreen />
                </View>
              </BottomDrawer>
            </>
          )}
          {!isFullscreen && showBottomBar && activeTab && (
            <BottomToolbar
              activeTab={activeTab}
              colors={colors}
              styles={styles}
              navBack={navBack}
              navFwd={navFwd}
              shareCurrent={shareCurrent}
              toggleStarDrawer={toggleStarDrawer}
              setShowTabsView={setShowTabsView}
              toggleInfoDrawer={toggleInfoDrawer}
              isAuthenticated={!isWeb2Mode}
            />
          )}

          <BottomDrawer
            visible={!isFullscreen && showInfoDrawer}
            onClose={() => setShowInfoDrawer(false)}
            heightPercent={infoDrawerHeightPercent}
            backgroundColor={colors.background}
            backdropOpacity={0.7}
          >
            {infoDrawerRoute === 'root' ? (
              <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}>
                {!isWeb2Mode && <Balance />}
                {!isWeb2Mode && (
                  <>
                    <DrawerItem
                      label={t('identity')}
                      icon="person-circle-outline"
                      onPress={drawerHandlers.identity}
                    />
                    <DrawerItem
                      label={t('trust_network')}
                      icon="shield-checkmark-outline"
                      onPress={drawerHandlers.trust}
                    />
                    <DrawerItem label={t('settings')} icon="settings-outline" onPress={drawerHandlers.settings} />
                    {activeTab?.url !== kNEW_TAB_URL && (
                      <DrawerItem
                        label={t('permissions')}
                        icon="lock-closed-outline"
                        onPress={drawerHandlers.permissions}
                      />
                    )}
                    <View style={styles.divider} />
                  </>
                )}
                {activeTab?.url !== kNEW_TAB_URL && (
                  <DrawerItem
                    label={isDesktopView ? t('switch_to_mobile_view') : t('switch_to_desktop_view')}
                    icon={isDesktopView ? 'phone-portrait-outline' : 'desktop-outline'}
                    onPress={drawerHandlers.toggleDesktopView}
                  />
                )}
                <DrawerItem
                  label={t('back_to_homepage')}
                  icon="apps-outline"
                  onPress={drawerHandlers.backToHomepage}
                />
                {/* Login button for web2 mode users */}
                {isWeb2Mode && (
                  <>
                    <View style={styles.divider} />
                    <DrawerItem
                      label=" unlock Web3 features"
                      icon="log-in-outline"
                      onPress={drawerHandlers.goToLogin}
                    />
                  </>
                )}
              </ScrollView>
            ) : (
              <SubDrawerView
                route={infoDrawerRoute}
                onBack={() => setInfoDrawerRoute('root')}
                origin={activeTab?.url ? domainForUrl(activeTab.url) : ''}
                onPermissionChange={handlePermissionChange}
              />
            )}
          </BottomDrawer>

          {/* Clear History Confirmation Modal */}
          <RNModal transparent visible={clearConfirmVisible} onRequestClose={closeClearConfirm} animationType="fade">
            <Pressable style={styles.contextMenuBackdrop} onPress={closeClearConfirm}>
              <View style={[styles.contextMenu, { backgroundColor: colors.background }]}>
                <View style={[styles.contextMenuHeader, { borderBottomColor: colors.inputBorder }]}>
                  <Text style={[styles.contextMenuTitle, { color: colors.textPrimary }]}>
                    {t('clear_browsing_history')}
                  </Text>
                  <Text style={[styles.contextMenuUrl, { color: colors.textSecondary }]}>
                    {t('action_cannot_be_undone')}
                  </Text>
                </View>

                <TouchableOpacity
                  style={[styles.contextMenuItem, { borderBottomColor: colors.inputBorder }]}
                  onPress={handleConfirmClearAll}
                  activeOpacity={0.7}
                >
                  <Ionicons name="trash-outline" size={22} color="#FF3B30" style={styles.contextMenuIcon} />
                  <Text style={[styles.contextMenuText, { color: '#FF3B30' }]}>{t('clear')}</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.contextMenuItem, { borderBottomWidth: 0 }]}
                  onPress={closeClearConfirm}
                  activeOpacity={0.7}
                >
                  <Ionicons
                    name="close-outline"
                    size={22}
                    color={colors.textSecondary}
                    style={styles.contextMenuIcon}
                  />
                  <Text style={[styles.contextMenuText, { color: colors.textSecondary }]}>{t('cancel')}</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </RNModal>

          {pendingPermission && pendingDomain && (
            <PermissionModal
              key={pendingPermission || 'none'}
              visible={permissionModalVisible}
              domain={pendingDomain}
              permission={pendingPermission}
              onDecision={onDecision}
            />
          )}
        </SafeAreaView>
      </KeyboardAvoidingView>
    </GestureHandlerRootView>
  )
}

export default observer(Browser)

/* -------------------------------------------------------------------------- */
/*                               SUB-COMPONENTS                               */
/* -------------------------------------------------------------------------- */

const TabsViewBase = ({
  onDismiss,
  setAddressText,
  colors,
  setAddressFocused
}: {
  onDismiss: () => void
  setAddressText: (text: string) => void
  colors: any
  setAddressFocused: (focused: boolean) => void
}) => {
  const { t } = useTranslation()
  // Use the imported tabStore directly
  const screen = Dimensions.get('window')
  const ITEM_W = screen.width * 0.42
  const ITEM_H = screen.height * 0.28
  const insets = useSafeAreaInsets()

  // Animation for new tab button
  // Add cooldown state
  const [isCreatingTab, setIsCreatingTab] = useState(false)

  const handleNewTabPress = useCallback(() => {
    // Prevent multiple rapid presses
    if (isCreatingTab) return
    setIsCreatingTab(true)
    tabStore.newTab()
    Keyboard.dismiss()
    setAddressText(kNEW_TAB_URL)
    // Reset cooldown after a short delay
    setTimeout(() => {
      setAddressFocused(false)
      onDismiss()
      setIsCreatingTab(false)
    }, 300)
  }, [onDismiss, setAddressText, isCreatingTab, setAddressFocused])

  const renderItem = ({ item }: { item: Tab }) => {
    const renderRightActions = (
      progress: Animated.AnimatedInterpolation<number>,
      dragX: Animated.AnimatedInterpolation<number>
    ) => {
      const opacity = dragX.interpolate({
        inputRange: [-100, 0],
        outputRange: [1, 0],
        extrapolate: 'clamp'
      })
      return (
        <Animated.View style={[styles.swipeDelete, { backgroundColor: '#FF3B30', opacity }]}>
          <Ionicons name="trash-outline" size={22} color="#fff" />
        </Animated.View>
      )
    }
    const renderLeftActions = (
      progress: Animated.AnimatedInterpolation<number>,
      dragX: Animated.AnimatedInterpolation<number>
    ) => {
      const opacity = dragX.interpolate({
        inputRange: [0, 100],
        outputRange: [0, 1],
        extrapolate: 'clamp'
      })
      return (
        <Animated.View style={[styles.swipeDelete, { backgroundColor: '#FF3B30', opacity }]}>
          <Ionicons name="trash-outline" size={22} color="#fff" />
        </Animated.View>
      )
    }

    return (
      <Swipeable
        renderRightActions={renderRightActions}
        renderLeftActions={renderLeftActions}
        friction={1}
        leftThreshold={10}
        rightThreshold={10}
        overshootLeft={false}
        overshootRight={false}
        onSwipeableWillOpen={() => {
          InteractionManager.runAfterInteractions(() => {
            setAddressFocused(false)
            Keyboard.dismiss()
            tabStore.closeTab(item.id)
          })
        }}
      >
        <Pressable
          style={[
            styles.tabPreview,
            {
              width: ITEM_W,
              height: ITEM_H,
              borderColor: item.id === tabStore.activeTabId ? colors.primary : colors.inputBorder,
              borderWidth: item.id === tabStore.activeTabId ? 3 : StyleSheet.hairlineWidth,
              backgroundColor: colors.paperBackground
            }
          ]}
          onPress={() => {
            tabStore.setActiveTab(item.id)
            onDismiss()
          }}
        >
          <TouchableOpacity
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              width: 24,
              height: 24,
              borderRadius: 12,
              backgroundColor: colors.textSecondary + '80',
              justifyContent: 'center',
              alignItems: 'center',
              zIndex: 10
            }}
            onPress={e => {
              e.stopPropagation() // Prevent tab selection when closing
              tabStore.closeTab(item.id)
            }}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={{ color: colors.background, fontSize: 14, fontWeight: 'bold' }}>✕</Text>
          </TouchableOpacity>

          <View style={{ flex: 1, overflow: 'hidden' }}>
            {item.url === kNEW_TAB_URL ? (
              <View style={styles.tabPreviewEmpty}>
                <Text style={{ fontSize: 16, color: colors.textSecondary }}>{t('new_tab')}</Text>
              </View>
            ) : (
              <WebView
                source={{ uri: item.url || kNEW_TAB_URL }}
                style={{ flex: 1 }}
                scrollEnabled={false}
                androidLayerType={Platform.OS === 'android' ? 'software' : undefined as any}
                androidHardwareAccelerationDisabled={Platform.OS === 'android'}
                pointerEvents="none"
              />
            )}
            <View style={[styles.tabTitleBar, { backgroundColor: colors.inputBackground + 'E6' }]}>
              <Text numberOfLines={1} style={{ flex: 1, color: colors.textPrimary, fontSize: 12 }}>
                {item.title}
              </Text>
            </View>
          </View>
        </Pressable>
      </Swipeable>
    )
  }

  return (
    <View style={[styles.tabsViewContainer, { backgroundColor: colors.background + 'cc' }]}>
      <TouchableWithoutFeedback onPress={onDismiss}>
        <View style={StyleSheet.absoluteFill} />
      </TouchableWithoutFeedback>

      <FlatList
        data={tabStore.tabs.slice()}
        renderItem={renderItem}
        keyExtractor={item => item.id.toString()}
        numColumns={2}
        removeClippedSubviews={false}
        maxToRenderPerBatch={6}
        updateCellsBatchingPeriod={50}
        initialNumToRender={6}
        windowSize={10}
        getItemLayout={(data, index) => ({
          length: ITEM_H + screen.width * 0.08,
          offset: (ITEM_H + screen.width * 0.08) * Math.floor(index / 2),
          index
        })}
        onContentSizeChange={() => {}}
        extraData={tabStore.activeTabId}
        contentContainerStyle={{
          padding: 12,
          paddingTop: 32,
          paddingBottom: 20
        }}
      />

      <View
        style={[
          styles.tabsViewFooterBar,
          {
            backgroundColor: colors.inputBackground,
            paddingBottom: insets.bottom + 10,
            borderTopColor: colors.inputBorder
          }
        ]}
      >
        <TouchableOpacity
          onPress={handleNewTabPress}
          disabled={isCreatingTab}
          style={[styles.toolbarButton, { opacity: isCreatingTab ? 0.5 : 1 }]}
          activeOpacity={0.6}
          delayPressIn={0}
        >
          <Ionicons name="add" size={24} color={colors.textPrimary} />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.toolbarButton}
          onPress={() => {
            if (Platform.OS === 'ios') {
              try {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
              } catch {}
            }
            onDismiss()
            setAddressFocused(false)
            Keyboard.dismiss()
            tabStore.clearAllTabs()
            Keyboard.dismiss()
          }}
          activeOpacity={0.6}
          delayPressIn={0}
        >
          <Ionicons name="trash-outline" size={24} color={colors.textPrimary} />
        </TouchableOpacity>

        <TouchableOpacity style={styles.toolbarButton} onPress={onDismiss} activeOpacity={0.6} delayPressIn={0}>
          <Ionicons name="checkmark" size={24} color={colors.textPrimary} />
        </TouchableOpacity>
      </View>
    </View>
  )
}

const TabsView = observer(TabsViewBase)

const DrawerItem = React.memo(
  ({ label, icon, onPress }: { label: string; icon: keyof typeof Ionicons.glyphMap; onPress: () => void }) => {
    const { colors } = useTheme()
    return (
      <TouchableOpacity style={styles.drawerItem} onPress={onPress} activeOpacity={0.6} delayPressIn={0}>
        <Ionicons name={icon} size={22} color={colors.textSecondary} style={styles.drawerIcon} />
        <Text style={[styles.drawerLabel, { color: colors.textPrimary }]}>{label}</Text>
        <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
      </TouchableOpacity>
    )
  }
)

DrawerItem.displayName = 'DrawerItem'

const SubDrawerView = React.memo(
  ({
    route,
    onBack,
    origin,
    onPermissionChange
  }: {
    route: 'identity' | 'settings' | 'security' | 'trust' | 'permissions'
    onBack: () => void
    origin?: string
    onPermissionChange?: (permission: PermissionType, state: PermissionState) => void
  }) => {
    const { colors } = useTheme()
    const { t } = useTranslation()
    const { isWeb2Mode } = useBrowserMode()

    const screens = useMemo(
      () => ({
        identity: <IdentityScreen />,
        settings: <SettingsScreen />,
        // security: <SecurityScreen />,
        trust: <TrustScreen />
      }),
      []
    )

    return (
      <View style={{ flex: 1 }}>
        <View style={styles.subDrawerHeader}>
          <TouchableOpacity onPress={onBack} activeOpacity={0.6} delayPressIn={0}>
            <Text style={[styles.backBtn, { color: colors.primary }]}>‹ {t('back')}</Text>
          </TouchableOpacity>
          <Text style={[styles.subDrawerTitle, { color: colors.textPrimary }]}>{t(route)}</Text>
          <View style={{ width: 60 }} />
        </View>
        <View style={styles.subDrawerContent}>
          {route === 'permissions' ? (
            <PermissionsScreen origin={origin || ''} onPermissionChange={onPermissionChange} />
          ) : // Only show web3 screens when not in web2 mode and when route matches available screens
          !isWeb2Mode && (route === 'identity' || route === 'settings' || route === 'trust') ? (
            screens[route as 'identity' | 'settings' | 'trust']
          ) : null}
        </View>
      </View>
    )
  }
)

SubDrawerView.displayName = 'SubDrawerView'

/* -------------------------------------------------------------------------- */
/*                              BOTTOM TOOLBAR                               */
/* -------------------------------------------------------------------------- */

const BottomToolbar = ({
  activeTab,
  colors,
  styles,
  navBack,
  navFwd,
  shareCurrent,
  toggleStarDrawer,
  setShowTabsView,
  toggleInfoDrawer,
  isAuthenticated
}: {
  activeTab: Tab
  colors: any
  styles: any
  navBack: () => void
  navFwd: () => void
  shareCurrent: () => void
  toggleStarDrawer: (open: boolean) => void
  setShowTabsView: (show: boolean) => void
  toggleInfoDrawer: (open: boolean) => void
  isAuthenticated: boolean
}) => {
  const handleStarPress = useCallback(() => toggleStarDrawer(true), [toggleStarDrawer])
  const handleTabsPress = useCallback(() => setShowTabsView(true), [setShowTabsView])

  const handleProfilePress = useCallback(() => {
    if (isAuthenticated) {
      toggleInfoDrawer(true)
    } else {
      router.push('/auth/mnemonic')
    }
  }, [isAuthenticated, toggleInfoDrawer])

  return (
    <View
      style={[
        styles.bottomBar,
        {
          backgroundColor: colors.inputBackground,
          paddingBottom: 0
        }
      ]}
    >
      <TouchableOpacity onPress={handleProfilePress} style={styles.toolbarButton}>
        <Ionicons name="person-circle-outline" size={26} color={isAuthenticated ? colors.primary : colors.textSecondary} />
      </TouchableOpacity>
      {/* <TouchableOpacity
        style={styles.toolbarButton}
        disabled={isBackDisabled}
        onPress={() => {
          console.log('🔘 Back Button Pressed:', {
            canGoBack: activeTab.canGoBack,
            url: activeTab.url,
            isNewTab: activeTab.url === kNEW_TAB_URL,
            disabled: isBackDisabled
          })
          navBack()
        }}
        activeOpacity={0.6}
        delayPressIn={0.1}
      >
        <Ionicons name="arrow-back" size={24} color={!isBackDisabled ? colors.textPrimary : '#cccccc'} />
      </TouchableOpacity> */}
      {/* <TouchableOpacity
        style={styles.toolbarButton}
        disabled={isForwardDisabled}
        onPress={() => {
          console.log('🔘 Forward Button Pressed:', {
            canGoForward: activeTab.canGoForward,
            url: activeTab.url,
            isNewTab: activeTab.url === kNEW_TAB_URL,
            disabled: isForwardDisabled
          })
          navFwd()
        }}
        activeOpacity={0.6}
        delayPressIn={0.1}
      >
        <Ionicons name="arrow-forward" size={24} color={!isForwardDisabled ? colors.textPrimary : '#cccccc'} />
      </TouchableOpacity> */}

      <TouchableOpacity
        style={styles.toolbarButton}
        onPress={shareCurrent}
        disabled={activeTab.url === kNEW_TAB_URL}
        activeOpacity={0.6}
        delayPressIn={0}
      >
        <Ionicons
          name="share-outline"
          size={24}
          color={activeTab.url === kNEW_TAB_URL ? colors.textSecondary : colors.textPrimary}
        />
      </TouchableOpacity>

      <TouchableOpacity style={styles.toolbarButton} onPress={handleStarPress} activeOpacity={0.6} delayPressIn={0}>
        <Ionicons name="star-outline" size={24} color={colors.textPrimary} />
      </TouchableOpacity>

      <TouchableOpacity style={styles.toolbarButton} onPress={handleTabsPress} activeOpacity={0.6} delayPressIn={0}>
        <Ionicons name="copy-outline" size={24} color={colors.textPrimary} />
      </TouchableOpacity>
    </View>
  )
}

/* -------------------------------------------------------------------------- */
/*                                    CSS                                     */
/* -------------------------------------------------------------------------- */

const styles = StyleSheet.create({
  loaderContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center'
  },
  webview: {
    flex: 1
  },
  container: { flex: 1 },
  addressBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    paddingBottom: 12
  },
  addressInput: {
    paddingHorizontal: 8
  },
  addressBarIcon: {
    paddingHorizontal: 24,
    paddingVertical: 4
  },
  addressBarBackButton: {
    paddingLeft: 24,
    paddingRight: 4,
    paddingVertical: 4
  },
  addressBarForwardButton: {
    paddingRight: 24,
    paddingLeft: 4,
    paddingVertical: 4
  },
  padlock: { marginRight: 4 },
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingVertical: 6,
    marginBottom: 10,
    borderTopWidth: StyleSheet.hairlineWidth
  },
  toolbarButton: { padding: 6 },
  toolbarIcon: { fontSize: 20 },

  /* suggestions */
  suggestionBox: {
    position: 'absolute',
    top: 52,
    left: 0,
    right: 0,
    zIndex: 30,
    paddingBottom: 8
  },
  suggestionItem: { paddingVertical: 8, paddingHorizontal: 16 },
  suggestionTitle: { fontSize: 14 },
  suggestionUrl: { fontSize: 11 },

  /* star drawer */
  starDrawer: {
    position: 'absolute',
    left: 0,
    right: 0,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    overflow: 'hidden',
    zIndex: 20,
    elevation: 12
  },

  starTabBar: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  starTab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 3,
    borderBottomColor: 'transparent'
  },
  starTabLabel: { fontSize: 15, fontWeight: '600' },
  drawerHandleArea: {
    height: 40,
    alignItems: 'center',
    justifyContent: 'center'
  },

  /* tabs view */
  tabsViewContainer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100
  },
  tabPreview: {
    margin: '4%',
    borderRadius: 10,
    overflow: 'visible'
  },
  tabPreviewEmpty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center'
  },
  tabTitleBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingVertical: 6,
    paddingHorizontal: 8
  },
  tabsViewFooter: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20
  },
  tabsViewFooterBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: -2
    },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 5
  },

  doneButton: {
    position: 'absolute',
    right: 20,
    bottom: 56
  },
  deleteAllTabsButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    marginRight: 12,
    justifyContent: 'center',
    alignItems: 'center'
  },
  doneButtonStyled: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 24,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2
    },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 3
  },
  newTabBtn: {
    width: 56,
    height: 46,
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center'
  },
  newTabIcon: { fontSize: 32, lineHeight: 32 },

  /* info drawer */
  infoDrawer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    elevation: 10
  },
  drawerHandle: { alignItems: 'center', padding: 10 },
  handleBar: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#999'
  },
  drawerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 24
  },
  drawerIcon: {
    marginRight: 16
  },
  drawerLabel: {
    flex: 1,
    fontSize: 17
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#ccc',
    marginVertical: 8,
    marginHorizontal: 24
  },

  /* sub-drawer */
  subDrawerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 44,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12
  },
  backBtn: { fontSize: 17 },
  subDrawerTitle: { flex: 1, textAlign: 'center', fontSize: 17 },
  subDrawerContent: { flex: 1, padding: 16 },

  /* swipe delete */
  swipeDelete: {
    justifyContent: 'center',
    alignItems: 'center',
    width: 60,
    marginVertical: 10,
    borderRadius: 10
  },
  swipeDeleteText: { color: '#fff', fontSize: 24 },

  /* confirm modal */
  confirmBox: {
    borderRadius: 12,
    padding: 24,
    width: '85%',
    alignSelf: 'center'
  },
  confirmTitle: { fontSize: 16, fontWeight: '600', marginBottom: 16 },
  confirmButtons: { flexDirection: 'row', justifyContent: 'flex-end' },
  confirmBtn: {
    paddingVertical: 8,
    paddingHorizontal: 18,
    borderRadius: 6,
    marginLeft: 12
  },

  /* modal */
  modal: { justifyContent: 'center', alignItems: 'center' },

  /* backdrop */
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.7)',
    zIndex: 20
  },

  /* context menu styles */
  contextMenuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 1)',
    justifyContent: 'center',
    alignItems: 'center'
  },
  contextMenu: {
    borderRadius: 12,
    minWidth: 250,
    maxWidth: 300,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 4
    },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8
  },
  contextMenuHeader: {
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  contextMenuTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4
  },
  contextMenuUrl: {
    fontSize: 12,
    opacity: 0.7
  },
  contextMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  contextMenuIcon: {
    marginRight: 12
  },
  contextMenuText: {
    fontSize: 16,
    flex: 1
  }
})
