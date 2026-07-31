import type { LocalPayTransport } from './specs/LocalPayTransport.nitro'

export type { LocalPayTransport }

let cached: LocalPayTransport | null | undefined

/**
 * Returns the LocalPayTransport hybrid object, or null when the native module
 * is unavailable (web, jest, Expo Go, or any build without the native lib —
 * iOS registers via the podspec's generated Autolinking.mm, Android via
 * LocalPayTransportPackage's companion init → JNI_OnLoad). Never throws.
 *
 * Null here is why a broken native install NEVER errors visibly: every
 * capability probe (localSupportsAwdl/localSupportsNearby) reads it as
 * "unsupported device" and the payment flow quietly floors to QR.
 */
export function getLocalPayTransport(): LocalPayTransport | null {
  if (cached !== undefined) return cached
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nitro = require('react-native-nitro-modules') as typeof import('react-native-nitro-modules')
    cached = nitro.NitroModules.createHybridObject<LocalPayTransport>('LocalPayTransport')
  } catch {
    cached = null
  }
  return cached ?? null
}
