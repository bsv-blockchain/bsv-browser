
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
  ActivityIndicator,
} from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { WebView, WebViewMessageEvent, WebViewNavigation } from 'react-native-webview'
import { GestureHandlerRootView, GestureDetector } from 'react-native-gesture-handler'
import Animated from 'react-native-reanimated'
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
import { DEFAULT_HOMEPAGE_URL, kNEW_TAB_URL } from '@/shared/constants'
import { isValidUrl } from '@/utils/generalHelpers'
import tabStore from '../stores/TabStore'
import bookmarkStore from '@/stores/BookmarkStore'
import { useTranslation } from 'react-i18next'
import { useBrowserMode } from '@/context/BrowserModeContext'

import { useWebAppManifest } from '@/hooks/useWebAppManifest'
import { buildInjectedJavaScript } from '@/utils/webview/injectedPolyfills'
import PermissionModal from '@/components/browser/PermissionModal'
import { getPermissionState } from '@/utils/permissionsManager'
import { getPermissionScript } from '@/utils/permissionScript'
import { createWebViewMessageRouter } from '@/utils/webview/messageRouter'
import { handleUrlDownload, cleanupDownloadsCache } from '@/utils/webview/downloadHandler'

import { AddressBar } from '@/components/browser/AddressBar'
import { MenuPopover } from '@/components/browser/MenuPopover'
import { TabsOverview } from '@/components/browser/TabsOverview'
import { BrowserPage } from '@/components/browser/BrowserPage'
import { SuggestionsDropdown } from '@/components/browser/SuggestionsDropdown'
import { SheetRouter } from '@/components/browser/SheetRouter'
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

/* -------------------------------------------------------------------------- */
/*                                  BROWSER                                   */
/* -------------------------------------------------------------------------- */

