import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import {
  Keyboard,
  Platform,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  KeyboardAvoidingView,
  BackHandler,
  InteractionManager,
  ActivityIndicator
} from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { WebView, WebViewMessageEvent, WebViewNavigation } from 'react-native-webview'
import { GestureDetector } from 'react-native-gesture-handler'
import Animated, { useSharedValue, useAnimatedStyle, withTiming, runOnJS, Easing } from 'react-native-reanimated'
import Fuse from 'fuse.js'
import { Ionicons } from '@expo/vector-icons'
import { observer } from 'mobx-react-lite'
import { router } from 'expo-router'

import { useTheme } from '@/context/theme/ThemeContext'
import { useWallet } from '@/context/WalletContext'
import { WalletInterface } from '@bsv/sdk'
import { useLocalStorage } from '@/context/LocalStorageProvider'
import { useSheet, SheetProvider } from '@/context/SheetContext'
import type { Bookmark, HistoryEntry, Tab } from '@/shared/types/browser'
import {
  DEFAULT_HOMEPAGE_URL,
  kNEW_TAB_URL,
  SEARCH_ENGINES,
  DEFAULT_SEARCH_ENGINE_ID,
  safeBottomInset,
  ADDRESS_BAR_HEIGHT
} from '@/shared/constants'
import { isValidUrl, normalizeUrlForHistory } from '@/utils/generalHelpers'
import tabStore from '../stores/TabStore'
import bookmarkStore from '@/stores/BookmarkStore'
import { useTranslation } from 'react-i18next'
import { useBrowserMode } from '@/context/BrowserModeContext'

import { useWebAppManifest } from '@/hooks/useWebAppManifest'
import { buildInjectedJavaScript } from '@/utils/webview/injectedPolyfills'
import PermissionModal from '@/components/browser/PermissionModal'
import { getPermissionState } from '@/utils/permissionsManager'
import { check, request, PERMISSIONS, RESULTS } from 'react-native-permissions'
import { getPermissionScript } from '@/utils/permissionScript'
import { createWebViewMessageRouter } from '@/utils/webview/messageRouter'
import { handleUrlDownload, cleanupDownloadsCache } from '@/utils/webview/downloadHandler'
import { captureThumbnail, cleanupOrphanedThumbnails, thumbnailExists } from '@/utils/thumbnailService'
import { nativeSpoofSetup, mediaSourcePolyfill } from '@/utils/webview/mediaSourcePolyfill'
import { buildCWIProviderScript } from '@/utils/webview/cwiProvider'
import { getPaymentHandler } from '@/utils/webview/bsvPaymentHandler'
import { getErrorPage, getNativeErrorInfo, paymentLoadingPage } from '@/utils/webview/errorPages'

import { AddressBar } from '@/components/browser/AddressBar'
import { GlassPill, useGlassColors } from '@/components/browser/GlassPill'
import { MenuPopover } from '@/components/browser/MenuPopover'
import { HistoryPopover } from '@/components/browser/HistoryPopover'
import { TabsOverview } from '@/components/browser/TabsOverview'
import { SuggestionsDropdown } from '@/components/browser/SuggestionsDropdown'
import { SheetRouter } from '@/components/browser/SheetRouter'
import { FindInPageBar } from '@/components/browser/FindInPageBar'
import { BlurChrome } from '@/components/ui/BlurChrome'
import { spacing, radii, typography } from '@/context/theme/tokens'

import { useHistory } from '@/hooks/useHistory'
import { useAddressBarAnimation } from '@/hooks/useAddressBarAnimation'
import { usePermissions } from '@/hooks/usePermissions'

/* -------------------------------------------------------------------------- */
/*                                   CONSTS                                   */
/* -------------------------------------------------------------------------- */

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

/**
 * Builds a small injection script that exposes the current browser chrome
 * safe area insets (including address-bar reservations) to the web page via
 * CSS custom properties, a global object, and a CustomEvent.
 *
 *   padding-bottom: calc(
 *     env(safe-area-inset-bottom) +
 *     var(--browser-safe-area-inset-bottom, 0px)
 *   );
 *
 * The bottom value is driven by `bottomReservedHeight` (coordinated name with
 * the measurement agent responsible for precise on-layout / keyboard /
 * orientation measurements). Re-dispatch of the event and updates to
 * window.__browserSafeAreaInsets.bottom occur on every call (initial load,
 * bar reposition, measurement change, orientation, keyboard).
 *
 * The generated script is resilient (inner try/catch) and idempotent
 * (repeated sets / dispatches are harmless).
 */
function buildBrowserSafeAreaScript(bottomReservedHeight: number, topReservedHeight: number) {
  return `
    (function(){
      try {
        var root = document.documentElement;
        root.style.setProperty('--browser-safe-area-inset-bottom', '${bottomReservedHeight}px');
        root.style.setProperty('--browser-safe-area-inset-top', '${topReservedHeight}px');
        root.style.setProperty('--browser-address-bar-height', '${ADDRESS_BAR_HEIGHT}px');

        // Expose current values for JS access (precise measured bottomReservedHeight)
        window.__browserSafeAreaInsets = { bottom: ${bottomReservedHeight}, top: ${topReservedHeight} };

        // Notify any listeners (pages can addEventListener('browser-safe-area-change', ...))
        window.dispatchEvent(new CustomEvent('browser-safe-area-change', {
          detail: window.__browserSafeAreaInsets
        }));
      } catch (e) {}
    })();
  `
}

/* -------------------------------------------------------------------------- */
/*                               USER AGENTS                                  */
/* -------------------------------------------------------------------------- */

const MOBILE_UA_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1'
const MOBILE_UA_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
const DESKTOP_UA_IOS =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15'
const DESKTOP_UA_ANDROID =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/* -------------------------------------------------------------------------- */
/*                                  BROWSER                                   */
/* -------------------------------------------------------------------------- */

