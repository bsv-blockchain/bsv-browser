import type { LocalPayTransport } from './specs/LocalPayTransport.nitro'

export type { LocalPayTransport }

let cached: LocalPayTransport | null | undefined

/**
 * Returns the LocalPayTransport hybrid object, or null when the native module
 * is unavailable (Android, web, jest, Expo Go, or any build without the pod).
 * Never throws.
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
