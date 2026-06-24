import { useCallback, useEffect, useRef } from 'react'
import { Linking } from 'react-native'
import { router, usePathname } from 'expo-router'
import tabStore from '@/stores/TabStore'
import {
  consumePendingInitialBrowserUrl,
  externalUrlsMatch,
  isExternalBrowserUrl,
  shouldHandleExternalBrowserUrl
} from '@/utils/externalUrlRouter'

/**
 * Simplified deep linking: when app receives http/https URL, navigate browser directly to it.
 * Also handles bsv-browser://pair?... URIs for wallet pairing QR codes scanned via the camera app.
 */
export function useDeepLinking() {
  const browserLinkQueue = useRef<Promise<void>>(Promise.resolve())
  const pathname = usePathname()
  const pathnameRef = useRef(pathname)

  useEffect(() => {
    pathnameRef.current = pathname
  }, [pathname])

  const handleBrowserLink = useCallback(async (url: string) => {
    try {
      // Wait for tabStore to initialize before attempting to handle deep link
      if (!tabStore.isInitialized) {
        console.log('[Deep Link] Waiting for tabStore to initialize...')
        // Wait up to 15 seconds for initialization. On a slow cold start (large
        // persisted tab/history JSON contending with the wallet build on the one
        // JS thread) init can exceed a few seconds; the old 5s cap silently DROPPED
        // the tapped link — the exact default-browser launch this app exists for.
        // The poll yields the thread each tick, so waiting longer is harmless.
        let attempts = 0
        while (!tabStore.isInitialized && attempts < 150) {
          await new Promise(resolve => setTimeout(resolve, 100))
          attempts++
        }

        if (!tabStore.isInitialized) {
          console.error('[Deep Link] TabStore failed to initialize, dropping URL')
          return
        }
      }

      // Navigate to browser if not already there. Use navigate() (reuses the
      // existing /index route) NOT push() — +native-intent already routes http
      // launches to '/', so push() here mounts a SECOND Browser on top (duplicate
      // that re-renders forever on every WalletContext/SSE tick = the storm).
      if (pathnameRef.current !== '/') {
        router.navigate('/')
      }

      // Create new tab or update active tab with the URL
      const activeTab = tabStore.activeTab
      if (activeTab && externalUrlsMatch(activeTab.url, url)) {
        // The same cold-start URL can arrive through both native-intent and
        // Linking. Keep the already-open page instead of spawning another tab.
        return
      }

      // Show the loading overlay while the WebView fetches the page, instead of
      // a blank screen (or the +not-found flash before this handler runs).
      tabStore.raiseLoadingForUrl(url)

      if (activeTab && activeTab.url === 'about:blank') {
        // Update existing blank tab
        tabStore.updateTab(activeTab.id, { url })
      } else {
        // Create new tab with URL
        tabStore.newTab(url)
      }
    } catch (error) {
      console.error('[Deep Link] Error handling URL:', error)
      router.navigate('/')
    }
  }, [])

  const enqueueBrowserLink = useCallback(
    (url: string) => {
      if (!shouldHandleExternalBrowserUrl(url)) {
        console.log('[Deep Link] Ignoring duplicate URL delivery:', url)
        return
      }

      // Serialize URL deliveries so two nearly-simultaneous app-open events
      // cannot both inspect the same active tab and create duplicate WebViews.
      browserLinkQueue.current = browserLinkQueue.current.catch(() => {}).then(() => handleBrowserLink(url))
    },
    [handleBrowserLink]
  )

  const handlePeerPayLink = useCallback((url: string) => {
    router.replace({ pathname: '/payments', params: { peerpay: url } })
  }, [])

  /**
   * Handle bsv-browser://pair?topic=...&backendIdentityKey=...&protocolID=...&origin=...&expiry=...&sig=...
   *
   * Used by external QR codes (e.g. scanned via the iOS/Android camera app). Parses pairing
   * parameters from the URI and navigates directly to /pair, bypassing the connections screen.
   * The connections screen is reserved for pairing initiated manually within the app.
   */
  const handlePairingLink = useCallback((url: string) => {
    try {
      // bsv-browser://pair?topic=... — URL constructor needs a valid base
      const parsed = new URL(url.replace('bsv-browser://', 'bsv-browser://host/'))
      const get = (key: string) => parsed.searchParams.get(key) ?? undefined

      const topic = get('topic')
      const backendIdentityKey = get('backendIdentityKey')
      const protocolID = get('protocolID')
      const origin = get('origin')
      const expiry = get('expiry')
      const sig = get('sig')

      if (!topic || !backendIdentityKey || !protocolID || !origin || !expiry) {
        console.warn('[Deep Link] Pairing link missing required params, ignoring:', url)
        return
      }

      router.push({
        pathname: '/connections',
        params: { topic, backendIdentityKey, protocolID, origin, expiry, sig }
      })
    } catch (error) {
      console.error('[Deep Link] Error handling pairing link:', error)
    }
  }, [])

  useEffect(() => {
    let active = true

    const handleUrl = (url: string) => {
      if (!url) return
      if (isExternalBrowserUrl(url)) {
        console.log('[Deep Link] Opening URL directly:', url)
        enqueueBrowserLink(url)
      } else if (url.startsWith('bsv-browser://pair')) {
        console.log('[Deep Link] Opening pairing screen:', url)
        handlePairingLink(url)
      } else if (url.toLowerCase().startsWith('peerpay:')) {
        console.log('[Deep Link] Opening payments screen:', url)
        handlePeerPayLink(url)
      }
    }

    // Expo Router captures the initial browser URL first. Consume that value
    // when available; retain Linking.getInitialURL as a fallback for platforms
    // where redirectSystemPath did not run.
    const pendingInitialUrl = consumePendingInitialBrowserUrl()
    if (pendingInitialUrl) {
      handleUrl(pendingInitialUrl)
    } else {
      Linking.getInitialURL()
        .then(url => {
          if (active && url) handleUrl(url)
        })
        .catch(error => console.error('[Deep Link] Failed to read initial URL:', error))
    }

    const subscription = Linking.addEventListener('url', event => handleUrl(event.url))
    return () => {
      active = false
      subscription.remove()
    }
  }, [enqueueBrowserLink, handlePairingLink, handlePeerPayLink])
}

// Legacy exports - no longer used but kept for backward compatibility
export const setPendingUrl = async (_url: string) => {
  console.warn('[Deep Link] setPendingUrl is deprecated - URLs are now opened directly')
}

export const getPendingUrl = async (): Promise<string | null> => {
  return null // Always return null - no more pending URLs
}

export const clearPendingUrl = async () => {
  // No-op - nothing to clear
}
