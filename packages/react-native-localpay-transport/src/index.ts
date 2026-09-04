import type { LocalPayBleTransport } from './specs/LocalPayBleTransport.nitro'
import type { LocalPayTransport } from './specs/LocalPayTransport.nitro'

export type { LocalPayBleTransport, LocalPayTransport }

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

let cachedBle: LocalPayBleTransport | null | undefined

/**
 * Returns the LocalPayBleTransport hybrid object (the BLE rung, a second
 * HybridObject registered by the same native module), or null when it is
 * unavailable. Never throws. Cached separately from getLocalPayTransport():
 * one object being registered says nothing about the other.
 *
 * Unlike the AWDL/Nearby accessor this one warns ONCE in __DEV__ when it
 * swallows the error. A null here floors the flow to QR with no visible
 * error — the same masking that hid two shipped native-registration bugs
 * (84cd96e, 0c75467) — so a dev build should at least say so in the console.
 */
export function getLocalPayBleTransport(): LocalPayBleTransport | null {
  if (cachedBle !== undefined) return cachedBle
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nitro = require('react-native-nitro-modules') as typeof import('react-native-nitro-modules')
    cachedBle = nitro.NitroModules.createHybridObject<LocalPayBleTransport>('LocalPayBleTransport')
  } catch (error) {
    cachedBle = null
    if (__DEV__) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[localpay] LocalPayBleTransport unavailable:', message)
    }
  }
  return cachedBle ?? null
}
