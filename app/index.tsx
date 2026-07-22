import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import {
  Keyboard,
  Platform,
  StyleSheet,
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
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withDelay,
  withSequence,
  SharedValue
} from 'react-native-reanimated'
import { Ionicons } from '@expo/vector-icons'
import { observer } from 'mobx-react-lite'
import { router, useFocusEffect } from 'expo-router'

import { useTheme } from '@/context/theme/ThemeContext'
import { useWalletManagers } from '@/context/WalletContext'
import { WalletInterface } from '@bsv/sdk'
import { useLocalStorage } from '@/context/LocalStorageProvider'
import { useSheet, SheetProvider } from '@/context/SheetContext'
import type { Tab } from '@/shared/types/browser'
import {
  DEFAULT_HOMEPAGE_URL,
  kNEW_TAB_URL,
  safeBottomInset,
  ADDRESS_BAR_HEIGHT
} from '@/shared/constants'
import { hostOf, isValidUrl, normalizeUrlForHistory } from '@/utils/generalHelpers'
import tabStore from '../stores/TabStore'
import bookmarkStore from '@/stores/BookmarkStore'
import uiStore from '@/stores/uiStore'
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
import { getErrorPage, getNativeErrorInfo, paymentLoadingPage, navigationLoadingPage, escapeForTemplateLiteral, escapeForJsSingleQuote } from '@/utils/webview/errorPages'

import { AddressBar, AddressBarHandle } from '@/components/browser/AddressBar'
import { TabsOverview } from '@/components/browser/TabsOverview'
import { SheetRouter } from '@/components/browser/SheetRouter'
import { durations } from '@/context/theme/motion'

import { useHistory } from '@/hooks/useHistory'
import { usePermissions } from '@/hooks/usePermissions'
import { useMemoryHygiene } from '@/hooks/useMemoryHygiene'
import { perf } from '@/utils/perf'
import { shouldForwardWebViewLogs } from '@/utils/logging'
import { useRenderCount } from '@/hooks/useRenderCount'
import { PerfProfiler } from '@/components/PerfProfiler'
import { mark } from '@/utils/perfMarks'

/* -------------------------------------------------------------------------- */
/*                                   CONSTS                                   */
/* -------------------------------------------------------------------------- */

// BRC-100 methods that must NOT pay the InteractionManager yield tax on the
// CWI hot path. L0 = fixed in-memory answers; L1 = pure crypto (no storage,
// no permission mutation). These are what dApps storm on page load.
const CWI_NO_YIELD = new Set<string>([
  // L0 — free
  'getVersion', 'getNetwork', 'isAuthenticated', 'waitForAuthentication',
  // L1 — crypto
  'getPublicKey', 'createHmac', 'verifyHmac', 'createSignature', 'verifySignature',
  'encrypt', 'decrypt'
])

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
/*                               WEBVIEW HOST                                 */
/* -------------------------------------------------------------------------- */
/**
 * Memoized owner of the native <WebView>. Extracted out of the Browser observer
 * so the page-load re-render storm (isLoading / canGoBack / title churn —
 * hundreds of MobX mutations per browse session) NO LONGER reconciles the
 * heavy WebView subtree. It re-renders only when one of its explicit props
 * changes: the active tab id, the URL (a real navigation), desktop/fullscreen
 * mode, or layout insets. All event handlers read the live tab imperatively via
 * tabStore at event time (not render time), so they never need the observable
 * tab object as a prop.
 */
interface WebViewHostProps {
  tabId: number
  // When false this host is a warm-but-hidden tab: kept mounted (page state
  // intact) but visually behind the active tab and non-interactive. Only the
  // active host drives the switch-loading overlay and address-bar UI.
  isActive: boolean
  // True when this tab's WebView is in the warm pool — activation skips the
  // 200ms crossfade so recently-used tab switches feel instant.
  isWarm: boolean
  webviewRef: React.RefObject<any>
  containerRef?: React.RefObject<View | null>
  uri: string
  isDesktopMode: boolean
  isFullscreen: boolean
  onExitFullscreen: () => void
  topInset: number
  isDark: boolean
  acceptLanguage: string
  // Web2 mode turns on native Apple Pay (enableApplePay) which is mutually
  // exclusive with WKWebView script injection — RNCWebViewImpl.resetupScripts
  // skips injectedJavaScript/before-content/history when Apple Pay is on, and
  // evaluateJS is blocked. We have no wallet bridge in web2, so we drop the
  // injected scripts there and gain Apple Pay; web3 keeps the bridge, no Apple Pay.
  isWeb2Mode: boolean
  injectedJavaScript: string
  injectedJSBefore: string
  onMessage: (tabId: number, event: any) => void
  onNavStateChange: (tabId: number, navState: WebViewNavigation) => void
  paymentHandlerRef: React.MutableRefObject<any>
  paymentInFlightUrl: React.MutableRefObject<string | null>
  webviewScrollIndicatorInsets: any
  webviewContainerStyle: any
  webviewStyle: any
  loadProgress: SharedValue<number>
  // Fired once the ACTIVE tab's first load finishes, so the shell can defer
  // mounting the other warm-pool WebViews until the active page has painted
  // (avoids N concurrent cold-start loads contending for network/CPU).
  onActivePainted?: () => void
}

