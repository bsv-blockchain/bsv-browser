import { useState, useRef } from 'react'

interface WebAppManifest {
  name?: string
  short_name?: string
  start_url?: string
  scope?: string
  display?: string
  background_color?: string
  theme_color?: string
  icons?: Array<{
    src: string
    sizes: string
    type: string
  }>
  babbage?: {
    protocolPermissions?: {
      [key: string]: string
    }
  }
}

export const useWebAppManifest = () => {
  const [manifest, setManifest] = useState<WebAppManifest | null>(null)
  const [loading, setLoading] = useState(false)

  // Cache to prevent repeated fetches
  const manifestCache = useRef<Map<string, WebAppManifest | null>>(new Map())
  const fetchPromises = useRef<Map<string, Promise<WebAppManifest | null>>>(new Map())

  const fetchManifest = async (websiteUrl: string): Promise<WebAppManifest | null> => {
    try {
      const url = new URL(websiteUrl)
      const baseUrl = `${url.protocol}//${url.host}`

      // Check cache first
      if (manifestCache.current.has(baseUrl)) {
        const cached = manifestCache.current.get(baseUrl)
        if (cached !== undefined) {
          setManifest(cached)
          return cached
        }
      }

      // Check if already fetching
      if (fetchPromises.current.has(baseUrl)) {
        return await fetchPromises.current.get(baseUrl)!
      }

      setLoading(true)

      const fetchPromise = performManifestFetch(baseUrl)
      fetchPromises.current.set(baseUrl, fetchPromise)

      try {
        const result = await fetchPromise

        // Cache the result
        manifestCache.current.set(baseUrl, result)
        setManifest(result)

        return result
      } finally {
        // Clean up
        fetchPromises.current.delete(baseUrl)
        setLoading(false)
      }
    } catch (error) {
      console.error('Error fetching manifest:', error)
      setManifest(null)
      return null
    }
  }

  const performManifestFetch = async (baseUrl: string): Promise<WebAppManifest | null> => {
    // Try manifest.json first
    const manifestUrl = `${baseUrl}/manifest.json`

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)

      const response = await fetch(manifestUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json, application/manifest+json'
        },
        signal: controller.signal
      })

      clearTimeout(timeout)

      if (response.ok) {
        const manifestData = await response.json()
        return manifestData
      }
    } catch {
      // Manifest.json not found, try HTML fallback
    }

    // Try parsing HTML for manifest link
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)

      const htmlResponse = await fetch(baseUrl, {
        signal: controller.signal
      })

      clearTimeout(timeout)

      if (htmlResponse.ok) {
        const html = await htmlResponse.text()
        const manifestLinkMatch = html.match(/<link[^>]*rel=["']manifest["'][^>]*href=["']([^"']*)["'][^>]*>/i)

        if (manifestLinkMatch) {
          const manifestPath = manifestLinkMatch[1]
          const manifestUrl = manifestPath.startsWith('http')
            ? manifestPath
            : `${baseUrl}${manifestPath.startsWith('/') ? '' : '/'}${manifestPath}`

          const response = await fetch(manifestUrl, {
            headers: {
              Accept: 'application/json, application/manifest+json'
            }
          })

          if (response.ok) {
            const manifestData = await response.json()
            return manifestData
          }
        }
      }
    } catch {
      // HTML parsing failed
    }

    return null
  }

  const getStartUrl = (manifest: WebAppManifest | null, currentUrl: string): string => {
    if (!manifest?.start_url) {
      return currentUrl
    }

    const url = new URL(currentUrl)
    const baseUrl = `${url.protocol}//${url.host}`

    // Handle different start_url formats
    if (manifest.start_url.startsWith('/')) {
      return `${baseUrl}${manifest.start_url}`
    } else if (manifest.start_url.startsWith('http')) {
      return manifest.start_url
    } else if (manifest.start_url === '.') {
      return currentUrl
    } else {
      return `${baseUrl}/${manifest.start_url}`
    }
  }

  const shouldRedirectToStartUrl = (manifest: WebAppManifest | null, currentUrl: string): boolean => {
    if (!manifest?.start_url) {
      return false
    }

    // Don't redirect if start_url is "."
    if (manifest.start_url === '.') {
      return false
    }

    const url = new URL(currentUrl)
    const pathname = url.pathname

    // Redirect if on root path and start_url is different
    return pathname === '/' && manifest.start_url !== '/' && manifest.start_url !== '.'
  }

  const getBabbagePermissions = (manifest: WebAppManifest | null): { [key: string]: string } | null => {
    return manifest?.babbage?.protocolPermissions || null
  }

  return {
    manifest,
    loading,
    fetchManifest,
    getStartUrl,
    shouldRedirectToStartUrl,
    getBabbagePermissions,
    clearCache: () => {
      manifestCache.current.clear()
      fetchPromises.current.clear()
    }
  }
}
