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

// Then start the normal Expo app
import 'expo-router/entry'
