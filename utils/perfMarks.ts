/**
 * Lightweight perf instrumentation — dev-only.
 *
 * Provides `mark(name)` / `measure(name)` calls that compile to no-ops in
 * production builds (`__DEV__` is folded by Metro for release JS bundles).
 * Useful for instrumenting user-perceived latencies that don't show up in
 * React Profiler: CWI roundtrip, tab switch, sheet open, address-bar
 * collapse animation, etc.
 *
 * Usage:
 *   const end = mark('cwi.createAction')
 *   await wallet.createAction(args)
 *   end()  // logs elapsed ms
 *
 *   measure('tab.switch', () => { ... })
 */

export type MarkEnd = () => number

const noop: MarkEnd = () => 0

/**
 * Start a perf mark. Returns a function that, when called, logs the elapsed
 * milliseconds with the supplied name. In production this is a no-op and the
 * returned function does nothing.
 */
export const mark = (name: string): MarkEnd => {
  if (!__DEV__) return noop
  const t0 = Date.now()
  return () => {
    const dt = Date.now() - t0
    // Only log slow operations — tight loops would otherwise flood the bridge.
    if (dt >= 16) {
      // eslint-disable-next-line no-console
      console.warn(`[perf] ${name} ${dt}ms`)
    }
    return dt
  }
}

/** Synchronous wrapper. */
export function measure<T>(name: string, fn: () => T): T {
  if (!__DEV__) return fn()
  const end = mark(name)
  try {
    return fn()
  } finally {
    end()
  }
}

/** Async wrapper. */
export async function measureAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!__DEV__) return fn()
  const end = mark(name)
  try {
    return await fn()
  } finally {
    end()
  }
}
