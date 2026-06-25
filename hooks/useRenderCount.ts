import { useRef } from 'react'
import { perf } from '@/utils/perf'
import { isLoggingEnabled } from '@/utils/logging'

/**
 * Counts renders of a component and records each as a `render:<name>` perf span
 * with no duration (we only care about frequency here — the React <Profiler>
 * captures commit durations). Logs the running count in __DEV__ so a re-render
 * storm is obvious in the Metro console.
 *
 * Usage (top of a component body):
 *   useRenderCount('Browser')
 */
export function useRenderCount(name: string): number {
  const count = useRef(0)
  count.current += 1
  if (__DEV__) {
    perf.measure(`render:${name}`, 0)
    // Gated by the master logging switch so the dev menu can silence this
    // per-render flood while reproducing a slow interaction.
    if (isLoggingEnabled()) console.log(`[render] ${name} #${count.current}`)
  }
  return count.current
}