function Browser() {
  /* --------------------------- theme / basic hooks -------------------------- */
  const { isDark, colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { t, i18n } = useTranslation()
  const { isWeb2Mode } = useBrowserMode()
  const sheet = useSheet()

  useEffect(() => {
    tabStore.initializeTabs()
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
  const { history, pushHistory, removeHistoryItem, clearHistory } = useHistory(getItem, setItem)

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

  /* ---------------------------------- tabs --------------------------------- */
  const activeTab = tabStore.activeTab

  /* -------------------------- ui / animation state -------------------------- */
  const addressEditing = useRef(false)
  const [addressText, setAddressText] = useState(kNEW_TAB_URL)
  const [addressFocused, setAddressFocused] = useState(false)
  const [addressSuggestions, setAddressSuggestions] = useState<(HistoryEntry | Bookmark)[]>([])

  const addressInputRef = useRef<TextInput>(null)

  const {
    keyboardVisible,
    addressBarPanGesture,
    animatedAddressBarStyle,
    animatedMenuPopoverStyle,
  } = useAddressBarAnimation(insets, addressFocused, addressEditing, addressInputRef, setAddressFocused, setAddressSuggestions)

  const [showTabsView, setShowTabsView] = useState(false)
  const [menuPopoverOpen, setMenuPopoverOpen] = useState(false)
  const [isOverlaySearching, setIsOverlaySearching] = useState(false)

  const { fetchManifest, getStartUrl, shouldRedirectToStartUrl } = useWebAppManifest()
  const [isFullscreen, setIsFullscreen] = useState(false)
  const activeCameraStreams = useRef<Set<string>>(new Set())

  /* --------------------------------- overlay lookup cache --------------------------------- */
  const overlayLookupCache = useRef<Map<string, string[]>>(new Map())
  const overlayLookupAbortController = useRef<AbortController | null>(null)
  const isOverlayLookupCancelled = useRef(false)

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
    permissionRouterConfig,
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

  /* -------------------------------------------------------------------------- */
  /*                                 UTILITIES                                  */
  /* -------------------------------------------------------------------------- */

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

  /* -------------------------------------------------------------------------- */
  /*                              ADDRESS HANDLING                              */
  /* -------------------------------------------------------------------------- */

  const cancelOverlayLookup = useCallback(() => {
    isOverlayLookupCancelled.current = true
    overlayLookupAbortController.current?.abort()
    setIsOverlaySearching(false)
  }, [])

  const performOverlayLookup = useCallback(async (searchParam: string) => {
    const cachedResults = overlayLookupCache.current.get(searchParam)

    if (cachedResults) {
      // Cache hit: apply results immediately
      if (cachedResults.length === 1) {
        const domain = cachedResults[0]
        const url = domain.startsWith('http') ? domain : `https://${domain}`
        updateActiveTab({ url })
      } else if (cachedResults.length > 1) {
        setAddressSuggestions(cachedResults.map(domain => ({
          title: domain,
          url: domain.startsWith('http') ? domain : `https://${domain}`,
          timestamp: Date.now()
        })))
      }

      // Update cache in background (no loading indicator)
      ;(async () => {
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

            overlayLookupCache.current.set(searchParam, searchResults)
            // Update UI if results changed
            if (JSON.stringify(searchResults) !== JSON.stringify(cachedResults)) {
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
          }
        } catch (error) {
          console.warn('[OverlayLookup] Background cache update failed:', error)
        }
      })()
      return
    }

    // Cache miss: show loading and fetch
    isOverlayLookupCancelled.current = false
    overlayLookupAbortController.current = new AbortController()
    setIsOverlaySearching(true)
    try {
      const overlay = new LookupResolver()
      const response = await overlay.query({
        service: 'ls_apps',
        query: { name: searchParam }
      }, 10000)

      // Ignore response if cancelled
      if (isOverlayLookupCancelled.current) return

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

        overlayLookupCache.current.set(searchParam, searchResults)

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
      // Ignore errors from cancelled requests
      if (!isOverlayLookupCancelled.current) {
        console.warn('[OverlayLookup] Search failed:', error)
      }
    } finally {
      setIsOverlaySearching(false)
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
  /*                           WEBVIEW MESSAGE HANDLER                          */
  /* -------------------------------------------------------------------------- */

  const injectedJavaScript = useMemo(
    () => buildInjectedJavaScript(getAcceptLanguageHeader()),
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
    var or=URL.revokeObjectURL;
    URL.revokeObjectURL=function(u){
      setTimeout(function(){reg.delete(u);},30000);
      return or.call(URL,u);
    };
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

      let msg
      try {
        msg = JSON.parse(event.nativeEvent.data)
      } catch {
        return
      }

      if (msg.type === 'DL_DEBUG') {
        console.warn('[DL_DEBUG]', msg.info)
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
        if (!wallet && !isWeb2Mode) router.push('/auth/mnemonic')
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

  const renderMainContent = () => {
    if (isNewTab) {
      return <BrowserPage onNavigate={url => updateActiveTab({ url })} history={history} removeHistoryItem={removeHistoryItem} clearHistory={clearHistory} />
    }
    if (activeTab) {
      return (
        <View style={{
          position: 'absolute',
          top: isFullscreen ? 0 : insets.top,
          left: 0,
          right: 0,
          bottom: 0,
        }}>
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
            originWhitelist={['https://*', 'http://*', 'blob:*', 'data:*']}
            onMessage={handleMessage}
            injectedJavaScript={injectedJavaScript}
            injectedJavaScriptBeforeContentLoaded={
              downloadInterceptScript + '\n' +
              getPermissionScript(
                permissionsDeniedForCurrentDomain,
                pendingPermission
              )
            }
            onNavigationStateChange={handleNavStateChange}

            allowsFullscreenVideo={true}
            mediaPlaybackRequiresUserAction={false}
            allowsInlineMediaPlayback={true}
            geolocationEnabled
            onPermissionRequest={() => false}
            onFileDownload={Platform.OS === 'ios' ? ({ nativeEvent }: any) => {
              handleUrlDownload(nativeEvent.downloadUrl).catch(() => {})
            } : undefined}
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
                const fileExtPattern = /\.(pdf|zip|gz|tar|rar|7z|doc|docx|xls|xlsx|ppt|pptx|csv|mp3|mp4|avi|mov|dmg|exe|apk|ipa)(\?|$)/i
                if (fileExtPattern.test(reqUrl)) {
                  handleUrlDownload(reqUrl).catch(() => {})
                  return false
                }
              }
              return true
            }}
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
            containerStyle={{ backgroundColor: isDark ? '#000' : '#fff' }}
            style={{ flex: 1 }}
          />
        </View>
      )
    }
    return null
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
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

          {/* ---- Floating Address Bar + Popover (absolutely positioned) ---- */}
          {!isFullscreen && showAddressBar && (
            <>
              <GestureDetector gesture={addressBarPanGesture}>
                <Animated.View
                  style={[
                    styles.chromeWrapper,
                    { top: insets.top },
                    animatedAddressBarStyle
                  ]}
                  pointerEvents="box-none"
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
                    onMorePress={() => setMenuPopoverOpen(true)}
                    onChangeText={onChangeAddressText}
                    onSubmit={onAddressSubmit}
                    onFocus={() => {
                      setMenuPopoverOpen(false)
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
                    inputRef={addressInputRef}
                  />
                </Animated.View>
              </GestureDetector>

              {/* ---- Suggestions ---- */}
              {addressFocused && (
                <SuggestionsDropdown
                  suggestions={addressSuggestions}
                  colors={colors}
                  bottomOffset={insets.bottom}
                  onSelect={(url) => {
                    addressInputRef.current?.blur()
                    Keyboard.dismiss()
                    setAddressFocused(false)
                    setAddressSuggestions([])
                    setAddressText(url)
                    updateActiveTab({ url })
                    addressEditing.current = false
                  }}
                />
              )}

              {/* ---- Overlay Search Loading Indicator ---- */}
              {isOverlaySearching && (
                <View style={styles.overlaySearchContainer}>
                  <BlurChrome style={styles.overlaySearchCard} borderRadius={radii.xl}>
                    <ActivityIndicator size="small" color={colors.textPrimary} />
                    <Text style={[styles.overlaySearchText, { color: colors.textPrimary }]}>
                      Searching for app on overlay
                    </Text>
                    <TouchableOpacity
                      onPress={cancelOverlayLookup}
                      hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                      style={styles.overlaySearchCloseButton}
                    >
                      <Ionicons name="close" size={18} color={colors.textPrimary} />
                    </TouchableOpacity>
                  </BlurChrome>
                </View>
              )}
            </>
          )}

          {/* ---- Menu Popover (full-screen layer so backdrop covers everything) ---- */}
          {menuPopoverOpen && (
            <Animated.View style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 }, animatedMenuPopoverStyle]}>
              <MenuPopover
                isNewTab={isNewTab}
                canShare={!isNewTab}
                bottomOffset={insets.bottom}
                onDismiss={() => setMenuPopoverOpen(false)}
                onShare={shareCurrent}
                onAddBookmark={() => {
                  if (activeTab && activeTab.url !== kNEW_TAB_URL && isValidUrl(activeTab.url)) {
                    addBookmark(activeTab.title || t('untitled'), activeTab.url)
                  }
                }}
                onBookmarks={() => sheet.push('bookmarks')}
                onTabs={() => setShowTabsView(true)}
                onSettings={() => sheet.push('settings')}
                onTrust={() => sheet.push('trust')}
                onEnableWeb3={() => router.push('/auth/mnemonic')}
              />
            </Animated.View>
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
          <SheetRouter
            sheet={sheet}
            activeTab={activeTab}
            domainForUrl={domainForUrl}
            homepageUrl={homepageUrl}
            updateActiveTab={updateActiveTab}
            setAddressText={setAddressText}
            clearHistory={clearHistory}
            history={history}
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
  chromeWrapper: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 20,
  },
  overlaySearchContainer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 90,
  },
  overlaySearchCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  overlaySearchText: {
    ...typography.subhead,
  },
  overlaySearchCloseButton: {
    marginLeft: spacing.md,
    padding: spacing.xs,
  },
})
