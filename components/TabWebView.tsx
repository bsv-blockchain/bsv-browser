import React, { useMemo } from 'react'
import { View, StyleSheet } from 'react-native'
import { WebView, WebViewMessageEvent, WebViewNavigation } from 'react-native-webview'
import { Tab } from '@/shared/types/browser'

/**
 * A single tab's WebView, kept mounted while the tab is "warm" (see
 * TabStore.warmTabIds) so switching back to it is instant and preserves page
 * state — no reload. Inactive tabs render hidden (absolute, transparent, no
 * touches) but stay alive.
 *
 * Memoized: inactive tabs receive stable props (isActive=false, handlers
 * undefined) so they don't re-render — and crucially never remount — when the
 * active tab changes. A re-render with the same `source.uri` does NOT reload the
 * page; only unmount/remount or a uri change does.
 *
 * Interactive handlers (onMessage / onNavigationStateChange) are wired ONLY for
 * the active tab. Background tabs must not be able to drive wallet actions or
 * the address bar.
 */
export interface TabWebViewProps {
  tab: Tab
  isActive: boolean
  injectedJavaScript: string
  acceptLanguage: string
  userAgent: string
  backgroundColor: string
  onMessage: (event: WebViewMessageEvent) => void
  onNavigationStateChange: (navState: WebViewNavigation) => void
  onLoadEnd: () => void
  onError: (syntheticEvent: any) => void
  onHttpError: (syntheticEvent: any) => void
}

function TabWebViewBase({
  tab,
  isActive,
  injectedJavaScript,
  acceptLanguage,
  userAgent,
  backgroundColor,
  onMessage,
  onNavigationStateChange,
  onLoadEnd,
  onError,
  onHttpError
}: TabWebViewProps) {
  // Stable per-url source so identity changes don't nudge the WebView to reload.
  const source = useMemo(
    () => ({ uri: tab.url, headers: { 'Accept-Language': acceptLanguage } }),
    [tab.url, acceptLanguage]
  )

  return (
    <View
      // Active sits at the default layer (z 0) so later siblings — the loading
      // overlay, scanner — still render on top, as before. Inactive tabs go
      // behind everything (z -1), transparent and untouchable but kept alive.
      style={[StyleSheet.absoluteFill, { opacity: isActive ? 1 : 0, zIndex: isActive ? 0 : -1 }]}
      pointerEvents={isActive ? 'auto' : 'none'}
    >
      <WebView
        ref={tab.webviewRef}
        source={source}
        originWhitelist={['https://*', 'http://*']}
        onMessage={isActive ? onMessage : undefined}
        injectedJavaScript={injectedJavaScript}
        onNavigationStateChange={isActive ? onNavigationStateChange : undefined}
        onLoadEnd={isActive ? onLoadEnd : undefined}
        userAgent={userAgent}
        onError={onError}
        onHttpError={onHttpError}
        javaScriptEnabled
        domStorageEnabled
        allowsBackForwardNavigationGestures
        containerStyle={{ backgroundColor }}
        style={{ flex: 1 }}
      />
    </View>
  )
}

export const TabWebView = React.memo(TabWebViewBase)
