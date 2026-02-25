
import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import {
  Animated,
  Dimensions,
  Keyboard,
  Platform,
  Pressable,
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
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import Fuse from 'fuse.js'
import { Ionicons } from '@expo/vector-icons'
import { observer } from 'mobx-react-lite'
import { router } from 'expo-router'

import { useTheme } from '@/context/theme/ThemeContext'
import { useWallet } from '@/context/WalletContext'
import { WalletInterface, LookupResolver, Transaction, Utils } from '@bsv/sdk'
import { useLocalStorage } from '@/context/LocalStorageProvider'
import { useSheet, SheetProvider } from '@/context/SheetContext'
import type { Bookmark, HistoryEntry, Tab } from '@/shared/types/browser'
import { DEFAULT_HOMEPAGE_URL } from '@/shared/constants'
import { HistoryList } from '@/components/HistoryList'
import { isValidUrl } from '@/utils/generalHelpers'
import tabStore from '../stores/TabStore'
import bookmarkStore from '@/stores/BookmarkStore'
import SettingsScreen from './settings'
import IdentityScreen from './identity'
import TrustScreen from './trust'
import { useTranslation } from 'react-i18next'
import { useBrowserMode } from '@/context/BrowserModeContext'

import { useWebAppManifest } from '@/hooks/useWebAppManifest'
import { buildInjectedJavaScript } from '@/utils/webview/injectedPolyfills'
import PermissionModal from '@/components/PermissionModal'
import PermissionsScreen from '@/components/PermissionsScreen'
import Sheet from '@/components/ui/Sheet'
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

import { AddressBar } from '@/components/browser/AddressBar'
import { TabsOverview } from '@/components/browser/TabsOverview'
import { NewTabPage } from '@/components/browser/NewTabPage'
import { MenuSheet } from '@/components/browser/MenuSheet'
import { spacing } from '@/context/theme/tokens'


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
/*                                  BROWSER                                   */
/* -------------------------------------------------------------------------- */

function Browser() {
  /* --------------------------- theme / basic hooks -------------------------- */
  const { colors, isDark } = useTheme()
  const insets = useSafeAreaInsets()
  const { t, i18n } = useTranslation()
  const { isWeb2Mode } = useBrowserMode()
  const sheet = useSheet()

  useEffect(() => {
    tabStore.initializeTabs()
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
  const { managers } = useWallet()
  const [wallet, setWallet] = useState<WalletInterface | undefined>()
  useEffect(() => {
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
  const [homepageUrl, setHomepageUrlState] = useState(DEFAULT_HOMEPAGE_URL)

  useEffect(() => {
    const load = async () => {
      try {
        const storedHomepage = await getItem('homepageUrl')
        if (storedHomepage) setHomepageUrlState(storedHomepage)
      } catch {}
    }
    load()
  }, [getItem])

  const addBookmark = useCallback((title: string, url: string) => {
    if (url && url !== kNEW_TAB_URL && isValidUrl(url) && !url.includes('about:blank')) {
      bookmarkStore.addBookmark(title, url)
    }
  }, [])

  const removeBookmark = useCallback((url: string) => {
    bookmarkStore.removeBookmark(url)
  }, [])

  /* ---------------------------------- tabs --------------------------------- */
  const activeTab = tabStore.activeTab

  /* -------------------------- ui / animation state -------------------------- */
  const addressEditing = useRef(false)
  const [addressText, setAddressText] = useState(kNEW_TAB_URL)
  const [addressFocused, setAddressFocused] = useState(false)

  const [keyboardVisible, setKeyboardVisible] = useState(false)
  const iosSoftKeyboardShown = useRef(false)

  const [showTabsView, setShowTabsView] = useState(false)


  const addressInputRef = useRef<TextInput>(null)
  const { fetchManifest, getStartUrl, shouldRedirectToStartUrl } = useWebAppManifest()
  const [isFullscreen, setIsFullscreen] = useState(false)
  const activeCameraStreams = useRef<Set<string>>(new Set())

  // Permission state
  const [permissionModalVisible, setPermissionModalVisible] = useState(false)
  const [pendingPermission, setPendingPermission] = useState<PermissionType | null>(null)
  const [pendingDomain, setPendingDomain] = useState<string | null>(null)
  const [pendingCallback, setPendingCallback] = useState<((granted: boolean) => void) | null>(null)
  const [permissionsDeniedForCurrentDomain, setPermissionsDeniedForCurrentDomain] = useState<PermissionType[]>([])

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

  // On first launch, navigate to homepage
  const hasSetHomepage = useRef(false)
  useEffect(() => {
    if (hasSetHomepage.current) return
    if (activeTab && (activeTab.url === kNEW_TAB_URL || activeTab.url === 'about:blank') && homepageUrl) {
      hasSetHomepage.current = true
      tabStore.updateTab(tabStore.activeTabId, { url: homepageUrl })
      setAddressText(homepageUrl)
    }
  }, [homepageUrl, activeTab, activeTab?.url])

  // Auto-focus on new tab
  useEffect(() => {
    if (activeTab && activeTab.url === kNEW_TAB_URL && !addressFocused) {
      setTimeout(() => addressInputRef.current?.focus(), 100)
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

  /* ------------------------------ keyboard hook ----------------------------- */
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'

    const showSub = Keyboard.addListener(showEvent, () => {
      setKeyboardVisible(true)
      if (Platform.OS === 'ios') iosSoftKeyboardShown.current = true
    })
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardVisible(false)
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

  const updateActiveTab = useCallback(
    (patch: Partial<Tab>) => {
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
    },
    []
  )

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
          const domain = searchResults[0]
          const url = domain.startsWith('http') ? domain : `https://${domain}`
          updateActiveTab({ url })
        } else if (searchResults.length > 1) {
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
    const hasProtocol = /^[a-z]+:\/\//i.test(entry)
    const isIpAddress = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/i.test(entry)
    const isProbablyUrl = hasProtocol || /^(www\.|([A-Za-z0-9\-]+\.)+[A-Za-z]{2,})(\/|$)/i.test(entry) || isIpAddress

    if (entry === '') {
      entry = kNEW_TAB_URL
    } else if (!isProbablyUrl) {
      performOverlayLookup(entry)
      addressEditing.current = false
      return
    } else if (!hasProtocol) {
      entry = isIpAddress ? 'http://' + entry : 'https://' + entry
    }

    if (!isValidUrl(entry)) entry = kNEW_TAB_URL
    updateActiveTab({ url: entry })
    addressEditing.current = false
  }, [addressText, updateActiveTab, performOverlayLookup])

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
  const [addressSuggestions, setAddressSuggestions] = useState<(HistoryEntry | Bookmark)[]>([])

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

  const navFwd = useCallback(() => {
    const currentTab = tabStore.activeTab
    if (currentTab?.canGoForward) tabStore.goForward(currentTab.id)
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
  /*                            PERMISSION HANDLERS                             */
  /* -------------------------------------------------------------------------- */

  const onDecision = useCallback(
    async (granted: boolean) => {
      setPermissionModalVisible(false)
      if (!pendingDomain || !pendingPermission) return

      try {
        await setDomainPermission(pendingDomain, pendingPermission, granted ? 'allow' : 'deny')
        try {
          const osBacked: PermissionType[] = ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION'] as any
          if (granted && osBacked.includes(pendingPermission)) {
            await checkPermissionForDomain(pendingDomain, pendingPermission)
          }
        } catch {}

        await updateDeniedPermissionsForDomain(activeTab?.url || '')

        if (activeTab?.url && domainForUrl(activeTab.url) === pendingDomain && activeTab.webviewRef?.current) {
          const updatedDenied = granted
            ? permissionsDeniedForCurrentDomain.filter(p => p !== pendingPermission)
            : [...new Set([...permissionsDeniedForCurrentDomain, pendingPermission])]

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
              } catch (e) {}
            })();
          `
          activeTab.webviewRef.current.injectJavaScript(js)
        }
      } finally {
        pendingCallback?.(granted)
        setPendingDomain(null)
        setPendingPermission(null)
        setPendingCallback(null)
      }
    },
    [pendingDomain, pendingPermission, activeTab, permissionsDeniedForCurrentDomain, pendingCallback, domainForUrl, updateDeniedPermissionsForDomain]
  )

  const handlePermissionChange = useCallback(
    async (permission: PermissionType, state: PermissionState) => {
      try {
        const url = activeTab?.url
        const domain = url ? domainForUrl(url) : ''
        if (domain) await setDomainPermission(domain, permission, state)
        try {
          const osBacked: PermissionType[] = ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION'] as any
          if (domain && state === 'allow' && osBacked.includes(permission)) {
            await checkPermissionForDomain(domain, permission)
          }
        } catch {}
        if (url) await updateDeniedPermissionsForDomain(url)
        if (activeTab?.webviewRef?.current) {
          const stateStr = state === 'allow' ? 'granted' : state === 'deny' ? 'denied' : 'prompt'
          activeTab.webviewRef.current.injectJavaScript(`
            (function () {
              try {
                const evt = new CustomEvent('permissionchange', { detail: { permission: '${permission}', state: '${stateStr}' } });
                document.dispatchEvent(evt);
              } catch (e) {}
            })();
          `)
        }
      } catch {}
    },
    [activeTab, domainForUrl, updateDeniedPermissionsForDomain]
  )

  /* -------------------------------------------------------------------------- */
  /*                           WEBVIEW MESSAGE HANDLER                          */
  /* -------------------------------------------------------------------------- */

  const injectedJavaScript = useMemo(
    () => buildInjectedJavaScript(getAcceptLanguageHeader()),
    [getAcceptLanguageHeader]
  )

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

      let msg
      try {
        msg = JSON.parse(event.nativeEvent.data)
      } catch {
        return
      }

      if (msg.type === 'CONSOLE') {
        const logPrefix = '[WebView]'
        switch (msg.method) {
          case 'log': console.log(logPrefix, ...msg.args); break
          case 'warn': console.warn(logPrefix, ...msg.args); break
          case 'error': console.error(logPrefix, ...msg.args); break
          case 'info': console.info(logPrefix, ...msg.args); break
          case 'debug': console.debug(logPrefix, ...msg.args); break
        }
        return
      }

      if (await routeWebViewMessage(msg)) return

      if (msg.call && (!wallet || isWeb2Mode)) {
        if (!wallet && !isWeb2Mode) router.push('/config')
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
        sendResponseToWebView(msg.id, { error: error?.message || 'unknown error' })
      }
    },
    [activeTab, wallet, routeWebViewMessage, isWeb2Mode]
  )

  /* -------------------------------------------------------------------------- */
  /*                      NAV STATE CHANGE → HISTORY TRACKING                   */
  /* -------------------------------------------------------------------------- */
  const handleNavStateChange = (navState: WebViewNavigation) => {
    if (!activeTab) return
    if (navState.url?.includes('favicon.ico') && activeTab.url === kNEW_TAB_URL) return

    if (navState.url !== activeTab.url && activeCameraStreams.current.has(activeTab.id.toString())) {
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

  const uri = typeof activeTab?.url === 'string' && activeTab.url.length > 0 ? activeTab.url : 'about:blank'
  const isNewTab = activeTab?.url === kNEW_TAB_URL

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        enabled={Platform.OS === 'ios' && addressFocused}
        behavior="padding"
        keyboardVerticalOffset={0}
      >
        <View style={[styles.container, { backgroundColor: colors.background }]}>
          <StatusBar style={isDark ? 'light' : 'dark'} translucent hidden={isFullscreen} />

          {/* ---- Main content area ---- */}
          {isNewTab ? (
            <NewTabPage onNavigate={url => updateActiveTab({ url })} />
          ) : activeTab ? (
            <View style={{ flex: 1 }}>
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
                originWhitelist={['https://*', 'http://*']}
                onMessage={handleMessage}
                injectedJavaScript={injectedJavaScript}
                injectedJavaScriptBeforeContentLoaded={getPermissionScript(
                  permissionsDeniedForCurrentDomain,
                  pendingPermission
                )}
                onNavigationStateChange={handleNavStateChange}

                allowsFullscreenVideo={true}
                mediaPlaybackRequiresUserAction={false}
                allowsInlineMediaPlayback={true}
                geolocationEnabled
                onPermissionRequest={() => false}
                androidLayerType={Platform.OS === 'android' ? 'software' : 'hardware'}
                androidHardwareAccelerationDisabled={Platform.OS === 'android'}
                onError={(e: any) => {
                  if (e.nativeEvent?.url?.includes('favicon.ico') && activeTab?.url === kNEW_TAB_URL) return
                }}
                onHttpError={(e: any) => {
                  if (e.nativeEvent?.url?.includes('favicon.ico') && activeTab?.url === kNEW_TAB_URL) return
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

          {/* ---- Address Bar ---- */}
          {!isFullscreen && showAddressBar && (
            <AddressBar
              addressText={addressText}
              addressFocused={addressFocused}
              isLoading={activeTab?.isLoading || false}
              canGoBack={activeTab?.canGoBack || false}
              canGoForward={activeTab?.canGoForward || false}
              isNewTab={isNewTab}
              isHttps={activeTab?.url?.startsWith('https') || false}
              suggestions={addressSuggestions}
              tabCount={tabStore.tabs.length}
              onChangeText={onChangeAddressText}
              onSubmit={onAddressSubmit}
              onFocus={() => {
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
              onForward={navFwd}
              onReloadOrStop={navReloadOrStop}
              onClearText={() => setAddressText('')}
              onSuggestionPress={(url) => {
                addressInputRef.current?.blur()
                Keyboard.dismiss()
                setAddressFocused(false)
                setAddressSuggestions([])
                setAddressText(url)
                updateActiveTab({ url })
                addressEditing.current = false
              }}
              onShare={shareCurrent}
              onBookmarks={() => sheet.push('bookmarks')}
              onTabs={() => setShowTabsView(true)}
              onSettings={() => sheet.push('settings')}
              inputRef={addressInputRef}
            />
          )}

          {/* ---- Tabs Overview ---- */}
          {!isFullscreen && showTabsView && (
            <TabsOverview
              onDismiss={() => setShowTabsView(false)}
              setAddressText={setAddressText}
              setAddressFocused={setAddressFocused}
            />
          )}

          {/* ---- Unified Sheet System ---- */}
          <Sheet
            visible={sheet.isOpen && sheet.route !== 'tabs'}
            onClose={sheet.close}
            title={
              sheet.route === 'bookmarks' ? t('bookmarks') :
              sheet.route === 'history' ? t('history') :
              sheet.route === 'menu' ? undefined :
              sheet.route === 'settings' ? t('settings') :
              sheet.route === 'identity' ? t('identity') :
              sheet.route === 'trust' ? t('trust_network') :
              sheet.route === 'permissions' ? t('permissions') :
              undefined
            }
            heightPercent={sheet.route === 'menu' ? 0.65 : 0.85}
          >
            {sheet.route === 'menu' && (
              <MenuSheet
                isNewTab={isNewTab}
                onBackToHomepage={() => {
                  updateActiveTab({ url: homepageUrl })
                  setAddressText(homepageUrl)
                }}
                onAddBookmark={() => {
                  if (activeTab && activeTab.url !== kNEW_TAB_URL && isValidUrl(activeTab.url)) {
                    addBookmark(activeTab.title || t('untitled'), activeTab.url)
                  }
                }}
                onGoToLogin={() => router.push('/auth/mnemonic')}
              />
            )}
            {sheet.route === 'bookmarks' && (
              <View style={{ flex: 1, padding: spacing.lg }}>
                <NewTabPage onNavigate={(url) => { updateActiveTab({ url }); sheet.close() }} />
              </View>
            )}
            {sheet.route === 'history' && (
              <HistoryList
                history={history}
                onSelect={u => {
                  updateActiveTab({ url: u })
                  sheet.close()
                }}
                onDelete={removeHistoryItem}
                onClear={clearHistory}
              />
            )}
            {sheet.route === 'settings' && (
              <View style={{ flex: 1, padding: spacing.lg }}>
                <SettingsScreen />
              </View>
            )}
            {sheet.route === 'identity' && (
              <View style={{ flex: 1, padding: spacing.lg }}>
                <IdentityScreen />
              </View>
            )}
            {sheet.route === 'trust' && (
              <View style={{ flex: 1, padding: spacing.lg }}>
                <TrustScreen />
              </View>
            )}
            {sheet.route === 'permissions' && (
              <View style={{ flex: 1, padding: spacing.lg }}>
                <PermissionsScreen
                  origin={activeTab?.url ? domainForUrl(activeTab.url) : ''}
                  onPermissionChange={handlePermissionChange}
                />
              </View>
            )}
          </Sheet>

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
    </GestureHandlerRootView>
  )
}

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
    flex: 1,
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
    alignItems: 'center',
  },
})
