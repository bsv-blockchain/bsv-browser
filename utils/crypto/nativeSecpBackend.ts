import type { SecpBackend } from './types'

type NativeSecpModule = {
  isAvailable?: () => boolean
  ecdsaSign?: (msg32: Uint8Array, priv32: Uint8Array) => Uint8Array
  ecdsaVerify?: (msg32: Uint8Array, sig64: Uint8Array, pub33: Uint8Array) => boolean
  pubkeyCreate?: (priv32: Uint8Array) => Uint8Array
}

function resolveModule(mod: NativeSecpModule | { default?: NativeSecpModule }): NativeSecpModule | null {
  if (!mod || typeof mod !== 'object') return null
  if ('default' in mod && mod.default) return mod.default
  return mod as NativeSecpModule
}

function tryRequireNative(): NativeSecpModule | null {
  // Metro requires string-literal require() arguments (no require(id)).
  // Package is wired as file:modules/native-secp256k1 in package.json.
  // Soft-fail when the package is missing (Jest maps it; web may not link native).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return resolveModule(require('native-secp256k1') as NativeSecpModule | { default?: NativeSecpModule })
  } catch {
    // fall through to relative path (source checkout without node_modules link)
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return resolveModule(
      require('../../modules/native-secp256k1') as NativeSecpModule | { default?: NativeSecpModule }
    )
  } catch {
    return null
  }
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