const WebViewHost = React.memo(function WebViewHost(props: WebViewHostProps) {
  const {
    tabId,
    isActive,
    isWarm,
    webviewRef,
    containerRef,
    uri,
    isDesktopMode,
    isFullscreen,
    onExitFullscreen,
    topInset,
    acceptLanguage,
    isWeb2Mode,
    injectedJavaScript,
    injectedJSBefore,
    onMessage,
    onNavStateChange,
    paymentHandlerRef,
    paymentInFlightUrl,
    webviewScrollIndicatorInsets,
    webviewContainerStyle,
    webviewStyle,
    loadProgress,
    onActivePainted
  } = props

  const getTab = useCallback(() => tabStore.tabs.find(t => t.id === tabId), [tabId])

  // Stable per-tab wrappers so the app-level handlers know which tab fired the
  // event (the warm pool mounts several WebViews; only the active one's events
  // drive the address bar / wallet bridge). useCallback keeps the prop identity
  // stable across re-renders so the native bridge isn't re-bound every frame.
  const onMessageForTab = useCallback((event: any) => onMessage(tabId, event), [onMessage, tabId])
  const onNavForTab = useCallback(
    (navState: WebViewNavigation) => onNavStateChange(tabId, navState),
    [onNavStateChange, tabId]
  )
  const lastProcessRecoveryAt = useRef(0)
  // Bounded crash-recovery: count consecutive renderer terminations so a page that
  // reliably kills its WebContent process can't drive an infinite reload loop —
  // which itself spikes memory/CPU and can OOM-kill the whole app on SE-class
  // hardware. Per-tab (useRef discarded on unmount); reset after a healthy gap.
  const processRecoveryCount = useRef(0)
  const recoverTerminatedProcess = useCallback(
    (reason: string) => {
      const tab = getTab()
      console.warn(`[WebView] ${reason}; tab=${tabId} active=${isActive} url=${tab?.url ?? uri}`)
      if (tab) tabStore.updateTab(tabId, { isLoading: false })
      if (!isActive) return

      tabStore.clearSwitchLoading()
      loadProgress.value = 0

      // Avoid a reload loop if WebKit repeatedly kills the same heavy page.
      const now = Date.now()
      const sinceLast = now - lastProcessRecoveryAt.current
      if (sinceLast < 5000) return
      // A long quiet gap means the previous reload ran healthily — treat the next
      // termination as a fresh incident, not part of the same loop.
      if (sinceLast > 60000) processRecoveryCount.current = 0
      lastProcessRecoveryAt.current = now
      processRecoveryCount.current += 1

      // Bound the retries: after 3 terminations in a row, stop reloading and show an
      // error page. An unbounded reload loop on a page that keeps killing its
      // renderer is itself a memory/CPU spike that can OOM-kill the whole app.
      if (processRecoveryCount.current > 3) {
        console.warn(
          `[WebView] renderer terminated ${processRecoveryCount.current}x; stopping reload loop for tab=${tabId}`
        )
        const crashPage = getErrorPage('crash')
        webviewRef.current?.injectJavaScript(
          `document.open();document.write(\`${escapeForTemplateLiteral(crashPage)}\`);document.close();true;`
        )
        return
      }

      setTimeout(() => {
        if (tabStore.activeTabId !== tabId) return
        const activeUrl = tabStore.activeTab?.url
        if (activeUrl?.startsWith('http')) tabStore.raiseLoadingForUrl(activeUrl)
        webviewRef.current?.reload()
      }, 100)
    },
    [getTab, isActive, loadProgress, tabId, uri, webviewRef]
  )

  const activeOpacity = useSharedValue(isActive ? 1 : 0)
  useEffect(() => {
    // Warm tabs already have a painted page — snap visible instantly so tab
    // switches stay under the 100ms interaction budget. Cold tabs (fresh mount)
    // fade in over the outgoing page to avoid a flash of empty chrome.
    if (isActive) {
      activeOpacity.value = isWarm ? 1 : withTiming(1, { duration: 100 })
    } else {
      activeOpacity.value = withDelay(isWarm ? 0 : 100, withTiming(0, { duration: 0 }))
    }
  }, [isActive, isWarm, activeOpacity])
  const fadeStyle = useAnimatedStyle(() => ({ opacity: activeOpacity.value }))

  return (
    <Animated.View
      ref={containerRef}
      collapsable={false}
      // Inactive warm tabs stay mounted (page alive) but hidden behind the
      // active one and non-interactive. Incoming tab fades in (200ms) over the
      // still-painted outgoing tab; outgoing snaps to opacity 0 only after the
      // fade completes — asymmetric to avoid background bleed from composite
      // coverage dipping mid-crossfade. pointerEvents and zIndex switch
      // instantly for interaction correctness.
      pointerEvents={isActive ? 'auto' : 'none'}
      style={[
        {
          position: 'absolute',
          top: isFullscreen ? 0 : topInset,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: isActive ? 1 : 0
        },
        fadeStyle
      ]}
    >
      {isFullscreen && (
        <TouchableOpacity
          style={styles.exitFullscreen}
          onPress={() => {
            onExitFullscreen()
            webviewRef.current?.injectJavaScript(`
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
        ref={webviewRef}
        source={{
          uri: uri,
          headers: { 'Accept-Language': acceptLanguage }
        }}
        userAgent={
          isDesktopMode
            ? Platform.OS === 'ios'
              ? DESKTOP_UA_IOS
              : DESKTOP_UA_ANDROID
            : Platform.OS === 'ios'
              ? MOBILE_UA_IOS
              : MOBILE_UA_ANDROID
        }
        // sharedCookiesEnabled syncs the native NSHTTPCookieStorage into the
        // WKWebView cookie store on the iOS MAIN THREAD on every navigation —
        // on cookie/redirect-heavy pages this froze the whole app for 10s+
        // (Safari loaded the same URL in 200ms). Disabled: the WebView uses its
        // own persistent WKWebsiteDataStore (cookies + logins still persist and
        // are shared across tabs), we just don't bridge cookies to/from native
        // RN networking — which a browser doesn't need.
        sharedCookiesEnabled={false}
        // The default static WKProcessPool keeps old site processes alive even
        // after their tab's WebView unmounts. A per-WebView pool lets iOS release
        // those processes when external-link navigation replaces the active tab.
        useSharedProcessPool={Platform.OS !== 'ios'}
        originWhitelist={['https://*', 'http://*', 'blob:*', 'data:*', 'about:*']}
        onMessage={onMessageForTab}
        // Apple Pay (web2) is incompatible with WKWebView script injection, so
        // skip the injected scripts there. In web3 the wallet bridge needs them.
        enableApplePay={isWeb2Mode}
        injectedJavaScript={isWeb2Mode ? undefined : injectedJavaScript}
        injectedJavaScriptBeforeContentLoaded={isWeb2Mode ? undefined : injectedJSBefore}
        // Default ["phoneNumber"] makes WebKit scan + auto-link phone numbers on
        // every page parse — pure cost, no benefit for a general-purpose browser.
        // iOS/WebKit-only feature: on New-Arch Android the RNCWebView codegen prop
        // parser aborts (SIGABRT: castValue assertion value.isObject()) on this
        // value, so only pass it on iOS.
        dataDetectorTypes={Platform.OS === 'ios' ? 'none' : undefined}
        onNavigationStateChange={onNavForTab}
        allowsFullscreenVideo={true}
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback={true}
        geolocationEnabled
        onPermissionRequest={
          Platform.OS === 'android'
            ? (event: any) => {
                const resources: string[] = event.nativeEvent?.resources ?? []
                ;(async () => {
                  try {
                    const toGrant: string[] = []
                    for (const resource of resources) {
                      if (resource.includes('VIDEO_CAPTURE')) {
                        const current = await check(PERMISSIONS.ANDROID.CAMERA)
                        const granted =
                          current === RESULTS.GRANTED || (await request(PERMISSIONS.ANDROID.CAMERA)) === RESULTS.GRANTED
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
          if (reqUrl.startsWith('blob:') || reqUrl.startsWith('data:')) {
            const escaped = escapeForJsSingleQuote(reqUrl)
            setTimeout(() => {
              webviewRef.current?.injectJavaScript(`(function(){
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
        // Without this, RNCWebView falls back to loadRequest on the SAME WebView
        // for target="_blank"/window.open — clobbering the current page. Open a
        // new tab instead (the native side cancels the in-place nav, preserving
        // this tab). Active-only so a backgrounded warm tab can't spawn tabs.
        onOpenWindow={(event: any) => {
          const targetUrl = event?.nativeEvent?.targetUrl
          if (isActive && targetUrl) tabStore.newTab(targetUrl)
        }}
        androidLayerType="hardware"
        androidHardwareAccelerationDisabled={false}
        onError={(e: any) => {
          e.preventDefault()
          if (isActive) tabStore.clearSwitchLoading()
          const tab = getTab()
          if (e.nativeEvent?.url?.includes('favicon.ico') && tab?.url === kNEW_TAB_URL) return
          const code = e.nativeEvent?.code
          if (typeof code === 'number' && code < 0 && webviewRef.current) {
            const info = getNativeErrorInfo(code)
            const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><style>:root{--bg:#f5f5f0;--text:#1a1a1a;--sub:#666}@media(prefers-color-scheme:dark){:root{--bg:#1a1a1a;--text:#e8e6e1;--sub:#999}}body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:var(--bg);color:var(--text);text-align:center}h1{font-size:6rem;margin:0}.subtitle{font-size:1.5rem;margin:8px 0}.detail{color:var(--sub);padding:0 24px}</style></head><body><div><h1 style="color:${info.color}">${info.code}</h1><p class="subtitle">${info.title}</p><p class="detail">${info.detail}</p></div></body></html>`
            webviewRef.current.injectJavaScript(
              `document.open();document.write(\`${escapeForTemplateLiteral(page)}\`);document.close();`
            )
          }
        }}
        onContentProcessDidTerminate={() => recoverTerminatedProcess('iOS WebContent process terminated')}
        onRenderProcessGone={(event: any) =>
          recoverTerminatedProcess(
            event.nativeEvent?.didCrash ? 'Android WebView renderer crashed' : 'Android WebView renderer exited'
          )
        }
        onHttpError={(e: any) => {
          const tab = getTab()
          if (e.nativeEvent?.url?.includes('favicon.ico') && tab?.url === kNEW_TAB_URL) return
          const status = e.nativeEvent?.statusCode || 404
          const url = e.nativeEvent?.url || ''
          if (status === 402 && paymentHandlerRef.current) {
            if (paymentInFlightUrl.current === url) return
            paymentInFlightUrl.current = url
            if (webviewRef.current) {
              webviewRef.current.injectJavaScript(
                `document.open();document.write(\`${escapeForTemplateLiteral(paymentLoadingPage)}\`);document.close();`
              )
            }
            paymentHandlerRef.current
              .handle402(url, 402, e.nativeEvent.headers || {})
              .then((html: string | null) => {
                if (html && webviewRef.current) {
                  webviewRef.current.injectJavaScript(
                    `document.open();document.write(\`${escapeForTemplateLiteral(html)}\`);document.close();`
                  )
                } else if (webviewRef.current) {
                  const fallback = getErrorPage(402)
                  webviewRef.current.injectJavaScript(
                    `document.open();document.write(\`${escapeForTemplateLiteral(fallback)}\`);document.close();`
                  )
                }
              })
              .catch(() => {
                if (webviewRef.current) {
                  const fallback = getErrorPage(402)
                  webviewRef.current.injectJavaScript(
                    `document.open();document.write(\`${escapeForTemplateLiteral(fallback)}\`);document.close();`
                  )
                }
              })
              .finally(() => {
                paymentInFlightUrl.current = null
              })
          } else if (webviewRef.current) {
            if (status === 403) return
            const fallback = getErrorPage(status)
            webviewRef.current.injectJavaScript(
              `document.open();document.write(\`${escapeForTemplateLiteral(fallback)}\`);document.close();`
            )
          }
        }}
        onLoadProgress={({ nativeEvent }: any) => {
          if (!isActive) return
          const next = nativeEvent.progress * 0.9
          if (next > loadProgress.value) loadProgress.value = withTiming(next, { duration: durations.quick })
        }}
        onLoadEnd={(event: any) => {
          // Only the active tab's first paint should clear the switch overlay —
          // a warm background tab finishing a late load must not dismiss it.
          if (isActive) {
            tabStore.clearSwitchLoading()
            // Active page painted — let the shell mount the deferred warm hosts.
            onActivePainted?.()
          }
          if (isActive && loadProgress.value > 0) {
            loadProgress.value = withSequence(
              withTiming(1, { duration: durations.instant }),
              withDelay(300, withTiming(0, { duration: 0 }))
            )
          }
          if (paymentInFlightUrl.current) return
          // Only the ACTIVE tab drives nav-state (url/history/saveTabs). On cold
          // start the warm pool mounts several background WebViews that each fire
          // onLoadEnd; running the full handler (history recompute + saveTabs +
          // log) for every one floods the JS thread while the wallet is building
          // and the active tab is trying to paint. Background tabs keep their
          // persisted sourceUrl; their nav-state updates when they become active.
          if (isActive) {
            tabStore.handleNavigationStateChange(tabId, {
              ...(event.nativeEvent ?? event),
              loading: false
            })
          }
        }}
        javaScriptEnabled
        domStorageEnabled
        allowsBackForwardNavigationGestures
        pullToRefreshEnabled
        allowsLinkPreview
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        scrollIndicatorInsets={webviewScrollIndicatorInsets}
        containerStyle={webviewContainerStyle}
        style={webviewStyle}
      />
    </Animated.View>
  )
})

/**
 * Tab-switch loading overlay. Its own observer so that `tabStore.switchLoading`
 * toggling (raised on tab switch, cleared on first paint) re-renders ONLY this
 * tiny spinner instead of the whole Browser tree + WebView. Positioned to match
 * the WebView container bounds so it covers the page, not the chrome.
 */
const SwitchLoadingOverlay = observer(function SwitchLoadingOverlay(props: {
  topInset: number
  bottomReservedHeight: number
  addressBarIsAtTop: boolean
  isFullscreen: boolean
  backgroundColor: string
}) {
  if (!tabStore.switchLoading) return null
  const { topInset, bottomReservedHeight, addressBarIsAtTop, isFullscreen, backgroundColor } = props
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: isFullscreen ? 0 : topInset,
        left: 0,
        right: 0,
        bottom: Platform.OS === 'android' && !addressBarIsAtTop && !isFullscreen ? bottomReservedHeight : 0,
        backgroundColor,
        justifyContent: 'center',
        alignItems: 'center',
        // Above the warm-pool WebViews (active=1) and the homepage cover (2) so
        // a cold tab's spinner is never hidden behind its own loading page.
        zIndex: 3
      }}
    >
      <ActivityIndicator size="large" />
    </View>
  )
})

/* -------------------------------------------------------------------------- */
/*                                  BROWSER                                   */
/* -------------------------------------------------------------------------- */

/**
 * Isolated manifest/PWA-redirect watcher. It reads the active tab's churny
 * `isLoading` (plus id/url) so the SUBSCRIPTION lives here, not in Browser — a
 * streaming page that toggles isLoading on every nav-state tick would otherwise
 * re-render the entire Browser tree (and starve the JS thread when the menu
 * popover is opening). Renders nothing.
 */
const ManifestWatcher = observer(function ManifestWatcher({
  onRedirect
}: {
  onRedirect: (startUrl: string) => void
}) {
  const { fetchManifest, getStartUrl, shouldRedirectToStartUrl } = useWebAppManifest()
  const activeTab = tabStore.activeTab
  const tabId = activeTab?.id
  const tabUrl = activeTab?.url
  const isLoading = activeTab?.isLoading

  useEffect(() => {
    if (tabId === undefined || !tabUrl) return
    let isCancelled = false

    const handleManifest = async () => {
      const currentUrl = tabUrl
      if (currentUrl === kNEW_TAB_URL || !currentUrl.startsWith('http') || isLoading) return
      if (isCancelled) return
      try {
        const manifestData = await fetchManifest(currentUrl)
        if (isCancelled) return
        if (manifestData && shouldRedirectToStartUrl(manifestData, currentUrl)) {
          onRedirect(getStartUrl(manifestData, currentUrl))
        }
      } catch {}
    }

    const timeoutId = setTimeout(() => {
      if (!isLoading && tabUrl !== kNEW_TAB_URL && tabUrl.startsWith('http')) {
        // Defer manifest probing until chrome interactions settle — the fetch
        // + JSON parse on the JS thread was competing with tab-switch taps.
        InteractionManager.runAfterInteractions(() => {
          if (!isCancelled) handleManifest()
        })
      }
    }, 1000)

    return () => {
      isCancelled = true
      clearTimeout(timeoutId)
    }
  }, [tabId, isLoading, tabUrl, fetchManifest, getStartUrl, shouldRedirectToStartUrl, onRedirect])

  return null
})

const Browser = observer(function Browser() {
  useRenderCount('Browser') // dev-only: logs a re-render storm; zero-cost in prod
  /* --------------------------- theme / basic hooks -------------------------- */
  const { isDark, colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { i18n } = useTranslation()
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
  const { managers, walletBuilding } = useWalletManagers()
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

  const captureActiveThumbnail = useCallback(async () => {
    if (!activeTab || activeTab.url === kNEW_TAB_URL) return
    // Defer the captureRef rasterization until the JS thread is idle so it never
    // competes with chrome animations or active page scrolls. The thumbnail is
    // only consumed when the tabs grid is opened or on backgrounding, so a few
    // hundred ms of latency is invisible to the user.
    await new Promise<void>(resolve => InteractionManager.runAfterInteractions(() => resolve()))
    // Snapshot the live url BEFORE the await chain so we tag the thumbnail with
    // the host that was actually on screen, not wherever the tab navigated to
    // mid-capture.
    const capturedHost = hostOf(activeTab.url)
    const uri = await captureThumbnail(webviewContainerRef, activeTab.id)
    if (uri) tabStore.setThumbnail(activeTab.id, uri, capturedHost)
  }, [activeTab])

  // Recapture policy: only the ACTIVE tab can be snapshotted (its container holds
  // the capture ref). While a tab stays on one host the existing thumbnail is
  // fine; when the host changes the old snapshot is wrong, so dump it and grab a
  // fresh one after the new page settles. Same-host in-page navigation (SPA
  // routes, fragments) is intentionally ignored — no churn.
  useEffect(() => {
    if (!activeTab || activeTab.url === kNEW_TAB_URL) return
    const host = hostOf(activeTab.url)
    if (!host || host === activeTab.thumbnailHost) return
    // Host changed → drop the stale snapshot, then recapture once the page paints.
    tabStore.dumpThumbnail(activeTab.id)
    if (thumbnailCaptureTimer.current) clearTimeout(thumbnailCaptureTimer.current)
    thumbnailCaptureTimer.current = setTimeout(() => {
      thumbnailCaptureTimer.current = null
      captureActiveThumbnail()
    }, 1200)
    return () => {
      if (thumbnailCaptureTimer.current) {
        clearTimeout(thumbnailCaptureTimer.current)
        thumbnailCaptureTimer.current = null
      }
    }
  }, [activeTab, activeTab?.url, activeTab?.thumbnailHost, captureActiveThumbnail])

  // iOS memory hygiene: on backgrounding capture the current tab thumbnail so the
  // user sees an up-to-date snapshot on return, and on memoryWarning purge inactive
  // tab WebView caches. Without this the app accumulates view-shot files and
  // unbounded WK caches until the OS terminates the process.
  useMemoryHygiene({
    onBackground: () => {
      captureActiveThumbnail()
      // Force any pending debounced tab persist to disk before the OS can
      // suspend/kill us, so state is never lost on a cold kill within the
      // saveTabs() debounce window.
      tabStore.flushTabs().catch(() => {})
    },
    onMemoryWarning: () => {
      tabStore.purgeInactiveTabResources()
    }
  })

  /* -------------------------- ui / animation state -------------------------- */
  // The entire nav-chrome subsystem (address state, popovers, collapse/glass,
  // find-in-page, gesture animation) now lives in <AddressBar/>. Browser keeps
  // only the shell-level flags it still owns and reads the two cross-cutting
  // booleans (addressFocused, addressBarAtTop) from uiStore as an observer.

  // Imperative handle into AddressBar so the new-tab / homepage lifecycle
  // effects below — which read tabStore + persisted homepageUrl and naturally
  // live here — can still focus/select the address input (whose ref + editing
  // flag are owned by AddressBar).
  const addressBarRef = useRef<AddressBarHandle>(null)

  const [showTabsView, setShowTabsView] = useState(false)

  // Page-load progress bar: 0 = idle/hidden, 0..0.9 = loading, 1 = done (fades
  // out). Webview load events set it (WebViewHost); passed to AddressBar for the
  // LoadProgressBar render.
  const loadProgress = useSharedValue(0)

  const [isFullscreen, setIsFullscreen] = useState(false)
  // Stable identity so passing it to the memoized WebViewHost doesn't break memo.
  const onExitFullscreen = useCallback(() => setIsFullscreen(false), [])

  // When the Browser screen regains focus after returning from a pushed route
  // (transactions, payments, wallet-config, …) close any lingering menu sheet so
  // the wallet menu's Settings sheet doesn't sit open over the page on back.
  // Opening an in-screen sheet does NOT blur Browser, so normal sheet use is
  // unaffected — this only fires on return from a full-screen route. `sheet` is
  // read through a ref so this callback stays stable (depending on `sheet`
  // directly would re-run on every sheet open and instantly close it).
  // (The menu-popover close + glass remount on focus live in AddressBar.)
  const sheetRef = useRef(sheet)
  sheetRef.current = sheet
  useFocusEffect(
    useCallback(() => {
      sheetRef.current.close()
    }, [])
  )

  // Geometry used by native chrome overlays and scroll indicators. The WebView
  // itself remains full-height; users can collapse the address bar when it
  // covers page controls. Reads the address-bar position from uiStore (single
  // source of truth, mirrored by the animation hook).
  const bottomReservedHeight =
    !uiStore.addressBarAtTop && !isFullscreen ? safeBottomInset(insets.bottom) + ADDRESS_BAR_HEIGHT : 0

  // Keep scroll bars visible around the floating chrome without changing the
  // webpage viewport or injecting layout styles into the document.
  const webviewScrollIndicatorInsets = useMemo(
    () => ({
      top: uiStore.addressBarAtTop ? ADDRESS_BAR_HEIGHT : 0,
      bottom: uiStore.addressBarAtTop ? bottomInset : bottomReservedHeight,
      left: 0,
      right: 0
    }),
    [uiStore.addressBarAtTop, bottomReservedHeight, bottomInset]
  )
  const webviewContainerStyle = useMemo(() => ({ backgroundColor: isDark ? '#000' : '#fff' }), [isDark])
  const webviewStyle = useMemo(() => ({ flex: 1 }), [])

  const activeCameraStreams = useRef<Set<string>>(new Set())
  const historyDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (historyDebounceTimer.current) clearTimeout(historyDebounceTimer.current)
      if (thumbnailCaptureTimer.current) clearTimeout(thumbnailCaptureTimer.current)
    }
  }, [])

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
      uiStore.setAddressFocused(false)
    }
  }, [activeTab])

  // When true, the next blank tab will skip homepage navigation (e.g. user explicitly opened new tab)
  const skipHomepageOnce = useRef(false)

  // When true, focus and highlight the address bar after the next homepage navigation
  const focusAddressBarOnNewTab = useRef(false)

  // The tab ID of a tab opened via the new tab button that can be "cancelled" (closed to go back)
  const cancelableNewTabId = useRef<number | null>(null)

  // Tabs whose last load was cancelled by the user. A cancelled provisional
  // navigation never commits, so the WKWebView's own URL still points at the
  // PREVIOUS document (about:blank on a fresh tab) while tab.url holds the
  // target the user actually wanted. Native reload() would re-show the stale
  // document — the refresh button must re-navigate to tab.url instead.
  // Written/read by AddressBar's cancel/reload handlers; cleared here in
  // handleNavStateChange (the WebView event source) the moment a new load starts.
  const cancelledLoadTabIds = useRef<Set<number>>(new Set())

  // Reset progress bar on tab switch so stale progress from the old tab never bleeds into the new one.
  useEffect(() => {
    loadProgress.value = 0
  }, [activeTab?.id]) // eslint-disable-line react-hooks/exhaustive-deps

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
        // Navigating the tab updates tab.url; AddressBar's url-sync reflects it
        // into the input (no direct setAddressText needed across the boundary).
        tabStore.updateTab(tabStore.activeTabId, { url })
        setHomepageUrlState(url)
        if (shouldFocusAddressBar) {
          // The input ref + editing flag live in AddressBar — go through its
          // imperative handle to focus and select the homepage URL.
          setTimeout(() => {
            addressBarRef.current?.beginEditing(url)
          }, 150)
        }
      }
    })()
  }, [activeTab?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-focus on new tab (only if still blank — homepage navigation may have kicked in)
  useEffect(() => {
    if (activeTab && activeTab.url === kNEW_TAB_URL && !uiStore.addressFocused) {
      const tabId = activeTab.id
      const timer = setTimeout(() => {
        if (tabStore.activeTab?.id === tabId && tabStore.activeTab?.url === kNEW_TAB_URL) {
          addressBarRef.current?.focusInput()
        }
      }, 100)
      return () => clearTimeout(timer)
    }
  }, [activeTab, activeTab?.id, activeTab?.url, uiStore.addressFocused])

  // Ensure at least one tab exists; never leave the user on an empty browser.
  useEffect(() => {
    if (tabStore.tabs.length === 0 && tabStore.isInitialized) {
      tabStore.newTab()
      uiStore.setAddressFocused(false)
      Keyboard.dismiss()
    }
  }, [])

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

  /**
   * Inject a minimal loading splash (spinner + target host) into the active
   * WebView the instant the user commits to a navigation, before the WK
   * native nav has produced any pixels. Eliminates the perceived dead-air
   * between address-bar submit and the new page's first paint.
   *
   * Called from `onAddressSubmit` and the suggestion-tap handler — both
   * user-initiated navigation paths. Programmatic URL changes (manifest
   * start-url redirect, hybrid history goBack/goForward) skip the splash
   * since those already render through other affordances.
   */
  const injectNavigationSplash = useCallback((url: string) => {
    const ref = tabStore.activeTab?.webviewRef?.current
    if (!ref) return
    if (!/^https?:\/\//i.test(url)) return
    try {
      const html = escapeForTemplateLiteral(navigationLoadingPage(url))
      ref.injectJavaScript(`document.open();document.write(\`${html}\`);document.close();`)
    } catch {
      // Non-fatal — splash is a UX nicety, not required.
    }
  }, [])

  const handleNewTab = useCallback(() => {
    focusAddressBarOnNewTab.current = true
    tabStore.newTab()
    cancelableNewTabId.current = tabStore.activeTabId
    setShowTabsView(false)
    // The menu popover (if the new tab was opened from it) closes itself inside
    // AddressBar via its dismiss wrapper, so no cross-boundary close is needed.
  }, [])

  /* -------------------------------------------------------------------------- */
  /*                           WEBVIEW MESSAGE HANDLER                          */
  /* -------------------------------------------------------------------------- */

  const injectedJavaScript = useMemo(
    () =>
      buildInjectedJavaScript(
        getAcceptLanguageHeader(),
        Platform.OS === 'android',
        __DEV__,
        !isWeb2Mode,
        shouldForwardWebViewLogs()
      ),
    [getAcceptLanguageHeader, isWeb2Mode]
  )

  // Standalone blob download intercept — plain JS string injected before content loads.
  // Must NOT rely on the polyfill (different WKWebView content world on iOS).
  // Memoized (deps: []) so this multi-KB script string is built once per mount
  // instead of on every render.
  const downloadInterceptScript = useMemo(
    () => `(function(){
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
  })();true;`,
    []
  )

  // Built once per change of permission state instead of on every render. Previously
  // this multi-KB concat (CWI provider + polyfills + permission script) ran on all
  // ~500 renders during a browse session, feeding a fresh string into the WebView
  // each time and forcing the whole WebView subtree to reconcile.
  const injectedJSBefore = useMemo(
    () =>
      nativeSpoofSetup +
      '\n' +
      (isWeb2Mode ? '' : buildCWIProviderScript() + '\n') +
      mediaSourcePolyfill +
      '\n' +
      downloadInterceptScript +
      '\n' +
      getPermissionScript(permissionsDeniedForCurrentDomain, pendingPermission),
    [downloadInterceptScript, isWeb2Mode, permissionsDeniedForCurrentDomain, pendingPermission]
  )

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
    async (tabId: number, event: WebViewMessageEvent) => {
      if (!activeTab) return
      // Warm background tabs stay mounted and their pages keep running; ignore
      // their messages so only the visible tab can drive wallet/CWI calls and
      // address-bar UI. (Their messages would also resolve against the wrong
      // origin/webviewRef.) A backgrounded page's call simply waits until the
      // user returns to it.
      if (tabId !== activeTab.id) return

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
      const endParse = perf.mark('webview.message.parse')
      try {
        msg = JSON.parse(event.nativeEvent.data)
      } catch {
        endParse()
        return
      }
      endParse()
      // Records frequency-per-type so a chatty page (e.g. CONSOLE flood) is
      // obvious in perf.dump(). Zero-cost in production.
      perf.measure(`webview.message:${msg?.type}`, 0)

      if (msg.type === 'FIND_IN_PAGE_RESULT') {
        // Find-in-page state lives in AddressBar; forward the result through its
        // imperative handle (the WebView message bridge stays in the shell).
        addressBarRef.current?.onFindInPageResult(msg.current ?? 0, msg.total ?? 0, !!msg.capped)
        return
      }

      if (msg.type === 'DL_DEBUG') {
        console.warn('[DL_DEBUG]', msg.info)
        return
      }

      if (msg.type === 'CONSOLE') {
        // Relaying every page console.* call onto the RN JS thread is a major
        // jank source on chatty pages (each call serializes args + crosses the
        // bridge). Off by default; toggle via the dev menu when debugging a page.
        if (!shouldForwardWebViewLogs()) return
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
            `document.open();document.write(\`${escapeForTemplateLiteral(paymentLoadingPage)}\`);document.close();`
          )
        }
        paymentHandlerRef.current
          .handle402(msg.url, msg.status, msg.headers || {})
          .then((html: string | null) => {
            if (html && activeTab?.webviewRef?.current) {
              activeTab.webviewRef.current.injectJavaScript(
                `document.open();document.write(\`${escapeForTemplateLiteral(html)}\`);document.close();`
              )
            }
          })
          .catch(() => {})
          .finally(() => {
            paymentInFlightUrl.current = null
          })
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

      // Yield to any in-flight interaction (Reanimated spring on the address bar,
      // sheet open animation, scroll gesture) before kicking off ECDSA / KeyDeriver
      // work. Heavy wallet ops awaited inline on the JS thread used to compete with
      // chrome animations on iPhone SE. InteractionManager.runAfterInteractions
      // resolves immediately when the JS thread is idle, so auto-approved micros
      // pay no extra cost.
      //
      // Tiered scheduling: L0 (fixed in-memory answers) and L1 (crypto) methods
      // skip the yield entirely. dApps fire storms of getPublicKey / getNetwork /
      // isAuthenticated on page load; making each wait a frame for
      // runAfterInteractions adds latency for no benefit — they touch no storage
      // and don't contend with chrome the way an L3 createAction does. Only
      // L2 (reads) and L3 (mutations) keep the yield.
      if (!CWI_NO_YIELD.has(msg.call)) {
        await new Promise<void>(resolve => InteractionManager.runAfterInteractions(() => resolve()))
      }

      const perfEnd = mark(`cwi.${msg.call}`)
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
      } finally {
        perfEnd()
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
  // useCallback keeps the WebView's onNavigationStateChange prop identity stable
  // across Browser re-renders that don't touch activeTab — otherwise every chrome
  // animation tick reassigned this prop and the native WebView module had to
  // re-bind its bridge listener.
  const handleNavStateChange = useCallback(
    (tabId: number, navState: WebViewNavigation) => {
      // Any new load supersedes a user-cancelled one — refresh goes back to
      // meaning native reload() for this tab. Runs before the active-tab
      // filter so background tabs clear their flag too.
      if (navState.loading) cancelledLoadTabIds.current.delete(tabId)
      if (!activeTab) return
      // Only the active tab drives the address bar / global history. Per-tab
      // navigation history is still recorded for every tab via the WebView's
      // onLoadEnd → tabStore.handleNavigationStateChange(tabId, …) path.
      if (tabId !== activeTab.id) return
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
      // tabStore writes the clean URL onto tab.url; AddressBar's url-sync effect
      // (which guards on its own editing flag) reflects it into the input.
      const cleanUrl = normalizeUrlForHistory(navState.url)

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
    },
    [activeTab, pushHistory]
  )

  /* -------------------------------------------------------------------------- */
  /*                              MANIFEST HANDLING                             */
  /* -------------------------------------------------------------------------- */
  // The reactive isLoading/url subscription lives in <ManifestWatcher/> (rendered
  // below) so Browser doesn't re-render on every nav-state tick. This is just the
  // redirect sink it calls back into.
  const handleManifestRedirect = useCallback((startUrl: string) => {
    // updateActiveTab writes tab.url; AddressBar's url-sync reflects it.
    updateActiveTab({ url: startUrl })
  }, [updateActiveTab])

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

  const [ready, setReady] = useState(false)
  useEffect(() => {
    const handle = InteractionManager.runAfterInteractions(() => setReady(true))
    return () => handle.cancel?.()
  }, [])

  // Cold-start warm-pool stagger: mount only the ACTIVE tab's WebView first and
  // defer the other warm hosts until the active page has painted (markActivePainted,
  // fired from the active host's onLoadEnd) — so N WebViews don't load over the
  // network concurrently and starve the active tab's first paint (the 8s
  // tab.switch.toPaint watchdog). Once flipped it stays true, so warm-switching
  // remains instant. Fallback timer flips it even if the active page never fires
  // onLoadEnd (slow/stuck), so background tabs still warm.
  const [backgroundWarmReady, setBackgroundWarmReady] = useState(false)
  const markActivePainted = useCallback(() => setBackgroundWarmReady(true), [])
  useEffect(() => {
    if (isWeb2Mode || !walletBuilding) {
      const t = setTimeout(() => setBackgroundWarmReady(true), 5000)
      return () => clearTimeout(t)
    }
  }, [isWeb2Mode, walletBuilding])

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
  const isNewTab = activeTab?.url === kNEW_TAB_URL

  const renderHost = (tab: Tab, active: boolean) => (
    <WebViewHost
      key={tab.id}
      tabId={tab.id}
      isActive={active}
      isWarm={tabStore.isWarm(tab.id)}
      webviewRef={tab.webviewRef}
      // Only the active host feeds the thumbnail-capture ref — a shared ref
      // across mounted hosts would clobber and capture the wrong tab.
      containerRef={active ? webviewContainerRef : undefined}
      uri={(() => {
        // Drive the WebView source from sourceUrl (the last explicitly-commanded
        // URL), NOT the live tab.url. This is what stops passive nav-state
        // updates — SPA fragment/route changes WK reports as the base URL — from
        // reloading the WebView and navigating the page away. Fall back to url
        // for any tab persisted before the split.
        const src = tab.sourceUrl ?? tab.url
        return typeof src === 'string' && src.length > 0 ? src : 'about:blank'
      })()}
      isDesktopMode={tab.isDesktopMode ?? false}
      isFullscreen={active && isFullscreen}
      onExitFullscreen={onExitFullscreen}
      topInset={insets.top}
      isDark={isDark}
      acceptLanguage={getAcceptLanguageHeader()}
      isWeb2Mode={isWeb2Mode}
      injectedJavaScript={injectedJavaScript}
      injectedJSBefore={injectedJSBefore}
      onMessage={handleMessage}
      onNavStateChange={handleNavStateChange}
      paymentHandlerRef={paymentHandlerRef}
      paymentInFlightUrl={paymentInFlightUrl}
      webviewScrollIndicatorInsets={webviewScrollIndicatorInsets}
      webviewContainerStyle={webviewContainerStyle}
      webviewStyle={webviewStyle}
      loadProgress={loadProgress}
      onActivePainted={active ? markActivePainted : undefined}
    />
  )

  const renderMainContent = () => {
    // Block on the wallet only when the ACTIVE tab is a web page in web3 mode —
    // mounting it before the wallet is ready would let the page issue CWI calls
    // too early. The homepage (new tab) needs no wallet, so it never blocks.
    if (!walletReady && !isNewTab) {
      return (
        <View style={[styles.loaderContainer, { backgroundColor: isDark ? '#000' : '#fff' }]}>
          <ActivityIndicator size="large" />
        </View>
      )
    }

    // Warm pool: keep a WebView mounted for each recently-used web-page tab so
    // switching between them is instant (no source reload). Only the active one
    // is visible & interactive; the rest stay alive but hidden. Gated on
    // walletReady so no warm tab mounts before the CWI provider is ready.
    const warmWebTabs = walletReady
      ? tabStore.warmTabIds
          .map(id => tabStore.tabs.find(t => t.id === id))
          .filter((t): t is Tab => !!t && t.url !== kNEW_TAB_URL && t.url.startsWith('http'))
      : []

    // Stagger cold-start mounting: until the active page has painted, render
    // ONLY the active warm host so it doesn't compete with 1-2 background loads.
    // After backgroundWarmReady flips, render the full warm pool (and keep it
    // mounted) so subsequent tab switches stay instant.
    const activeId = activeTab?.id
    const hostsToRender = backgroundWarmReady
      ? warmWebTabs
      : warmWebTabs.filter(tab => tab.id === activeId)

    return (
      <>
        {hostsToRender.map(tab => renderHost(tab, tab.id === activeId))}
        {/* Homepage cover: when the active tab is a new tab, paint over the warm
            background WebViews so they're invisible but stay mounted. */}
        {isNewTab && (
          <View
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: colors.background,
              zIndex: 2
            }}
          />
        )}
        <SwitchLoadingOverlay
          topInset={insets.top}
          bottomReservedHeight={bottomReservedHeight}
          addressBarIsAtTop={uiStore.addressBarAtTop}
          isFullscreen={isFullscreen}
          backgroundColor={colors.background}
        />
      </>
    )
  }

  return (
    <View style={[styles.container, { backgroundColor: isDark ? '#000' : '#fff' }]}>
      <StatusBar style={isDark ? 'light' : 'dark'} translucent hidden={isFullscreen} />
      <ManifestWatcher onRedirect={handleManifestRedirect} />

      {/* ---- Main content: WebView lives between the safe-area bars ----
          Deliberately OUTSIDE the KeyboardAvoidingView below. When the KAV
          wrapped the whole tree, focusing the address bar padded the entire
          screen by the keyboard height — synchronously resizing every warm
          WKWebView (up to WARM_POOL_SIZE full pages reflowing on the main
          thread, one possibly mid-load). That was a multi-second UI hang on
          address-bar tap. Only the chrome needs to avoid the keyboard; the
          page can sit under it, exactly like Safari. */}
      {renderMainContent()}

      {/* ---- Chrome layer: everything that must rise above the keyboard ---- */}
      <KeyboardAvoidingView
        style={StyleSheet.absoluteFill}
        pointerEvents="box-none"
        enabled={Platform.OS === 'ios' && uiStore.addressFocused}
        behavior="padding"
        keyboardVerticalOffset={0}
      >
        <View style={styles.chromeLayer} pointerEvents="box-none">
          {/* ---- Nav-chrome subsystem (address bar, popovers, find-in-page,
            collapse/glass) — extracted so keystrokes / page-load churn re-render
            only this component, not the 2000-line shell. */}
          <AddressBar
            ref={addressBarRef}
            loadProgress={loadProgress}
            isFullscreen={isFullscreen}
            updateActiveTab={updateActiveTab}
            injectNavigationSplash={injectNavigationSplash}
            cancelableNewTabId={cancelableNewTabId}
            cancelledLoadTabIds={cancelledLoadTabIds}
            onShowTabs={async () => {
              await captureActiveThumbnail()
              setShowTabsView(true)
            }}
            onNewTab={handleNewTab}
            onEnableWeb3={() => router.push('/auth/mnemonic')}
            onConnections={() => router.push('/connections')}
            onOpenSheet={route => sheet.push(route)}
            history={history}
            addBookmark={addBookmark}
          />

          {/* ---- Tabs Overview ---- */}
          {!isFullscreen && showTabsView && (
            <TabsOverview
              onDismiss={() => setShowTabsView(false)}
              setAddressFocused={uiStore.setAddressFocused}
              onNewTab={handleNewTab}
            />
          )}

          {/* ---- Unified Sheet System ---- */}
          <SheetRouter
            sheet={sheet}
            activeTab={activeTab}
            domainForUrl={domainForUrl}
            homepageUrl={homepageUrl}
            updateActiveTab={updateActiveTab}
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
    </View>
  )
})

/* -------------------------------------------------------------------------- */
/*                                   EXPORT                                   */
/* -------------------------------------------------------------------------- */

const BrowserWithSheet = observer(() => (
  <SheetProvider>
    <PerfProfiler id="Browser">
      <Browser />
    </PerfProfiler>
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
  // Fills the keyboard-avoiding chrome overlay; box-none so page touches pass
  // through everywhere the chrome isn't.
  chromeLayer: {
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
    zIndex: 20,
    // Collapse shrinks toward the right edge (where the ... menu button sits) so
    // the bar visibly tucks into the kebab — signalling that tapping ... brings
    // it back. Paired with scale/translate in animatedAddressBarStyle.
    transformOrigin: 'right center'
  }
})
