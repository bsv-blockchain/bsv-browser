import type { SecpNative } from './specs/SecpNative.nitro'

export type { SecpNative }

let cached: SecpNative | null | undefined

/**
 * Returns the SecpNative hybrid object, or null when the native module is
 * unavailable (web, jest, Expo Go, or any build without the pod).
 * Never throws.
 */
export function getSecpNative(): SecpNative | null {
  if (cached !== undefined) return cached
  try {
    // Lazy require so merely importing this package never throws on web/jest.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nitro = require('react-native-nitro-modules') as typeof import('react-native-nitro-modules')
    cached = nitro.NitroModules.createHybridObject<SecpNative>('SecpNative')
  } catch {
    cached = null
  }
  return cached ?? null
}

/**
 * Probes the native module and, if present, exposes it at
 * `globalThis.__bsvSecpNative` — the seam the patched @bsv/sdk primitives
 * look for (see patches/@bsv+sdk+*.patch, primitives/NativeSecp.js).
 * Returns true when the native path is live.
 */
export function installSecpNative(): boolean {
  const native = getSecpNative()
  if (native == null) return false
  ;(globalThis as Record<string, unknown>).__bsvSecpNative = native
  // Pre-warm: one cheap native call at install time. The M2 device track
  // measured cold-core first calls at tens–hundreds of µs extra (efficiency
  // cores + cold code paths); paying it here, off the hot path, means the first
  // REAL signing/derivation call doesn't. pubkeyCreate(1) exercises the whole
  // seam (ArrayBuffer marshalling, Nitro JSI crossing, UniFFI RustBuffer,
  // libsecp context) and returns G. Failures are irrelevant (best-effort warm).
  try {
    const one = new Uint8Array(32)
    one[31] = 1
    native.pubkeyCreate(one.buffer)
  } catch {
    // pre-warm is best-effort only
  }
  return true
}
