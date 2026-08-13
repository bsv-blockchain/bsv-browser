import type { YubiKeyPiv } from './specs/YubiKeyPiv.nitro'

export type { YubiKeyPiv }

let cached: YubiKeyPiv | null | undefined

/**
 * Returns the YubiKeyPiv hybrid object, or null when the native module is
 * unavailable (web, jest, Expo Go, or any build without the native lib —
 * iOS registers via the podspec's generated Autolinking.mm, Android via
 * YubiKeyPivPackage's companion init → JNI_OnLoad). Never throws.
 *
 * Null here is why a missing native install NEVER errors visibly: every
 * capability probe (isSupported) reads it as "no reader on this device" and
 * the vault flow quietly falls back to its software-key path instead of
 * crashing.
 */
export function getYubiKeyPiv(): YubiKeyPiv | null {
  if (cached !== undefined) return cached
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nitro = require('react-native-nitro-modules') as typeof import('react-native-nitro-modules')
    cached = nitro.NitroModules.createHybridObject<YubiKeyPiv>('YubiKeyPiv')
  } catch {
    cached = null
  }
  return cached ?? null
}
