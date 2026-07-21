/**
 * native-secp256k1 — synchronous ECDSA surface for BSV PrivateKey.sign.
 *
 * Soft-fails when the native Expo module is not linked (Jest, web, Node,
 * incomplete native rebuild). Callers must check isAvailable() before use.
 */

type NativeModuleShape = {
  isAvailable?: () => boolean
  ecdsaSign?: (msg32: Uint8Array, priv32: Uint8Array) => Uint8Array
  ecdsaVerify?: (msg32: Uint8Array, sig64: Uint8Array, pub33: Uint8Array) => boolean
  pubkeyCreate?: (priv32: Uint8Array) => Uint8Array
}

let native: NativeModuleShape | null = null
let probed = false

function probeNative(): NativeModuleShape | null {
  if (probed) return native
  probed = true
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const core = require('expo-modules-core') as {
      requireOptionalNativeModule?: (name: string) => NativeModuleShape | null
      requireNativeModule?: (name: string) => NativeModuleShape
    }
    if (typeof core.requireOptionalNativeModule === 'function') {
      native = core.requireOptionalNativeModule('NativeSecp256k1')
    } else if (typeof core.requireNativeModule === 'function') {
      try {
        native = core.requireNativeModule('NativeSecp256k1')
      } catch {
        native = null
      }
    }
  } catch {
    native = null
  }
  return native
}

function asUint8Array(value: unknown, expectedLen: number, label: string): Uint8Array {
  if (value == null) {
    throw new Error(`native-secp256k1: ${label} is required`)
  }
  let bytes: Uint8Array
  if (value instanceof Uint8Array) {
    bytes = value
  } else if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  } else if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value)
  } else if (Array.isArray(value)) {
    bytes = Uint8Array.from(value as number[])
  } else {
    throw new Error(`native-secp256k1: ${label} must be a byte array`)
  }
  if (bytes.byteLength !== expectedLen) {
    throw new Error(
      `native-secp256k1: ${label} must be ${expectedLen} bytes, got ${bytes.byteLength}`
    )
  }
  return bytes
}

function ensureNative(): NativeModuleShape {
  const mod = probeNative()
  if (!mod || typeof mod.ecdsaSign !== 'function') {
    throw new Error(
      'native-secp256k1: native module is not available. Rebuild the dev client after prebuild (npx expo prebuild && native rebuild).'
    )
  }
  return mod
}

/** True when the native Expo module is linked and exposes sync ECDSA methods. */
export function isAvailable(): boolean {
  const mod = probeNative()
  if (!mod) return false
  if (typeof mod.isAvailable === 'function' && !mod.isAvailable()) return false
  return (
    typeof mod.ecdsaSign === 'function' &&
    typeof mod.ecdsaVerify === 'function' &&
    typeof mod.pubkeyCreate === 'function'
  )
}

/** Compact 64-byte R||S (low-S), RFC 6979. */
export function ecdsaSign(msg32: Uint8Array, priv32: Uint8Array): Uint8Array {
  const m = asUint8Array(msg32, 32, 'msg32')
  const p = asUint8Array(priv32, 32, 'priv32')
  const mod = ensureNative()
  const out = mod.ecdsaSign!(m, p)
  return asUint8Array(out, 64, 'ecdsaSign result')
}

/** Verify compact 64-byte R||S against compressed 33-byte pubkey. */
export function ecdsaVerify(
  msg32: Uint8Array,
  sig64: Uint8Array,
  pub33: Uint8Array
): boolean {
  const m = asUint8Array(msg32, 32, 'msg32')
  const s = asUint8Array(sig64, 64, 'sig64')
  const pub = asUint8Array(pub33, 33, 'pub33')
  const mod = ensureNative()
  return Boolean(mod.ecdsaVerify!(m, s, pub))
}

/** Compressed 33-byte secp256k1 public key from private key. */
export function pubkeyCreate(priv32: Uint8Array): Uint8Array {
  const p = asUint8Array(priv32, 32, 'priv32')
  const mod = ensureNative()
  const out = mod.pubkeyCreate!(p)
  return asUint8Array(out, 33, 'pubkeyCreate result')
}

export default {
  isAvailable,
  ecdsaSign,
  ecdsaVerify,
  pubkeyCreate
}
