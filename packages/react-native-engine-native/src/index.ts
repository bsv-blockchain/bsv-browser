import type { EngineNative } from './specs/EngineNative.nitro'

export type { EngineNative }

let cached: EngineNative | null | undefined

/**
 * Returns the EngineNative hybrid object, or null when the native module is
 * unavailable (web, jest, Expo Go, or any build without the pod).
 * Never throws.
 */
export function getEngineNative(): EngineNative | null {
  if (cached !== undefined) return cached
  try {
    // Lazy require so merely importing this package never throws on web/jest.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nitro = require('react-native-nitro-modules') as typeof import('react-native-nitro-modules')
    cached = nitro.NitroModules.createHybridObject<EngineNative>('EngineNative')
  } catch {
    cached = null
  }
  return cached ?? null
}

/**
 * Probes the native module and, if present, exposes it at
 * `globalThis.__bsvEngineNative` — the seam the patched @bsv/sdk batch block
 * will look for (M5.5 routing; the engine is an accelerator, never a
 * dependency — the pure-JS path remains complete). Returns true when the
 * native path is live.
 */
export function installEngineNative(): boolean {
  const native = getEngineNative()
  if (native == null) return false
  ;(globalThis as Record<string, unknown>).__bsvEngineNative = native
  // Pre-warm: one cheap native call at install time, off the hot path
  // (the M2 device track measured cold-core first calls at tens–hundreds of
  // µs extra). ping() exercises the whole seam: ArrayBuffer marshalling,
  // Nitro JSI crossing, UniFFI RustBuffer round-trip.
  try {
    native.ping(new Uint8Array([1]).buffer)
  } catch {
    // pre-warm is best-effort only
  }
  return true
}
