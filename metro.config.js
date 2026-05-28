const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const config = getDefaultConfig(__dirname)

// Crypto polyfills
config.resolver.extraNodeModules = {
  crypto: require.resolve('react-native-quick-crypto'),
  stream: require.resolve('stream-browserify'),
  buffer: require.resolve('buffer'),
  ...config.resolver.extraNodeModules
}

const emptyShim = path.resolve(__dirname, 'metro-shims/empty.js')
const quickCryptoMain = require.resolve('react-native-quick-crypto')

const upstream = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Route node:crypto → react-native-quick-crypto so SDK uses native SHA256/PBKDF2/AES-GCM.
  if (moduleName === 'node:crypto') {
    return { type: 'sourceFile', filePath: quickCryptoMain }
  }
  if (moduleName === 'node:buffer' || moduleName === 'node:process') {
    return { type: 'sourceFile', filePath: emptyShim }
  }
  if (typeof upstream === 'function') return upstream(context, moduleName, platform)
  return context.resolveRequest(context, moduleName, platform)
}

// Add wasm support for expo-sqlite on web
config.resolver.assetExts.push('wasm')
config.transformer.assetPlugins = ['expo-asset/tools/hashAssetFiles']

// Add COEP and COOP headers required for SharedArrayBuffer (used by expo-sqlite on web)
config.server = config.server || {}
const originalEnhanceMiddleware = config.server.enhanceMiddleware
config.server.enhanceMiddleware = (middleware) => {
  const enhanced = originalEnhanceMiddleware ? originalEnhanceMiddleware(middleware) : middleware
  return (req, res, next) => {
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    return enhanced(req, res, next)
  }
}

module.exports = config
