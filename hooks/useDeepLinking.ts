import { useEffect } from 'react'
import { Linking } from 'react-native'
import { router } from 'expo-router'
import tabStore from '@/stores/TabStore'
import { parsePeerPayURI } from '@/utils/parsePeerPayURI'

/**
 * Simplified deep linking: when app receives http/https URL, navigate browser directly to it.
 * Also handles bsv-browser://pair?... URIs for wallet pairing QR codes scanned via the camera app.
 */
export function useDeepLinking() {
  useEffect(() => {
    // Handle app opened from deep link while closed
    const getInitialURL = async () => {
      const url = await Linking.getInitialURL()
      if (!url) return
      if (url.startsWith('http://') || url.startsWith('https://')) {
        console.log('[Deep Link] Opening URL directly:', url)
        handleBrowserLink(url)
      } else if (url.startsWith('bsv-browser://pair')) {
        console.log('[Deep Link] Opening pairing screen:', url)
        handlePairingLink(url)
      } else if (url.toLowerCase().startsWith('peerpay:')) {
        console.log('[Deep Link] Opening payments screen:', url)
        handlePeerPayLink(url)
      }
    }

    // Handle app opened from deep link while running
    const handleUrl = (event: { url: string }) => {
      const url = event.url
      if (!url) return
      if (url.startsWith('http://') || url.startsWith('https://')) {
        console.log('[Deep Link] Opening URL directly:', url)
        handleBrowserLink(url)
      } else if (url.startsWith('bsv-browser://pair')) {
        console.log('[Deep Link] Opening pairing screen:', url)
        handlePairingLink(url)
      } else if (url.toLowerCase().startsWith('peerpay:')) {
        console.log('[Deep Link] Opening payments screen:', url)
        handlePeerPayLink(url)
      }
    }

    getInitialURL()
    const subscription = Linking.addEventListener('url', handleUrl)

    return () => subscription?.remove()
  }, [])

  const handleBrowserLink = async (url: string) => {
    try {
      // Wait for tabStore to initialize before attempting to handle deep link
      if (!tabStore.isInitialized) {
        console.log('[Deep Link] Waiting for tabStore to initialize...')
        // Wait up to 5 seconds for initialization
        let attempts = 0
        while (!tabStore.isInitialized && attempts < 50) {
          await new Promise(resolve => setTimeout(resolve, 100))
          attempts++
        }

        if (!tabStore.isInitialized) {
          console.error('[Deep Link] TabStore failed to initialize, dropping URL')
          return
        }
      }

      // Navigate to browser if not already there
      router.push('/')

      // Create new tab or update active tab with the URL
      const activeTab = tabStore.activeTab
      if (activeTab && activeTab.url === 'about:blank') {
        // Update existing blank tab
        tabStore.updateTab(activeTab.id, { url })
      } else {
        // Create new tab with URL
        tabStore.newTab(url)
      }
    } catch (error) {
      console.error('[Deep Link] Error handling URL:', error)
      router.push('/')
    }
  }

  const handlePeerPayLink = (url: string) => {
    const parsed = parsePeerPayURI(url)
    if (!parsed) {
      console.warn('[Deep Link] Invalid peerpay URI:', url)
      router.replace('/payments')
      return
    }
    const params: Record<string, string> = { identityKey: parsed.identityKey }
    if (parsed.sats !== undefined) params.sats = String(parsed.sats)
    router.replace({ pathname: '/payments', params })
  }

  /**
   * Handle bsv-browser://pair?topic=...&backendIdentityKey=...&protocolID=...&origin=...&expiry=...&sig=...
   *
   * Used by external QR codes (e.g. scanned via the iOS/Android camera app). Parses pairing
   * parameters from the URI and navigates directly to /pair, bypassing the connections screen.
   * The connections screen is reserved for pairing initiated manually within the app.
   */
  const handlePairingLink = (url: string) => {
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
  }
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
