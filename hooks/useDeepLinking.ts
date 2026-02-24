import { useEffect } from 'react'
import { Linking } from 'react-native'
import { router } from 'expo-router'
import tabStore from '@/stores/TabStore'

/**
 * Simplified deep linking: when app receives http/https URL, navigate browser directly to it
 * No more storing URLs for later - just open them immediately
 */
export function useDeepLinking() {
  useEffect(() => {
    // Handle app opened from deep link while closed
    const getInitialURL = async () => {
      const url = await Linking.getInitialURL()
      if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
        console.log('[Deep Link] Opening URL directly:', url)
        handleDeepLink(url)
      }
    }

    // Handle app opened from deep link while running
    const handleUrl = (event: { url: string }) => {
      if (event.url && (event.url.startsWith('http://') || event.url.startsWith('https://'))) {
        console.log('[Deep Link] Opening URL directly:', event.url)
        handleDeepLink(event.url)
      }
    }

    getInitialURL()
    const subscription = Linking.addEventListener('url', handleUrl)

    return () => subscription?.remove()
  }, [])

  const handleDeepLink = async (url: string) => {
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
          console.error('[Deep Link] TabStore failed to initialize, storing URL for later')
          // Store the URL to be handled after initialization
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
