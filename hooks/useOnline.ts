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
    void getOnline()
      .then(v => {
        if (!cancelled) setOnline(v)
      })
      // A rejected probe is not worth an unhandled rejection at mount. NetInfo
      // reads native state and this hook is mounted by /pay, so a throw here
      // would take the screen down for a device whose connectivity we simply do
      // not know yet — and the optimistic `true` plus `subscribeOnline`'s updates
      // already answer that question well enough.
      .catch(() => {})
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
