/**
 * Lightweight performance instrumentation for the JS thread.
 *
 * Hermes-friendly: builds only on `performance.now()` (already relied on by
 * utils/logging.ts). Everything is gated behind __DEV__ so production builds pay
 * nothing — the exported functions become near-noops.
 *
 * Usage:
 *   perf.track('tab.switch', () => tabStore.setActiveTab(id))
 *   await perf.track('wallet.createAction', () => wallet.createAction(args))
 *   const end = perf.mark('render.browser'); ...; end()
 *   perf.dump() // print the ring buffer (e.g. from a dev button / console)
 */

// Warn when a tracked span blocks the JS thread longer than this (ms).
// One frame at 60fps is ~16.7ms; anything over a frame is visible jank.
const SLOW_THRESHOLD_MS = 16

// How many recent measurements to retain for `perf.dump()`.
const RING_SIZE = 200

export interface PerfMeasure {
  label: string
  durationMs: number
  at: number // performance.now() timestamp when the span ended
}

const ring: PerfMeasure[] = []

function record(label: string, durationMs: number) {
  ring.push({ label, durationMs, at: performance.now() })
  if (ring.length > RING_SIZE) ring.shift()
  if (durationMs >= SLOW_THRESHOLD_MS) {
    console.warn(`[perf] SLOW ${label}: ${durationMs.toFixed(1)}ms`)
  }
}

function isThenable(v: any): v is Promise<unknown> {
  return v != null && typeof v.then === 'function'
}

/**
 * Time a sync or async function. Returns whatever `fn` returns (awaitable when
 * `fn` is async). The span is recorded once the work settles.
 */
function track<T>(label: string, fn: () => T): T {
  if (!__DEV__) return fn()
  const start = performance.now()
  let result: T
  try {
    result = fn()
  } catch (err) {
    record(`${label} (threw)`, performance.now() - start)
    throw err
  }
  if (isThenable(result)) {
    return (result as any).finally(() => record(label, performance.now() - start)) as T
  }
  record(label, performance.now() - start)
  return result
}

/**
 * Start a manual span. Returns a function that ends and records it.
 * Handy when start and end live in different callbacks.
 */
function mark(label: string): () => void {
  if (!__DEV__) return () => {}
  const start = performance.now()
  return () => record(label, performance.now() - start)
}

/** Record a span you've already timed yourself. */
function measure(label: string, durationMs: number) {
  if (!__DEV__) return
  record(label, durationMs)
}

/** Snapshot of the ring buffer (newest last). */
function entries(): PerfMeasure[] {
  return ring.slice()
}

/** Print a label-grouped summary (count / total / avg / max) to the console. */
function dump() {
  if (!__DEV__) return
  const byLabel = new Map<string, { n: number; total: number; max: number }>()
  for (const m of ring) {
    const g = byLabel.get(m.label) ?? { n: 0, total: 0, max: 0 }
    g.n += 1
    g.total += m.durationMs
    g.max = Math.max(g.max, m.durationMs)
    byLabel.set(m.label, g)
  }
  const rows = [...byLabel.entries()]
    .map(([label, g]) => ({ label, n: g.n, avg: g.total / g.n, max: g.max, total: g.total }))
    .sort((a, b) => b.total - a.total)
  console.log('[perf] summary (ms):')
  for (const r of rows) {
    console.log(`  ${r.label}: n=${r.n} avg=${r.avg.toFixed(1)} max=${r.max.toFixed(1)} total=${r.total.toFixed(1)}`)
  }
}

/** Clear the ring buffer (e.g. to isolate a fresh interaction). */
function reset() {
  ring.length = 0
}

export const perf = { track, mark, measure, entries, dump, reset }