const Browser = observer(function Browser() {
  /* --------------------------- theme / basic hooks -------------------------- */
  const { isDark, colors } = useTheme()
  const gc = useGlassColors()
  const insets = useSafeAreaInsets()
  const { t, i18n } = useTranslation()
  const { isWeb2Mode } = useBrowserMode()
  const sheet = useSheet()

  // Safe bottom inset: on Android, enforce a minimum to keep UI above OS nav bar
  // even when safe-area-context reports 0 on some devices
  const bottomInset = safeBottomInset(insets.bottom)

  const webviewContainerRef = useRef<View>(null)
  const thumbnailCaptureTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    tabStore.initializeTabs().then(() => {
      const ids = tabStore.tabs.map(t => t.id)
      cleanupOrphanedThumbnails(ids)
      // Validate persisted thumbnail URIs still exist on disk
      for (const tab of tabStore.tabs) {
        if (tab.thumbnailUri && !thumbnailExists(tab.thumbnailUri)) {
          tab.thumbnailUri = undefined
        }
      }
    })
    cleanupDownloadsCache()
  }, [])

  /* ----------------------------- language headers ----------------------------- */
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
  const { managers, walletBuilding } = useWallet()
  const [wallet, setWallet] = useState<WalletInterface | undefined>()
  const paymentHandlerRef = useRef<any>(null)
  const paymentInFlightUrl = useRef<string | null>(null)
  useEffect(() => {
    if (!isWeb2Mode && managers?.walletManager?.authenticated) {
      setWallet(managers.walletManager)
      paymentHandlerRef.current = getPaymentHandler(managers.walletManager)
    } else if (isWeb2Mode) {
      setWallet(undefined)
      paymentHandlerRef.current = null
    }
  }, [managers, isWeb2Mode])

  /* ---------------------------- storage helpers ----------------------------- */
  const { getItem, setItem } = useLocalStorage()

  /* -------------------------------- history -------------------------------- */
  const { history, pushHistory, removeHistoryItem, clearHistory: clearHistoryOnly } = useHistory(getItem, setItem)
  const clearHistory = useCallback(async () => {
    await clearHistoryOnly()
    paymentHandlerRef.current?.clearCache()
  }, [clearHistoryOnly])

  /* -------------------------------- bookmarks ------------------------------- */
  const [homepageUrl, setHomepageUrlState] = useState(DEFAULT_HOMEPAGE_URL)
  const searchEngineTemplate = useRef(SEARCH_ENGINES.find(e => e.id === DEFAULT_SEARCH_ENGINE_ID)!.urlTemplate)

  useEffect(() => {
    const load = async () => {
      try {
        const storedHomepage = await getItem('homepageUrl')
        if (storedHomepage) setHomepageUrlState(storedHomepage)
        const storedEngine = await getItem('searchEngineId')
        if (storedEngine) {
          const engine = SEARCH_ENGINES.find(e => e.id === storedEngine)
          if (engine) searchEngineTemplate.current = engine.urlTemplate
        }
      } catch {}
    }
    load()
  }, [getItem])

  // Re-read search engine preference when the settings sheet closes
  useEffect(() => {
    if (sheet.isOpen) return
    ;(async () => {
      try {
        const storedEngine = await getItem('searchEngineId')
        if (storedEngine) {
          const engine = SEARCH_ENGINES.find(e => e.id === storedEngine)
          if (engine) searchEngineTemplate.current = engine.urlTemplate
        }
      } catch {}
    })()
  }, [sheet.isOpen, getItem])

  const addBookmark = useCallback((title: string, url: string) => {
    if (url && url !== kNEW_TAB_URL && isValidUrl(url) && !url.includes('about:blank')) {
      bookmarkStore.addBookmark(title, url)
    }
  }, [])

  /* ---------------------------------- tabs --------------------------------- */
  const activeTab = tabStore.activeTab

  const captureActiveThumbnail = useCallback(async () => {
    if (!activeTab || activeTab.url === kNEW_TAB_URL) return
    const uri = await captureThumbnail(webviewContainerRef, activeTab.id)
    if (uri) tabStore.updateTab(activeTab.id, { thumbnailUri: uri })
  }, [activeTab])

  /* -------------------------- ui / animation state -------------------------- */
  const addressEditing = useRef(false)
  const [addressText, setAddressText] = useState(kNEW_TAB_URL)
  const [addressFocused, setAddressFocused] = useState(false)
  const [addressSuggestions, setAddressSuggestions] = useState<(HistoryEntry | Bookmark)[]>([])

  const addressInputRef = useRef<TextInput>(null)

  // Collapse ref + stable callback declared BEFORE the hook so the function
  // identity is defined at the call site (avoids TDZ → undefined → no-op default).
  const collapseRef = useRef<() => void>(() => {})
  const requestCollapseAddressBar = useCallback(() => {
    collapseRef.current()
  }, [])

  // Tracks whether the bar's collapse-exit animation is still in flight.
  // Lets us keep the bar's <Animated.View> mounted (and animating its fade
  // + scale on the UI thread) AFTER addressBarCollapsed has flipped to true,
  // so the bar's exit and the dot's entrance overlap visually.
  const [barExitAnimating, setBarExitAnimating] = useState(false)

  const handleCollapseAnimationEnd = useCallback(() => {
    setBarExitAnimating(false)
  }, [])

  const {
    keyboardVisible,
    addressBarPanGesture,
    animatedAddressBarStyle,
    animatedMenuPopoverStyle,
    animatedCollapsedDotStyle,
    addressBarIsAtTop,
    resetGestureState
  } = useAddressBarAnimation(
    insets,
    addressFocused,
    addressEditing,
    addressInputRef,
    setAddressFocused,
    setAddressSuggestions,
    requestCollapseAddressBar,
    handleCollapseAnimationEnd
  )

  const [showTabsView, setShowTabsView] = useState(false)

  // Menu popover visibility — driven by a shared value so the open/close
  // animation runs entirely on the UI thread (and stays smooth even while the
  // JS thread is blocked, e.g. parsing large BEEF payloads). React state
  // (menuPopoverOpen) controls mount; the close-side unmount only fires AFTER
  // the close animation completes via runOnJS in the withTiming callback.
  // The setMenuPopoverOpen(open) API is preserved so callers don't change.
  const [menuPopoverOpen, _setMenuPopoverMounted] = useState(false)
  const menuPopoverProgress = useSharedValue(0)
  const setMenuPopoverOpen = useCallback((open: boolean) => {
    if (open) {
      _setMenuPopoverMounted(true)
      menuPopoverProgress.value = withTiming(1, {
        duration: 180,
        easing: Easing.out(Easing.cubic)
      })
    } else {
      menuPopoverProgress.value = withTiming(
        0,
        { duration: 160, easing: Easing.in(Easing.cubic) },
        finished => {
          if (finished) {
            runOnJS(_setMenuPopoverMounted)(false)
          }
        }
      )
    }
  }, [menuPopoverProgress])
  // Opacity-only fade driven on the UI thread.
  // Note: we deliberately do NOT include a transform here, since this style is
  // composed with `animatedMenuPopoverStyle` (which owns translateY based on the
  // address-bar position). In React Native style merge, `transform` is replaced
  // wholesale by later entries — so adding scale here would clobber translateY.
  const animatedMenuVisibilityStyle = useAnimatedStyle(() => ({
    opacity: menuPopoverProgress.value
  }))

  // HistoryPopover visibility — driven by a shared value so open/close runs
  // entirely on the UI thread (same pattern as MenuPopover above). React state
  // (historyPopoverDirection) controls mount + which side ('back' | 'forward'
  // | null); the close-side unmount only fires AFTER the close animation
  // completes via runOnJS in the withTiming callback.
  const [historyPopoverDirection, _setHistoryPopoverDirectionMounted] = useState<'back' | 'forward' | null>(null)
  const historyPopoverProgress = useSharedValue(0)
  const setHistoryPopoverDirection = useCallback((next: 'back' | 'forward' | null) => {
    if (next !== null) {
      _setHistoryPopoverDirectionMounted(next)
      historyPopoverProgress.value = withTiming(1, {
        duration: 180,
        easing: Easing.out(Easing.cubic)
      })
    } else {
      historyPopoverProgress.value = withTiming(
        0,
        { duration: 160, easing: Easing.in(Easing.cubic) },
        finished => {
          if (finished) {
            runOnJS(_setHistoryPopoverDirectionMounted)(null)
          }
        }
      )
    }
  }, [historyPopoverProgress])
  const historyPopoverOpen = historyPopoverDirection !== null
  // Opacity-only fade for the popover wrapper. Composed with
  // animatedMenuPopoverStyle (which owns translateY based on the address-bar
  // position) — keep transforms out of this style so the merge doesn't
  // clobber translateY (see MenuPopover note for the same gotcha).
  const animatedHistoryVisibilityStyle = useAnimatedStyle(() => ({
    opacity: historyPopoverProgress.value
  }))
  const desktopModeCooldown = useRef(false)

  /* ------------------------------ find in page ----------------------------- */
  const [findInPageVisible, setFindInPageVisible] = useState(false)
  const [findInPageQuery, setFindInPageQuery] = useState('')
  const [findInPageCurrent, setFindInPageCurrent] = useState(0)
  const [findInPageTotal, setFindInPageTotal] = useState(0)
  const [findInPageCapped, setFindInPageCapped] = useState(false)

  const { fetchManifest, getStartUrl, shouldRedirectToStartUrl } = useWebAppManifest()
  const [isFullscreen, setIsFullscreen] = useState(false)

  // Address bar collapse state (new gesture: rightward hold+swipe collapses bar into the ... button)
  const [addressBarCollapsed, setAddressBarCollapsed] = useState(false)
  // Remember where the bar was before collapsing so we can restore the position on expand
  const positionBeforeCollapse = useRef<'top' | 'bottom'>('bottom')

  const collapseAddressBar = useCallback(() => {
    if (addressBarIsAtTop) {
      // For now we only support collapsing when the bar is at the bottom (most useful)
      return
    }
    positionBeforeCollapse.current = 'bottom'
    // Flip JS state immediately (dot mounts at progress=0 and fades in via the
    // shared collapse-progress), and keep the bar wrapper mounted briefly via
    // barExitAnimating so its UI-thread fade/scale finishes on screen.
    //
    // Do NOT call resetGestureState() here — that would zero
    // addressBarCollapseProgress mid-animation, fighting the in-flight
    // withTiming(progress, 1) on the UI thread.
    setBarExitAnimating(true)
    setAddressBarCollapsed(true)
  }, [addressBarIsAtTop])

  const expandAddressBar = useCallback(() => {
    setAddressBarCollapsed(false)
    // Just in case the exit-end callback didn't fire (e.g. cancelled animation),
    // make sure the bar's exit-mount flag is cleared so we don't have a ghost
    // wrapper layered behind the freshly re-mounted real bar.
    setBarExitAnimating(false)
    // Reset gesture/translate state so the re-mounted bar starts in a known
    // position and the collapse guard is cleared. Prevents "stuck closed"
    // and freezes when collapse fired mid-gesture before onFinalize ran.
    resetGestureState()
  }, [resetGestureState])

  // Keep the ref up to date so runOnJS always calls the latest version (avoids stale closures)
  useEffect(() => {
    collapseRef.current = collapseAddressBar
  }, [collapseAddressBar])

  /**
   * Approach A: When the address bar is positioned at the bottom, inset the
   * WebView content area from the bottom so that fixed/sticky elements on
   * websites (nav bars, banners, etc.) do not get visually overlapped by
   * the address bar. The WebView viewport shrinks instead of the bar being
   * a floating overlay on top of full-height content.
   */
  // Tunable visual compensation (in pixels) for any slight "overhang" of the frosted glass
  // (blur radius, border, shadow, or perceived height of the pill). Start at 0.
  // Increase if the red block on the WebKit demo still sits a pixel or two below the bar.
  const BOTTOM_CHROME_VISUAL_EXTRA = 0;

  /**
   * The authoritative height (from device bottom) that must be reserved for the address bar
   * when it is positioned at the bottom.
   *
   * We use the *exact same math* the animation hook already uses to place the bar.
   * This guarantees the red safe-area visualization on
   * https://webkit.org/demos/safe-area-insets/safe-areas.html will have its bottom edge
   * sit flush against the top edge of the frosted address bar.
   */
  const bottomReservedHeight = !addressBarIsAtTop && !isFullscreen
    ? safeBottomInset(insets.bottom) + ADDRESS_BAR_HEIGHT + BOTTOM_CHROME_VISUAL_EXTRA
    : 0;

  // Memoize WebView prop objects so identical values don't churn new refs
  // each Browser re-render. Without this, every state change (menuPopoverOpen
  // toggle, suggestions list, gesture-driven address bar position state, etc.)
  // produces a new contentInset/scrollIndicatorInsets reference. RN-WebView
  // forwards inline object props to the bridge on each diff, triggering
  // WKWebView contentInset updates and a full UIScrollView re-layout. On
  // heavy pages that cascade was stalling the JS bridge for several seconds.
  const webviewContentInset = useMemo(
    () => ({ top: 0, left: 0, bottom: bottomReservedHeight, right: 0 }),
    [bottomReservedHeight]
  )
  const webviewScrollIndicatorInsets = useMemo(
    () => ({
      top: addressBarIsAtTop ? ADDRESS_BAR_HEIGHT : 0,
      bottom: addressBarIsAtTop ? bottomInset : bottomReservedHeight,
      left: 0,
      right: 0
    }),
    [addressBarIsAtTop, bottomReservedHeight, bottomInset]
  )
  const webviewContainerStyle = useMemo(
    () => ({ backgroundColor: isDark ? '#000' : '#fff' }),
    [isDark]
  )
  const webviewStyle = useMemo(() => ({ flex: 1 }), [])

  const activeCameraStreams = useRef<Set<string>>(new Set())
  const historyDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (historyDebounceTimer.current) clearTimeout(historyDebounceTimer.current)
      if (thumbnailCaptureTimer.current) clearTimeout(thumbnailCaptureTimer.current)
    }
  }, [])

  /* ------------------ Push browser safe-area CSS vars to web content -------- */
  // Track last-injected values so we skip redundant injections on re-renders
  // that don't actually change the safe-area numbers (e.g. menu popover open,
  // suggestion list updates). Re-injection on stale state used to fire on
  // every Browser re-render that touched any dep, even when bottom/top hadn't
  // moved — contributing to the WKWebView main-thread stalls.
  const lastInjectedInsets = useRef<{ bottom: number; top: number; tabId: number | null } | null>(null)
  useEffect(() => {
    const webview = activeTab?.webviewRef?.current
    if (!webview || activeTab?.url === kNEW_TAB_URL) return

    const bottom = bottomReservedHeight
    const top = addressBarIsAtTop && !isFullscreen ? ADDRESS_BAR_HEIGHT : 0
    const tabId = activeTab?.id ?? null

    const prev = lastInjectedInsets.current
    if (prev && prev.bottom === bottom && prev.top === top && prev.tabId === tabId) return
    lastInjectedInsets.current = { bottom, top, tabId }

    try {
      webview.injectJavaScript(buildBrowserSafeAreaScript(bottom, top))
    } catch {
      // WebView may be transiently unavailable (unmount, etc.); safe to ignore
    }
  }, [addressBarIsAtTop, isFullscreen, bottomReservedHeight, activeTab?.id, activeTab?.url])

  /* -------------------------------- permissions ----------------------------- */
  const domainForUrl = useCallback((u: string): string => {
    try {
      if (u === kNEW_TAB_URL) return ''
      const { hostname } = new URL(u)
      return hostname
    } catch {
      return u
    }
  }, [])

  const {
    permissionModalVisible,
    pendingPermission,
    pendingDomain,
    permissionsDeniedForCurrentDomain,
    onDecision,
    handlePermissionChange,
    permissionRouterConfig
  } = usePermissions(activeTab, domainForUrl)

  /* -------------------------------------------------------------------------- */
  /*                                INITIAL SETUP                               */
  /* -------------------------------------------------------------------------- */

  // Safety: ensure at least one tab
  useEffect(() => {
    if (tabStore.isInitialized && !activeTab) {
      tabStore.newTab()
      Keyboard.dismiss()
      setAddressFocused(false)
    }
  }, [activeTab])

  // When true, the next blank tab will skip homepage navigation (e.g. user explicitly opened new tab)
  const skipHomepageOnce = useRef(false)

  // When true, focus and highlight the address bar after the next homepage navigation
  const focusAddressBarOnNewTab = useRef(false)

  // The tab ID of a tab opened via the new tab button that can be "cancelled" (closed to go back)
  const cancelableNewTabId = useRef<number | null>(null)

  // Navigate to homepage whenever a blank tab becomes active
  useEffect(() => {
    if (!activeTab || activeTab.url !== kNEW_TAB_URL) return
    if (skipHomepageOnce.current) {
      skipHomepageOnce.current = false
      return
    }
    const shouldFocusAddressBar = focusAddressBarOnNewTab.current
    focusAddressBarOnNewTab.current = false
    ;(async () => {
      const stored = await getItem('homepageUrl')
      const url = stored || DEFAULT_HOMEPAGE_URL
      if (url && url !== kNEW_TAB_URL && url !== 'about:blank') {
        tabStore.updateTab(tabStore.activeTabId, { url })
        setAddressText(url)
        setHomepageUrlState(url)
        if (shouldFocusAddressBar) {
          setTimeout(() => {
            addressEditing.current = true
            setAddressFocused(true)
            addressInputRef.current?.focus()
            setTimeout(() => {
              addressInputRef.current?.setNativeProps({
                selection: { start: 0, end: url.length }
              })
            }, 0)
          }, 150)
        }
      }
    })()
  }, [activeTab?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-focus on new tab (only if still blank — homepage navigation may have kicked in)
  useEffect(() => {
    if (activeTab && activeTab.url === kNEW_TAB_URL && !addressFocused) {
      const tabId = activeTab.id
      const timer = setTimeout(() => {
        if (tabStore.activeTab?.id === tabId && tabStore.activeTab?.url === kNEW_TAB_URL) {
          addressInputRef.current?.focus()
        }
      }, 100)
      return () => clearTimeout(timer)
    }
  }, [activeTab, activeTab?.id, activeTab?.url, addressFocused])

  // Sync address text with tab url
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

  /* -------------------------------------------------------------------------- */
  /*                                 UTILITIES                                  */
  /* -------------------------------------------------------------------------- */

  const updateActiveTab = useCallback((patch: Partial<Tab>) => {
    const raw = patch.url?.trim()
    if (raw) {
      if (!isValidUrl(raw)) {
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
  }, [])

  /* -------------------------------------------------------------------------- */
  /*                              ADDRESS HANDLING                              */
  /* -------------------------------------------------------------------------- */

  const onAddressSubmit = useCallback(() => {
    let entry = addressText.trim()
    const hasProtocol = /^[a-z]+:\/\//i.test(entry)
    const isIpAddress = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/i.test(entry)
    const isProbablyUrl = hasProtocol || /^(www\.|([A-Za-z0-9\-]+\.)+[A-Za-z]{2,})(\/|$)/i.test(entry) || isIpAddress

    if (entry === '') {
      entry = kNEW_TAB_URL
    } else if (!isProbablyUrl) {
      entry = searchEngineTemplate.current.replace('%s', encodeURIComponent(entry))
    } else if (!hasProtocol) {
      entry = isIpAddress ? 'http://' + entry : 'https://' + entry
    }

    if (!isValidUrl(entry)) entry = kNEW_TAB_URL
    updateActiveTab({ url: entry })
    addressEditing.current = false
    cancelableNewTabId.current = null
  }, [addressText, updateActiveTab])

  /* -------------------------------------------------------------------------- */
  /*                          ADDRESS BAR AUTOCOMPLETE                          */
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

  const onChangeAddressText = useCallback((txt: string) => {
    setAddressText(txt)
    if (txt.trim().length === 0) {
      setAddressSuggestions([])
      return
    }
    const results = fuseRef.current
      .search(txt)
      .slice(0, 10)
      .map(r => r.item)
    const uniqueResults = results
      .filter((item, index, self) => index === self.findIndex(t => t.url === item.url))
      .slice(0, 5)
    setAddressSuggestions(uniqueResults)
  }, [])

  /* -------------------------------------------------------------------------- */
  /*                               TAB NAVIGATION                              */
  /* -------------------------------------------------------------------------- */
  const navBack = useCallback(() => {
    const currentTab = tabStore.activeTab
    if (currentTab?.canGoBack) tabStore.goBack(currentTab.id)
  }, [])

  const navBackLongPress = useCallback(() => {
    const currentTab = tabStore.activeTab
    if (!currentTab) return
    const { entries, currentIndex } = tabStore.getNavigationHistory(currentTab.id)
    // Only open if there's at least one back entry that isn't the new-tab sentinel
    const hasBack = entries.some((e, i) => i < currentIndex && e.url !== 'about:blank' && !e.url.includes('new-tab'))
    if (hasBack) setHistoryPopoverDirection('back')
  }, [])

  const navForward = useCallback(() => {
    const currentTab = tabStore.activeTab
    if (currentTab?.canGoForward) tabStore.goForward(currentTab.id)
  }, [])

  const navForwardLongPress = useCallback(() => {
    const currentTab = tabStore.activeTab
    if (!currentTab) return
    const { entries, currentIndex } = tabStore.getNavigationHistory(currentTab.id)
    const hasForward = entries.some((e, i) => i > currentIndex && e.url !== 'about:blank' && !e.url.includes('new-tab'))
    if (hasForward) setHistoryPopoverDirection('forward')
  }, [])

  const onSelectHistoryEntry = useCallback((index: number) => {
    const currentTab = tabStore.activeTab
    if (currentTab) tabStore.navigateToHistoryIndex(currentTab.id, index)
    setHistoryPopoverDirection(null)
  }, [])

  const navReloadOrStop = useCallback(() => {
    const currentTab = tabStore.activeTab
    if (!currentTab) return
    if (currentTab.isLoading) {
      currentTab.webviewRef?.current?.stopLoading()
    } else {
      currentTab.webviewRef?.current?.reload()
    }
  }, [])

  const shareCurrent = useCallback(async () => {
    const currentTab = tabStore.activeTab
    if (!currentTab) return
    try {
      await Share.share({ message: currentTab.url })
    } catch {}
  }, [])

  /* -------------------------------------------------------------------------- */
  /*                              FIND IN PAGE                                  */
  /* -------------------------------------------------------------------------- */

  /**
   * Find-in-page uses the CSS Custom Highlight API when available (iOS 17.2+,
   * Android WebView 105+). This paints highlights at the rendering layer
   * without modifying the DOM — zero layout shifts, zero style conflicts.
   *
   * The state stored on window:
   *   __bsvFindRanges : Range[]   – every match range
   *   __bsvFindIdx    : number    – index of the active match
   */

  /** Clear all find highlights (CSS Highlight API). */
  const CLEAR_FIND_JS = `
    if(typeof CSS!=='undefined'&&CSS.highlights){
      CSS.highlights.delete('__bsv_find');
      CSS.highlights.delete('__bsv_find_active');
    }
    window.__bsvFindRanges=null;
    window.__bsvFindIdx=0;
    if(window.__bsvFindSheet){
      var idx=document.adoptedStyleSheets.indexOf(window.__bsvFindSheet);
      if(idx>=0){var a=Array.from(document.adoptedStyleSheets);a.splice(idx,1);document.adoptedStyleSheets=a;}
      window.__bsvFindSheet=null;
    }`

  const findInPageScript = useCallback(
    (query: string) => {
      if (!activeTab?.webviewRef?.current) return
      if (!query) {
        activeTab.webviewRef.current.injectJavaScript(`(function(){
          ${CLEAR_FIND_JS}
          window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({
            type:'FIND_IN_PAGE_RESULT',current:0,total:0
          }));
        })();true;`)
        return
      }
      const escaped = query
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029')
      activeTab.webviewRef.current.injectJavaScript(`(function(){
        try{
          ${CLEAR_FIND_JS}

          // Check for CSS Custom Highlight API support
          var hasHighlightAPI=typeof CSS!=='undefined'&&typeof CSS.highlights!=='undefined'&&typeof Highlight!=='undefined';
          if(!hasHighlightAPI){
            window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({
              type:'FIND_IN_PAGE_RESULT',current:0,total:0,error:'no_highlight_api'
            }));
            return;
          }

          // Inject styles via adoptedStyleSheets (bypasses CSP)
          if(!window.__bsvFindSheet){
            var sheet=new CSSStyleSheet();
            sheet.replaceSync('::highlight(__bsv_find){background-color:rgba(255,210,0,0.4);}::highlight(__bsv_find_active){background-color:rgba(255,150,0,0.6);}');
            window.__bsvFindSheet=sheet;
            document.adoptedStyleSheets=[].concat(Array.from(document.adoptedStyleSheets),[sheet]);
          }

          var MAX_MATCHES=1000;
          var query='${escaped}'.toLowerCase();
          if(!query){
            window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({
              type:'FIND_IN_PAGE_RESULT',current:0,total:0
            }));
            return;
          }
          var qLen=query.length;

          // Walk text nodes and collect Range objects — no DOM modification
          var ranges=[];
          var capped=false;
          var walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,{
            acceptNode:function(n){
              var tag=n.parentElement&&n.parentElement.tagName;
              if(tag==='SCRIPT'||tag==='STYLE'||tag==='NOSCRIPT')return NodeFilter.FILTER_REJECT;
              return NodeFilter.FILTER_ACCEPT;
            }
          },false);
          while(walker.nextNode()){
            var node=walker.currentNode;
            var text=(node.textContent||'').toLowerCase();
            var pos=0;
            while((pos=text.indexOf(query,pos))!==-1){
              var r=new Range();
              r.setStart(node,pos);
              r.setEnd(node,pos+qLen);
              ranges.push(r);
              pos+=qLen;
              if(ranges.length>=MAX_MATCHES){capped=true;break;}
            }
            if(capped)break;
          }

          window.__bsvFindRanges=ranges;
          window.__bsvFindIdx=0;

          if(ranges.length>0){
            CSS.highlights.set('__bsv_find',new Highlight(...ranges));
            CSS.highlights.set('__bsv_find_active',new Highlight(ranges[0]));
            // Scroll to first match using Selection (no DOM modification)
            var sel=window.getSelection();
            sel.removeAllRanges();
            var scrollRange=ranges[0].cloneRange();
            scrollRange.collapse(true);
            sel.addRange(scrollRange);
            var active=document.activeElement;
            if(active&&active.blur)active.blur();
            sel.removeAllRanges();
          }

          var total=capped?MAX_MATCHES:ranges.length;
          window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({
            type:'FIND_IN_PAGE_RESULT',
            current:ranges.length>0?1:0,
            total:total,
            capped:capped
          }));
        }catch(e){
          window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({
            type:'FIND_IN_PAGE_RESULT',current:0,total:0,error:e.message
          }));
        }
      })();true;`)
    },
    [activeTab]
  )

  const findInPageNavigate = useCallback(
    (direction: 'next' | 'prev') => {
      if (!activeTab?.webviewRef?.current) return
      activeTab.webviewRef.current.injectJavaScript(`(function(){
        var ranges=window.__bsvFindRanges;
        if(!ranges||ranges.length===0||typeof CSS==='undefined'||!CSS.highlights)return;
        var idx=window.__bsvFindIdx||0;
        idx=${direction === 'next' ? '(idx+1)%ranges.length' : '(idx-1+ranges.length)%ranges.length'};
        window.__bsvFindIdx=idx;
        CSS.highlights.set('__bsv_find_active',new Highlight(ranges[idx]));
        // Scroll into view using Selection API (no DOM modification)
        try{
          var sel=window.getSelection();
          sel.removeAllRanges();
          var scrollRange=ranges[idx].cloneRange();
          scrollRange.collapse(true);
          sel.addRange(scrollRange);
          var el=document.createElement('span');
          scrollRange.insertNode(el);
          el.scrollIntoView({block:'center'});
          el.parentNode.removeChild(el);
          sel.removeAllRanges();
        }catch(e){}
        window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({
          type:'FIND_IN_PAGE_RESULT',current:idx+1,total:ranges.length
        }));
      })();true;`)
    },
    [activeTab]
  )

  const closeFindInPageRef = useRef<() => void>(() => {})

  const closeFindInPage = useCallback(() => {
    setFindInPageVisible(false)
    setFindInPageQuery('')
    setFindInPageCurrent(0)
    setFindInPageTotal(0)
    setFindInPageCapped(false)
    if (activeTab?.webviewRef?.current) {
      activeTab.webviewRef.current.injectJavaScript(`(function(){
        ${CLEAR_FIND_JS}
      })();true;`)
    }
  }, [activeTab])

  closeFindInPageRef.current = closeFindInPage

  const findInPageVisibleRef = useRef(false)
  findInPageVisibleRef.current = findInPageVisible

  /** Debounce timer for find-in-page queries */
  const findDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onFindInPageQueryChange = useCallback(
    (text: string) => {
      setFindInPageQuery(text)
      if (findDebounceRef.current) clearTimeout(findDebounceRef.current)
      findDebounceRef.current = setTimeout(() => {
        findInPageScript(text)
      }, 250)
    },
    [findInPageScript]
  )

  // Close find-in-page when the active tab changes
  useEffect(() => {
    if (findInPageVisibleRef.current) {
      closeFindInPageRef.current()
    }
  }, [activeTab?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  /* -------------------------------------------------------------------------- */
  /*                           WEBVIEW MESSAGE HANDLER                          */
  /* -------------------------------------------------------------------------- */

  const injectedJavaScript = useMemo(
    () => buildInjectedJavaScript(getAcceptLanguageHeader(), Platform.OS === 'android'),
    [getAcceptLanguageHeader]
  )

  // Standalone blob download intercept — plain JS string injected before content loads.
  // Must NOT rely on the polyfill (different WKWebView content world on iOS).
  const downloadInterceptScript = `(function(){
    if(window.__blobDL) return;
    window.__blobDL=true;
    var reg=new Map();
    window.__blobReg=reg;
    var oc=URL.createObjectURL;
    URL.createObjectURL=function(o){
      var u=oc.call(URL,o);
      if(o instanceof Blob) reg.set(u,o);
      return u;
    };
    try{Object.defineProperty(URL.createObjectURL,'toString',{value:function(){return'function createObjectURL() { [native code] }'},writable:false,configurable:false});Object.defineProperty(URL.createObjectURL,'name',{value:'createObjectURL',configurable:true})}catch(e){}
    try{window.__spoofNative&&window.__spoofNative(URL.createObjectURL,'createObjectURL')}catch(e){}
    var or=URL.revokeObjectURL;
    URL.revokeObjectURL=function(u){
      setTimeout(function(){reg.delete(u);},30000);
      return or.call(URL,u);
    };
    try{Object.defineProperty(URL.revokeObjectURL,'toString',{value:function(){return'function revokeObjectURL() { [native code] }'},writable:false,configurable:false});Object.defineProperty(URL.revokeObjectURL,'name',{value:'revokeObjectURL',configurable:true})}catch(e){}
    try{window.__spoofNative&&window.__spoofNative(URL.revokeObjectURL,'revokeObjectURL')}catch(e){}
    var origClick=HTMLElement.prototype.click;
    HTMLElement.prototype.click=function(){
      var el=this;
      if(el.tagName==='A'){
        var href=el.href;
        if(typeof href==='string'&&href.indexOf('blob:')===0){
          var blob=reg.get(href);
          if(blob){
            var fn=el.getAttribute('download')||null;
            var rd=new FileReader();
            rd.onloadend=function(){
              if(typeof rd.result!=='string')return;
              var b64=rd.result.split(',')[1]||'';
              window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({
                type:'FILE_DOWNLOAD_BLOB',base64:b64,
                mimeType:blob.type||'application/octet-stream',filename:fn
              }));
            };
            rd.readAsDataURL(blob);
            return;
          }
        }
      }
      return origClick.call(this);
    };
    try{Object.defineProperty(HTMLElement.prototype.click,'toString',{value:function(){return'function click() { [native code] }'},writable:false,configurable:false})}catch(e){}
    try{window.__spoofNative&&window.__spoofNative(HTMLElement.prototype.click,'click')}catch(e){}
  })();true;`

  const routeWebViewMessage = useMemo(
    () =>
      createWebViewMessageRouter({
        getActiveTab: () => tabStore.activeTab,
        domainForUrl,
        getPermissionState,
        ...permissionRouterConfig,
        activeCameraStreams,
        setIsFullscreen: (v: boolean) => setIsFullscreen(v)
      }),
    [domainForUrl, permissionRouterConfig]
  )

  const handleMessage = useCallback(
    async (event: WebViewMessageEvent) => {
      if (!activeTab) return

      const sendResponseToWebView = (id: string, result: any) => {
        if (!activeTab?.webviewRef?.current) return
        const message = {
          type: 'CWI',
          id,
          isInvocation: false,
          result,
          status: 'ok'
        }
        activeTab.webviewRef.current.injectJavaScript(getInjectableJSMessage(message))
      }

      const sendErrorToWebView = (id: string, description: string, code: number = 1) => {
        if (!activeTab?.webviewRef?.current) return
        const message = {
          type: 'CWI',
          id,
          isInvocation: false,
          status: 'error',
          code,
          description
        }
        activeTab.webviewRef.current.injectJavaScript(getInjectableJSMessage(message))
      }

      let msg
      try {
        msg = JSON.parse(event.nativeEvent.data)
      } catch {
        return
      }

      if (msg.type === 'FIND_IN_PAGE_RESULT') {
        setFindInPageCurrent(msg.current ?? 0)
        setFindInPageTotal(msg.total ?? 0)
        setFindInPageCapped(!!msg.capped)
        return
      }

      if (msg.type === 'DL_DEBUG') {
        console.warn('[DL_DEBUG]', msg.info)
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

      if (msg.type === 'PAYMENT_REQUIRED' && paymentHandlerRef.current) {
        // Skip if a payment is already being handled for this URL (e.g. onHttpError already fired)
        if (paymentInFlightUrl.current === msg.url) return
        paymentInFlightUrl.current = msg.url
        if (activeTab?.webviewRef?.current) {
          activeTab.webviewRef.current.injectJavaScript(
            `document.open();document.write(\`${paymentLoadingPage.replace(/`/g, '\\`')}\`);document.close();`
          )
        }
        paymentHandlerRef.current
          .handle402(msg.url, msg.status, msg.headers || {})
          .then((html: string | null) => {
            if (html && activeTab?.webviewRef?.current) {
              activeTab.webviewRef.current.injectJavaScript(
                `document.open();document.write(\`${html.replace(/`/g, '\\`')}\`);document.close();`
              )
            }
          })
          .catch(() => {})
          .finally(() => { paymentInFlightUrl.current = null })
        return
      }

      if (await routeWebViewMessage(msg)) return

      if (msg.call && (!wallet || isWeb2Mode)) {
        if (isWeb2Mode) {
          // Web2 mode: wallet calls are not supported, send error immediately
          if (msg.type === 'CWI' && msg.id) {
            sendErrorToWebView(msg.id, 'Wallet is disabled in Web2 mode', 1)
          }
          return
        }
        if (walletBuilding) {
          // Should not normally reach here — the WebView loads about:blank
          // until the wallet is ready.  Guard just in case.
          if (msg.type === 'CWI' && msg.id) {
            sendErrorToWebView(msg.id, 'Wallet is still initializing', 1)
          }
          return
        }
        // No wallet, not building, not web2 → user has no wallet configured
        if (msg.type === 'CWI' && msg.id) {
          sendErrorToWebView(msg.id, 'Wallet is not authenticated', 1)
        }
        router.push('/auth/mnemonic')
        return
      }

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
      } catch (error: any) {
        sendErrorToWebView(msg.id, error?.message || 'unknown error', error?.code || 1)
      }
    },
    [activeTab, wallet, routeWebViewMessage, isWeb2Mode, walletBuilding]
  )

  // Reload the active tab as soon as the wallet becomes available so any
  // page that loaded before the wallet was ready gets a fresh start with
  // the CWI provider backed by a ready wallet.
  const walletBecameReady = useRef(false)
  useEffect(() => {
    if (!wallet) return
    if (walletBecameReady.current) return
    walletBecameReady.current = true
    if (activeTab?.url && activeTab.url !== kNEW_TAB_URL) {
      activeTab.webviewRef?.current?.reload()
    }
  }, [wallet, activeTab])

  /* -------------------------------------------------------------------------- */
  /*                      NAV STATE CHANGE → HISTORY TRACKING                   */
  /* -------------------------------------------------------------------------- */
  const handleNavStateChange = (navState: WebViewNavigation) => {
    if (!activeTab) return
    if (paymentInFlightUrl.current) return
    if (navState.url?.includes('favicon.ico') && activeTab.url === kNEW_TAB_URL) return

    if (
      normalizeUrlForHistory(navState.url) !== activeTab.url &&
      activeCameraStreams.current.has(activeTab.id.toString())
    ) {
      activeCameraStreams.current.delete(activeTab.id.toString())
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

    tabStore.handleNavigationStateChange(activeTab.id, navState)
    // Show the clean URL (without transient challenge tokens) in the address bar
    const cleanUrl = normalizeUrlForHistory(navState.url)
    if (!addressEditing.current) setAddressText(cleanUrl)

    // Debounce history push so that rapid onNavigationStateChange events
    // (which often carry stale titles from the *previous* page) settle before
    // we commit an entry.  Only the final event's metadata is recorded.
    if (!navState.loading && cleanUrl !== kNEW_TAB_URL) {
      if (historyDebounceTimer.current) clearTimeout(historyDebounceTimer.current)
      const url = cleanUrl
      const title = navState.title || cleanUrl
      historyDebounceTimer.current = setTimeout(() => {
        pushHistory({ title, url, timestamp: Date.now() }).catch(() => {})
        historyDebounceTimer.current = null
      }, 500)
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                              MANIFEST HANDLING                             */
  /* -------------------------------------------------------------------------- */
  useEffect(() => {
    if (!activeTab) return
    let isCancelled = false

    const handleManifest = async () => {
      if (activeTab.url === kNEW_TAB_URL || !activeTab.url.startsWith('http') || activeTab.isLoading) return
      if (isCancelled) return
      try {
        const manifestData = await fetchManifest(activeTab.url)
        if (isCancelled) return
        if (manifestData) {
          const url = new URL(activeTab.url)
          if (shouldRedirectToStartUrl(manifestData, activeTab.url) && url.pathname === '/') {
            const startUrl = getStartUrl(manifestData, activeTab.url)
            updateActiveTab({ url: startUrl })
            setAddressText(startUrl)
          }
        }
      } catch {}
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
  /*                              FULLSCREEN HANDLER                            */
  /* -------------------------------------------------------------------------- */
  useEffect(() => {
    if (isFullscreen) {
      const backHandler = () => {
        setIsFullscreen(false)
        activeTab?.webviewRef.current?.injectJavaScript(`
          window.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'FULLSCREEN_CHANGE', isFullscreen: false })
          }));
        `)
        return true
      }
      if (Platform.OS === 'android') {
        const subscription = BackHandler.addEventListener('hardwareBackPress', backHandler)
        return () => subscription.remove()
      }
    }
  }, [isFullscreen, activeTab?.webviewRef])

  /* -------------------------------------------------------------------------- */
  /*                                  RENDER                                    */
  /* -------------------------------------------------------------------------- */

  const showAddressBar = Platform.OS === 'android' ? !keyboardVisible || addressFocused : true

  const [ready, setReady] = useState(false)
  useEffect(() => {
    const handle = InteractionManager.runAfterInteractions(() => setReady(true))
    return () => handle.cancel?.()
  }, [])

  if (!tabStore.isInitialized || !ready) {
    return (
      <View style={styles.loaderContainer}>
        <ActivityIndicator size="large" />
      </View>
    )
  }

  // In web3 mode, don't render the WebView until the wallet has finished
  // building so the page never issues CWI calls before the wallet can
  // handle them.
  const walletReady = isWeb2Mode || !walletBuilding
  const uri = typeof activeTab?.url === 'string' && activeTab.url.length > 0 ? activeTab.url : 'about:blank'
  const isNewTab = activeTab?.url === kNEW_TAB_URL

  const renderMainContent = () => {
    if (isNewTab) {
      return <View style={{ flex: 1, backgroundColor: colors.background }} />
    }
    // Hold off rendering the WebView until the wallet is ready in web3 mode.
    // This prevents the page from issuing CWI calls that can't be handled yet.
    if (!walletReady) {
      return (
        <View style={[styles.loaderContainer, { backgroundColor: isDark ? '#000' : '#fff' }]}>
          <ActivityIndicator size="large" />
        </View>
      )
    }
    if (activeTab) {
      return (
        <View
          ref={webviewContainerRef}
          collapsable={false}
          style={{
            position: 'absolute',
            top: isFullscreen ? 0 : insets.top,
            left: 0,
            right: 0,
            // On Android we keep it simple: shrink the WebView frame itself when the
            // address bar is at the bottom. This avoids any visual overlap bugs.
            // People are less sensitive to "content under glass" on Android.
            bottom: Platform.OS === 'android' && !addressBarIsAtTop && !isFullscreen
              ? bottomReservedHeight
              : 0
          }}
        >
          {isFullscreen && (
            <TouchableOpacity
              style={styles.exitFullscreen}
              onPress={() => {
                setIsFullscreen(false)
                activeTab?.webviewRef.current?.injectJavaScript(`
                  window.dispatchEvent(new MessageEvent('message', {
                    data: JSON.stringify({ type: 'FULLSCREEN_CHANGE', isFullscreen: false })
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
              headers: { 'Accept-Language': getAcceptLanguageHeader() }
            }}
            userAgent={
              (activeTab?.isDesktopMode ?? false)
                ? Platform.OS === 'ios'
                  ? DESKTOP_UA_IOS
                  : DESKTOP_UA_ANDROID
                : Platform.OS === 'ios'
                  ? MOBILE_UA_IOS
                  : MOBILE_UA_ANDROID
            }
            sharedCookiesEnabled={true}
            originWhitelist={['https://*', 'http://*', 'blob:*', 'data:*', 'about:*']}
            onMessage={handleMessage}
            injectedJavaScript={injectedJavaScript}
            injectedJavaScriptBeforeContentLoaded={
              nativeSpoofSetup +
              '\n' +
              buildCWIProviderScript() +
              '\n' +
              mediaSourcePolyfill +
              '\n' +
              downloadInterceptScript +
              '\n' +
              getPermissionScript(permissionsDeniedForCurrentDomain, pendingPermission)
            }
            onNavigationStateChange={handleNavStateChange}
            allowsFullscreenVideo={true}
            mediaPlaybackRequiresUserAction={false}
            allowsInlineMediaPlayback={true}
            geolocationEnabled
            onPermissionRequest={
              Platform.OS === 'android'
                ? (event: any) => {
                    // On Android, WebView fires this when the page calls getUserMedia.
                    // Request the corresponding OS permission, then grant/deny the WebView.
                    const resources: string[] = event.nativeEvent?.resources ?? []
                    ;(async () => {
                      try {
                        const toGrant: string[] = []
                        for (const resource of resources) {
                          if (resource.includes('VIDEO_CAPTURE')) {
                            const current = await check(PERMISSIONS.ANDROID.CAMERA)
                            const granted =
                              current === RESULTS.GRANTED ||
                              (await request(PERMISSIONS.ANDROID.CAMERA)) === RESULTS.GRANTED
                            if (granted) toGrant.push(resource)
                          } else if (resource.includes('AUDIO_CAPTURE')) {
                            const current = await check(PERMISSIONS.ANDROID.RECORD_AUDIO)
                            const granted =
                              current === RESULTS.GRANTED ||
                              (await request(PERMISSIONS.ANDROID.RECORD_AUDIO)) === RESULTS.GRANTED
                            if (granted) toGrant.push(resource)
                          }
                        }
                        if (toGrant.length > 0) {
                          event.nativeEvent.request.grant(toGrant)
                        } else {
                          event.nativeEvent.request.deny()
                        }
                      } catch {
                        event.nativeEvent.request.deny()
                      }
                    })()
                  }
                : () => false
            }
            onFileDownload={
              Platform.OS === 'ios'
                ? ({ nativeEvent }: any) => {
                    handleUrlDownload(nativeEvent.downloadUrl).catch(() => {})
                  }
                : undefined
            }
            onShouldStartLoadWithRequest={(request: any) => {
              const { url: reqUrl, navigationType } = request
              // Intercept blob: and data: URLs — read from __blobReg (set by downloadInterceptScript)
              if (reqUrl.startsWith('blob:') || reqUrl.startsWith('data:')) {
                const escaped = reqUrl.replace(/'/g, "\\'")
                setTimeout(() => {
                  activeTab?.webviewRef?.current?.injectJavaScript(`(function(){
                    try{
                      var url='${escaped}';
                      var reg=window.__blobReg;
                      var blob=reg&&reg.get(url);
                      window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({
                        type:'DL_DEBUG',info:'reg='+!!reg+' blob='+!!blob+(blob?' sz='+blob.size:'')
                      }));
                      if(blob){
                        var fn=null;
                        var rd=new FileReader();
                        rd.onloadend=function(){
                          if(typeof rd.result!=='string')return;
                          var b64=rd.result.split(',')[1]||'';
                          window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({
                            type:'FILE_DOWNLOAD_BLOB',base64:b64,
                            mimeType:blob.type||'application/octet-stream',filename:fn
                          }));
                        };
                        rd.readAsDataURL(blob);
                      }
                    }catch(e){
                      window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({
                        type:'DL_DEBUG',info:'err:'+e
                      }));
                    }
                  })();true;`)
                }, 0)
                return false
              }
              // Detect direct file links triggered by user click
              if (navigationType === 'click') {
                const fileExtPattern =
                  /\.(pdf|zip|gz|tar|rar|7z|doc|docx|xls|xlsx|ppt|pptx|csv|mp3|mp4|avi|mov|dmg|exe|apk|ipa)(\?|$)/i
                if (fileExtPattern.test(reqUrl)) {
                  handleUrlDownload(reqUrl).catch(() => {})
                  return false
                }
              }
              return true
            }}
            androidLayerType="hardware"
            androidHardwareAccelerationDisabled={false}
            onError={(e: any) => {
              e.preventDefault()
              if (e.nativeEvent?.url?.includes('favicon.ico') && activeTab?.url === kNEW_TAB_URL) return
              const code = e.nativeEvent?.code
              // Only handle native network errors (negative codes: DNS, TLS, timeout, etc.)
              if (typeof code === 'number' && code < 0 && activeTab?.webviewRef?.current) {
                const info = getNativeErrorInfo(code)
                const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><style>:root{--bg:#f5f5f0;--text:#1a1a1a;--sub:#666}@media(prefers-color-scheme:dark){:root{--bg:#1a1a1a;--text:#e8e6e1;--sub:#999}}body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:var(--bg);color:var(--text);text-align:center}h1{font-size:6rem;margin:0}.subtitle{font-size:1.5rem;margin:8px 0}.detail{color:var(--sub);padding:0 24px}</style></head><body><div><h1 style="color:${info.color}">${info.code}</h1><p class="subtitle">${info.title}</p><p class="detail">${info.detail}</p></div></body></html>`
                activeTab.webviewRef.current.injectJavaScript(
                  `document.open();document.write(\`${page.replace(/`/g, '\\`')}\`);document.close();`
                )
              }
            }}
            onHttpError={(e: any) => {
              if (e.nativeEvent?.url?.includes('favicon.ico') && activeTab?.url === kNEW_TAB_URL) return
              const status = e.nativeEvent?.statusCode || 404
              const url = e.nativeEvent?.url || ''
              if (status === 402 && paymentHandlerRef.current) {
                // Skip if a payment is already being handled for this URL (e.g. fetch polyfill already fired)
                if (paymentInFlightUrl.current === url) return
                paymentInFlightUrl.current = url
                if (activeTab?.webviewRef?.current) {
                  activeTab.webviewRef.current.injectJavaScript(
                    `document.open();document.write(\`${paymentLoadingPage.replace(/`/g, '\\`')}\`);document.close();`
                  )
                }
                paymentHandlerRef.current
                  .handle402(url, 402, e.nativeEvent.headers || {})
                  .then((html: string | null) => {
                    if (html && activeTab?.webviewRef?.current) {
                      activeTab.webviewRef.current.injectJavaScript(
                        `document.open();document.write(\`${html.replace(/`/g, '\\`')}\`);document.close();`
                      )
                    } else if (activeTab?.webviewRef?.current) {
                      const fallback = getErrorPage(402)
                      activeTab.webviewRef.current.injectJavaScript(
                        `document.open();document.write(\`${fallback.replace(/`/g, '\\`')}\`);document.close();`
                      )
                    }
                  })
                  .catch(() => {
                    if (activeTab?.webviewRef?.current) {
                      const fallback = getErrorPage(402)
                      activeTab.webviewRef.current.injectJavaScript(
                        `document.open();document.write(\`${fallback.replace(/`/g, '\\`')}\`);document.close();`
                      )
                    }
                  })
                  .finally(() => { paymentInFlightUrl.current = null })
              } else if (activeTab?.webviewRef?.current) {
                // For 403, the response body is often an interactive challenge page
                // (e.g. Cloudflare human verification). Let the WebView render it
                // as-is instead of replacing it with our custom error page.
                if (status === 403) return
                const fallback = getErrorPage(status)
                activeTab.webviewRef.current.injectJavaScript(
                  `document.open();document.write(\`${fallback.replace(/`/g, '\\`')}\`);document.close();`
                )
              }
            }}
            onLoadEnd={(event: any) => {
              // Suppress state updates while 402 payment is in flight — document.write
              // of the loading page fires onLoadEnd which re-renders and flickers the
              // spending authorization modal.
              if (paymentInFlightUrl.current) return
              tabStore.handleNavigationStateChange(activeTab.id, {
                ...(event.nativeEvent ?? event),
                loading: false
              })
              // Capture thumbnail after page settles
              if (activeTab.url !== kNEW_TAB_URL) {
                if (thumbnailCaptureTimer.current) clearTimeout(thumbnailCaptureTimer.current)
                thumbnailCaptureTimer.current = setTimeout(() => captureActiveThumbnail(), 800)
              }

              // Push current browser safe area insets (CSS vars + event) to the newly loaded page.
              // Uses bottomReservedHeight (measured from the actual address bar top edge)
              // so the red block on the WebKit safe-areas demo aligns perfectly.
              if (activeTab.url !== kNEW_TAB_URL && activeTab?.webviewRef?.current) {
                const bottom = bottomReservedHeight
                const top = addressBarIsAtTop && !isFullscreen ? ADDRESS_BAR_HEIGHT : 0
                // Resilient (try/catch); the script is idempotent and always dispatches
                try {
                  activeTab.webviewRef.current.injectJavaScript(buildBrowserSafeAreaScript(bottom, top))
                } catch (e) {
                  // transient webview unavailability is ok
                }
              }
            }}
            javaScriptEnabled
            domStorageEnabled
            allowsBackForwardNavigationGestures
            automaticallyAdjustContentInsets={false}
            contentInsetAdjustmentBehavior="never"
            contentInset={webviewContentInset}
            scrollIndicatorInsets={webviewScrollIndicatorInsets}
            containerStyle={webviewContainerStyle}
            style={webviewStyle}
          />
        </View>
      )
    }
    return null
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      enabled={Platform.OS === 'ios' && addressFocused}
      behavior="padding"
      keyboardVerticalOffset={0}
    >
      <View style={[styles.container, { backgroundColor: isDark ? '#000' : '#fff' }]}>
        <StatusBar style={isDark ? 'light' : 'dark'} translucent hidden={isFullscreen} />

        {/* ---- Main content: WebView lives between the safe-area bars ---- */}
        {renderMainContent()}

        {/* Touch blocker shield (Approach A hybrid):
            - WebView frame is kept full-height so page backgrounds, heroes, and
              full-bleed visuals can paint under the frosted-glass address bar.
            - When the address bar is at the bottom, this transparent overlay
              captures touches in the bottom (safeBottom + 48px) region, preventing
              web content's fixed/sticky tappable elements from being hit "under"
              the bar while still allowing the visual background to show through.
            - On iOS, contentInset further helps the web layout engine place
              fixed elements above the bar naturally.
            - zIndex sits above WebView (0) but below chromeWrapper (20). */}
        {/* Touch blocker area — full height when bar is expanded, tiny right-corner area when collapsed */}
        {!addressBarCollapsed && bottomReservedHeight > 0 && (
          <View
            pointerEvents="auto"
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: bottomReservedHeight,
              backgroundColor: 'transparent',
              zIndex: 15
            }}
          />
        )}

        {/* Small right-side blocker when collapsed (only protects taps under the ... button) */}
        {addressBarCollapsed && (
          <View
            pointerEvents="auto"
            style={{
              position: 'absolute',
              right: spacing.md - 4,
              bottom: 0,
              width: 52,
              height: safeBottomInset(insets.bottom) + 52,
              backgroundColor: 'transparent',
              zIndex: 15,
            }}
          />
        )}

        {/* Collapsed address bar — only the ... button in bottom-right.
            Mounted as soon as addressBarCollapsed flips true (which happens
            immediately when the right-swipe gesture activates), but its
            opacity + scale are driven by the SAME shared progress value as
            the bar's exit. The dot stays invisible while the bar fades, then
            morphs in for a clean cross-fade — both styles run on the UI
            thread from a single shared value (no per-frame runOnJS). */}
        {addressBarCollapsed && !isFullscreen && (
          <Animated.View
            style={[
              {
                position: 'absolute',
                bottom: safeBottomInset(insets.bottom),
                right: spacing.md,
                zIndex: 30,
                width: 44,
                height: 44,
              },
              animatedCollapsedDotStyle,
            ]}
            pointerEvents="box-none"
          >
            <GlassPill style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
              <TouchableOpacity
                onPress={expandAddressBar}
                style={{
                  width: 44,
                  height: 44,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                activeOpacity={0.6}
              >
                <Ionicons name="ellipsis-horizontal" size={20} color={gc.accent} />
              </TouchableOpacity>
            </GlassPill>
          </Animated.View>
        )}

        {/* ---- Floating Address Bar + Popover (absolutely positioned) ----
            Stays mounted while the collapse exit animation plays (gated by
            barExitAnimating) so the bar's UI-thread fade + scale completes
            on screen before the wrapper unmounts. The GestureDetector is
            still wrapped here, but during exit-animating the bar is fading
            to opacity 0 so taps don't land on it visually. */}
        {!isFullscreen && showAddressBar && (!addressBarCollapsed || barExitAnimating) && (
          <>
            <GestureDetector gesture={addressBarPanGesture}>
              <Animated.View
                style={[styles.chromeWrapper, { top: insets.top }, animatedAddressBarStyle]}
                // Block taps during the collapse-exit animation so the fading
                // bar can't receive ghost touches before it unmounts.
                pointerEvents={addressBarCollapsed ? 'none' : 'box-none'}
              >
                <AddressBar
                  addressText={addressText}
                  addressFocused={addressFocused}
                  isLoading={activeTab?.isLoading || false}
                  canGoBack={activeTab?.canGoBack || false}
                  canGoForward={activeTab?.canGoForward || false}
                  isNewTab={isNewTab}
                  isHttps={activeTab?.url?.startsWith('https') || false}
                  menuOpen={menuPopoverOpen}
                  historyPopoverOpen={historyPopoverOpen}
                  onMorePress={() => {
                    setHistoryPopoverDirection(null)
                    setMenuPopoverOpen(true)
                  }}
                  onChangeText={onChangeAddressText}
                  onSubmit={onAddressSubmit}
                  onFocus={() => {
                    setMenuPopoverOpen(false)
                    setHistoryPopoverDirection(null)
                    addressEditing.current = true
                    setAddressFocused(true)
                    if (activeTab?.url === kNEW_TAB_URL) setAddressText('')
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
                    setAddressText(activeTab?.url || kNEW_TAB_URL)
                  }}
                  onBack={navBack}
                  onBackLongPress={navBackLongPress}
                  onForward={navForward}
                  onForwardLongPress={navForwardLongPress}
                  onReloadOrStop={navReloadOrStop}
                  onClearText={() => setAddressText('')}
                  onCancelNewTab={
                    cancelableNewTabId.current === activeTab?.id
                      ? () => {
                          const tabId = cancelableNewTabId.current!
                          cancelableNewTabId.current = null
                          Keyboard.dismiss()
                          addressEditing.current = false
                          setAddressFocused(false)
                          setAddressSuggestions([])
                          tabStore.closeTab(tabId)
                        }
                      : undefined
                  }
                  inputRef={addressInputRef}
                />
              </Animated.View>
            </GestureDetector>

            {/* ---- Suggestions ---- */}
            {addressFocused && (
              <SuggestionsDropdown
                suggestions={addressSuggestions}
                colors={colors}
                bottomOffset={bottomInset}
                onSelect={url => {
                  addressInputRef.current?.blur()
                  Keyboard.dismiss()
                  setAddressFocused(false)
                  setAddressSuggestions([])
                  setAddressText(url)
                  updateActiveTab({ url })
                  addressEditing.current = false
                  cancelableNewTabId.current = null
                }}
              />
            )}
          </>
        )}

        {/* ---- Find in Page Bar ---- */}
        {findInPageVisible && !isFullscreen && (
          <View style={{ position: 'absolute', top: insets.top, left: 0, right: 0, zIndex: 30 }}>
            <FindInPageBar
              query={findInPageQuery}
              currentMatch={findInPageCurrent}
              totalMatches={findInPageTotal}
              capped={findInPageCapped}
              onChangeQuery={onFindInPageQueryChange}
              onNext={() => findInPageNavigate('next')}
              onPrevious={() => findInPageNavigate('prev')}
              onClose={closeFindInPage}
            />
          </View>
        )}

        {/* ---- Menu Popover (full-screen layer so backdrop covers everything) ----
            Stays mounted while the close animation plays (the JS unmount only
            fires after the UI-thread fade-out completes via runOnJS callback). */}
        {menuPopoverOpen && (
          <Animated.View
            style={[
              { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 },
              animatedMenuPopoverStyle,
              animatedMenuVisibilityStyle
            ]}
          >
            <MenuPopover
              isNewTab={isNewTab}
              canShare={!isNewTab}
              addressBarAtTop={addressBarIsAtTop}
              topOffset={8}
              bottomOffset={bottomInset + 4}
              isDesktopMode={activeTab?.isDesktopMode ?? false}
              isBookmarked={!!activeTab && bookmarkStore.bookmarks.some(b => b.url === activeTab.url)}
              onDismiss={() => setMenuPopoverOpen(false)}
              onShare={shareCurrent}
              onAddBookmark={() => {
                if (activeTab && activeTab.url !== kNEW_TAB_URL && isValidUrl(activeTab.url)) {
                  addBookmark(activeTab.title || t('untitled'), activeTab.url)
                }
              }}
              onRemoveBookmark={() => {
                if (activeTab) {
                  bookmarkStore.removeBookmark(activeTab.url)
                }
              }}
              onFindInPage={() => setFindInPageVisible(true)}
              onBookmarks={() => sheet.push('browser-menu')}
              onTabs={async () => {
                await captureActiveThumbnail()
                setShowTabsView(true)
              }}
              onNewTab={() => {
                focusAddressBarOnNewTab.current = true
                tabStore.newTab()
                cancelableNewTabId.current = tabStore.activeTabId
                setShowTabsView(false)
              }}
              onSettings={() => sheet.push('settings')}
              onEnableWeb3={() => router.push('/auth/mnemonic')}
              onConnections={() => router.push('/connections')}
              onToggleDesktopMode={() => {
                if (!activeTab || desktopModeCooldown.current) return
                desktopModeCooldown.current = true
                setMenuPopoverOpen(false)
                tabStore.toggleDesktopMode(activeTab.id)
                // The native layer sets customUserAgent but does not reload automatically,
                // so we must trigger a reload explicitly after the state update propagates.
                if (activeTab.url !== kNEW_TAB_URL) {
                  setTimeout(() => {
                    activeTab.webviewRef.current?.reload()
                  }, 50)
                }
                setTimeout(() => {
                  desktopModeCooldown.current = false
                }, 1500)
              }}
            />
          </Animated.View>
        )}

        {/* ---- History Popover (full-screen layer, anchored left) ----
            Stays mounted while the close animation plays (the JS unmount only
            fires after the UI-thread fade-out completes via runOnJS callback,
            same pattern as MenuPopover). */}
        {historyPopoverOpen &&
          activeTab &&
          (() => {
            const { entries, currentIndex } = tabStore.getNavigationHistory(activeTab.id)
            return (
              <Animated.View
                style={[
                  { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 },
                  animatedMenuPopoverStyle,
                  animatedHistoryVisibilityStyle
                ]}
              >
                <HistoryPopover
                  entries={entries}
                  currentIndex={currentIndex}
                  direction={historyPopoverDirection!}
                  addressBarAtTop={addressBarIsAtTop}
                  topOffset={8}
                  bottomOffset={bottomInset + 4}
                  onDismiss={() => setHistoryPopoverDirection(null)}
                  onSelectEntry={onSelectHistoryEntry}
                />
              </Animated.View>
            )
          })()}

        {/* ---- Tabs Overview ---- */}
        {!isFullscreen && showTabsView && (
          <TabsOverview onDismiss={() => setShowTabsView(false)} setAddressFocused={setAddressFocused} />
        )}

        {/* ---- Unified Sheet System ---- */}
        <SheetRouter
          sheet={sheet}
          activeTab={activeTab}
          domainForUrl={domainForUrl}
          homepageUrl={homepageUrl}
          updateActiveTab={updateActiveTab}
          setAddressText={setAddressText}
          history={history}
          clearHistory={clearHistory}
          removeHistoryItem={removeHistoryItem}
          handlePermissionChange={handlePermissionChange}
          addBookmark={addBookmark}
        />

        {/* ---- Permission Modal ---- */}
        {pendingPermission && pendingDomain && (
          <PermissionModal
            key={pendingPermission}
            visible={permissionModalVisible}
            domain={pendingDomain}
            permission={pendingPermission}
            onDecision={onDecision}
          />
        )}
      </View>
    </KeyboardAvoidingView>
  )
})

/* -------------------------------------------------------------------------- */
/*                                   EXPORT                                   */
/* -------------------------------------------------------------------------- */

const BrowserWithSheet = observer(() => (
  <SheetProvider>
    <Browser />
  </SheetProvider>
))

export default BrowserWithSheet

/* -------------------------------------------------------------------------- */
/*                                    CSS                                     */
/* -------------------------------------------------------------------------- */

const styles = StyleSheet.create({
  loaderContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center'
  },
  container: {
    flex: 1
  },
  exitFullscreen: {
    position: 'absolute',
    top: 50,
    right: 20,
    zIndex: 1000,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 20,
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center'
  },
  chromeWrapper: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 20
  }
})
