import { useCallback, useEffect, useRef, useState } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { LookupResolver, Transaction, Utils } from '@bsv/sdk'

const CACHE_KEY = 'app_directory_cache'
const CACHE_TTL = 60 * 60 * 1000 // 1 hour

export interface AppEntry {
  domain: string
  appName: string
  appIconImageUrl?: string
}

interface CachedData {
  apps: AppEntry[]
  timestamp: number
}

/**
 * Hook that queries the ls_apps overlay service and caches results.
 * Used by the NewTabPage to display a grid of registered BSV apps.
 */
export function useAppDirectory() {
  const [apps, setApps] = useState<AppEntry[]>([])
  const [loading, setLoading] = useState(false)
  const fetchedRef = useRef(false)

  const loadCached = useCallback(async (): Promise<AppEntry[] | null> => {
    try {
      const raw = await AsyncStorage.getItem(CACHE_KEY)
      if (!raw) return null
      const cached: CachedData = JSON.parse(raw)
      if (Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.apps
      }
    } catch {}
    return null
  }, [])

  const saveCache = useCallback(async (entries: AppEntry[]) => {
    try {
      const data: CachedData = { apps: entries, timestamp: Date.now() }
      await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(data))
    } catch {}
  }, [])

  const fetchFromOverlay = useCallback(async (): Promise<AppEntry[]> => {
    try {
      const resolver = new LookupResolver()
      const response = await resolver.query({
        service: 'ls_apps',
        query: {}
      }, 15000)

      if (!response?.outputs?.length) return []

      const entries: AppEntry[] = []
      for (const output of response.outputs) {
        try {
          const data = JSON.parse(
            Utils.toUTF8(
              Transaction.fromBEEF(output.beef).outputs[0].lockingScript.chunks[2].data as number[]
            )
          )
          if (data.domain) {
            entries.push({
              domain: data.domain.startsWith('http') ? data.domain : `https://${data.domain}`,
              appName: data.appName || data.name || data.domain,
              appIconImageUrl: data.appIconImageUrl || data.iconUrl || `${data.domain.startsWith('http') ? data.domain : `https://${data.domain}`}/favicon.ico`,
            })
          }
        } catch {
          // Skip malformed entries
        }
      }
      return entries
    } catch (err) {
      console.warn('[useAppDirectory] overlay query failed:', err)
      return []
    }
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const fresh = await fetchFromOverlay()
      if (fresh.length > 0) {
        setApps(fresh)
        await saveCache(fresh)
      }
    } finally {
      setLoading(false)
    }
  }, [fetchFromOverlay, saveCache])

  // Load on mount: cache first, then background refresh
  useEffect(() => {
    if (fetchedRef.current) return
    fetchedRef.current = true

    ;(async () => {
      const cached = await loadCached()
      if (cached && cached.length > 0) {
        setApps(cached)
        // Still refresh in background
        refresh()
      } else {
        await refresh()
      }
    })()
  }, [loadCached, refresh])

  return { apps, loading, refresh }
}
