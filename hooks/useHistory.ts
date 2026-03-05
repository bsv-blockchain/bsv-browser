import { useCallback, useEffect, useRef, useState } from 'react'
import type { HistoryEntry } from '@/shared/types/browser'
import { kNEW_TAB_URL } from '@/shared/constants'
import { isValidUrl } from '@/utils/generalHelpers'

const HISTORY_KEY = 'history'

export function useHistory(
  getItem: (key: string) => Promise<string | null>,
  setItem: (key: string, value: string) => Promise<void>
) {
  const loadHistory = useCallback(async (): Promise<HistoryEntry[]> => {
    const raw = await getItem(HISTORY_KEY)
    const data = raw ? (JSON.parse(raw) as HistoryEntry[]) : []
    return data.map(h => ({
      ...h,
      url: isValidUrl(h.url) ? h.url : kNEW_TAB_URL
    }))
  }, [getItem])

  const [history, setHistory] = useState<HistoryEntry[]>([])

  // Keep a ref in sync with state so that callbacks always read the
  // latest history array instead of a stale closure snapshot.
  const historyRef = useRef<HistoryEntry[]>(history)
  useEffect(() => {
    historyRef.current = history
  }, [history])

  useEffect(() => {
    loadHistory().then(setHistory)
  }, [loadHistory])

  const saveHistory = useCallback(
    async (list: HistoryEntry[]) => {
      historyRef.current = list
      setHistory(list)
      await setItem(HISTORY_KEY, JSON.stringify(list))
    },
    [setItem]
  )

  const pushHistory = useCallback(
    async (entry: HistoryEntry) => {
      const current = historyRef.current
      if (current.length && current[0].url.replace(/\/$/, '') === entry.url.replace(/\/$/, '')) return
      const next = [entry, ...current].slice(0, 500)
      await saveHistory(next)
    },
    [saveHistory]
  )

  const removeHistoryItem = useCallback(
    async (url: string) => {
      const next = historyRef.current.filter(h => h.url !== url)
      await saveHistory(next)
    },
    [saveHistory]
  )

  const clearHistory = useCallback(async () => {
    await saveHistory([])
  }, [saveHistory])

  return { history, pushHistory, removeHistoryItem, clearHistory }
}
