/**
 * Root entry point for React Native app
 * Sets up crypto polyfills required by BSV SDK before any other code runs
 */

// Initialize react-native-quick-crypto FIRST before any BSV SDK imports
// This sets up the native crypto implementation via JSI
import { install } from 'react-native-quick-crypto'
install() // This sets global.Buffer and global.crypto

// CRITICAL: Complete crypto setup for BSV SDK compatibility
// The BSV SDK's Random.js checks crypto availability in this order:
// 1. globalThis.crypto.getRandomValues
// 2. self.crypto.getRandomValues
// 3. window.crypto.getRandomValues
// 4. process.require('crypto').randomBytes()
// We need to ensure ALL paths work by propagating global.crypto to all references

// Step 1: Make sure globalThis exists and points to global
if (typeof globalThis === 'undefined') {
  global.globalThis = global
}

// Step 2: Verify global.crypto is set and propagate it to all references
if (global.crypto && typeof global.crypto.getRandomValues === 'function') {
  // QuickCrypto is properly installed - now propagate it to all references

  // Make sure globalThis.crypto points to the same crypto object
  if (typeof globalThis !== 'undefined') {
    globalThis.crypto = global.crypto
  }

  // Setup self reference for Web Workers and Self scope access
  if (typeof global.self === 'undefined') {
    global.self = global
  } else if (!global.self.crypto) {
    global.self.crypto = global.crypto
  }

  // Setup window reference for browser compatibility
  if (typeof global.window === 'undefined') {
    global.window = global
  } else if (!global.window.crypto) {
    global.window.crypto = global.crypto
  }
} else {
  console.warn('[Crypto Setup] Warning: global.crypto not properly initialized after install()')
}

// Native secp256k1 (Nitro module, rust-secp256k1) — exposes SecpNative at
// globalThis.__bsvSecpNative so the patched @bsv/sdk primitives (see
// patches/@bsv+sdk+2.1.6.patch) route EC hot paths natively. Safe no-op when
// the native module is unavailable (web, jest, Expo Go): the SDK then uses its
// original pure-JS implementations.
try {
  const { installSecpNative } = require('react-native-secp-native')
  const secpNativeInstalled = installSecpNative()
  if (__DEV__) {
    console.log(
      `[SecpNative] native secp256k1 ${secpNativeInstalled ? 'installed' : 'unavailable — using pure-JS EC'}`
    )
  }
} catch (e) {
  if (__DEV__) console.warn('[SecpNative] install failed — using pure-JS EC', e)
}

// Native tx engine (Nitro module, native-engine-ffi / bsv-rs) — exposes
// EngineNative at globalThis.__bsvEngineNative. The patched @bsv/sdk
// Transaction.sign probes this seam to batch-sign all-P2PKH input sets in ONE
// async native crossing (BIP-143 midstates computed once per scope class).
// Safe no-op when the native module is unavailable (web, jest, Expo Go): the
// complete pure-JS tx path remains.
try {
  const { installEngineNative } = require('react-native-engine-native')
  const engineNativeInstalled = installEngineNative()
  if (__DEV__) {
    console.log(
      `[EngineNative] native tx engine ${engineNativeInstalled ? 'installed' : 'unavailable — pure-JS tx path'}`
    )
  }
} catch (e) {
  if (__DEV__) console.warn('[EngineNative] install failed — pure-JS tx path', e)
}

// Proof harness: bundles built with EXPO_PUBLIC_SECP_PROOF=1 run the
// native-secp-poc/fixtures/vectors.json conformance vectors through the ROUTED
// @bsv/sdk calls plus a routed-vs-JS micro-bench, then log/write/POST the
// results (see BENCHMARKS.md for reproduce instructions). The flag is inlined
// at bundle time; without it this block is dead code in every normal build
// (dev AND release) — no __DEV__ gate so the device proof can run on the
// release Hermes bundle.
if (process.env.EXPO_PUBLIC_SECP_PROOF === '1') {
  // The engine smoke proof (utils/engineNativeProof.ts — ping/version,
  // embedded batchSignP2pkhInputs fixtures, 50-input micro-timing) runs FIRST
  // and the secp proof is CHAINED after it, so the two never overlap on the
  // JS thread (timing integrity for both).
  setTimeout(() => {
    require('./utils/engineNativeProof')
      .runEngineProof()
      .catch((e) => console.error('[EngineNative] proof run failed:', e))
      .then(() => require('./utils/secpNativeProof').runSecpProof())
      .catch((e) => console.error('[SecpNative] proof run failed:', e))
  }, 4000)
}

// Device-measurement bundle: with EXPO_PUBLIC_CR_DEVICE=1 the app runs the
// routed-sign A/B bench off the SAME Release build (plus the thermal soak +
// many-run frame-stall distribution when EXPO_PUBLIC_CR_FULL=1) and writes
// Documents/cr-device-result.json. Independent timer (own clean JS thread;
// does not overlap the SECP_PROOF harness). Inlined at bundle time; dead code
// without the flag.
if (process.env.EXPO_PUBLIC_CR_DEVICE === '1') {
  setTimeout(() => {
    require('./utils/engineNativeProof')
      .runCrDevice()
      .catch((e) => console.error('[CR-DEVICE] run failed:', e))
  }, 6000)
}

// Then start the normal Expo app
import 'expo-router/entry'
