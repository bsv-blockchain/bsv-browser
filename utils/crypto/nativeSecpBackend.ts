import type { SecpBackend } from './types'

type NativeSecpModule = {
  isAvailable?: () => boolean
  ecdsaSign?: (msg32: Uint8Array, priv32: Uint8Array) => Uint8Array
  ecdsaVerify?: (msg32: Uint8Array, sig64: Uint8Array, pub33: Uint8Array) => boolean
  pubkeyCreate?: (priv32: Uint8Array) => Uint8Array
}

function tryRequireNative(): NativeSecpModule | null {
  // Prefer package name (file:modules/native-secp256k1); keep relative fallback.
  const candidates = ['native-secp256k1', '../../modules/native-secp256k1']
  for (const id of candidates) {
    try {
      // Native module is optional; soft-fail when missing or unlinked.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(id) as NativeSecpModule | { default?: NativeSecpModule }
      if (mod && typeof mod === 'object') {
        const resolved = 'default' in mod && mod.default ? mod.default : (mod as NativeSecpModule)
        return resolved
      }
    } catch {
      // try next candidate
    }
  }
  return null
}

/**
 * Probe for a synchronous native ufsecp binding.
 * Returns null when the package is missing, unavailable, or incomplete
 * (Jest, web, incomplete native build).
 */
export function tryCreateNativeSecpBackend(): SecpBackend | null {
  const mod = tryRequireNative()
  if (!mod) return null

  if (typeof mod.isAvailable !== 'function' || !mod.isAvailable()) {
    return null
  }

  if (
    typeof mod.ecdsaSign !== 'function' ||
    typeof mod.ecdsaVerify !== 'function' ||
    typeof mod.pubkeyCreate !== 'function'
  ) {
    return null
  }

  const ecdsaSign = mod.ecdsaSign
  const ecdsaVerify = mod.ecdsaVerify
  const pubkeyCreate = mod.pubkeyCreate

  return {
    name: 'native',
    ecdsaSign: (msg32, priv32) => ecdsaSign(msg32, priv32),
    ecdsaVerify: (msg32, sig64, pub33) => ecdsaVerify(msg32, sig64, pub33),
    pubkeyCreate: priv32 => pubkeyCreate(priv32)
  }
}
