import { useEffect, useState } from 'react'
import { getOnline, subscribeOnline } from '@/utils/net/online'

/**
 * Starts optimistic. A first render that wrongly says "online" costs a failed
 * request; a first render that wrongly says "offline" hides the online payment
 * rails from a user who has signal, which is worse.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true)
  useEffect(() => {
    let cancelled = false
    void getOnline().then(v => {
      if (!cancelled) setOnline(v)
    })
    const unsubscribe = subscribeOnline(v => {
      if (!cancelled) setOnline(v)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])
  return online
}
