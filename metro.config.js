const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

// Add crypto polyfill configuration
config.resolver.extraNodeModules = {
  crypto: require.resolve('react-native-quick-crypto'),
  stream: require.resolve('stream-browserify'),
  buffer: require.resolve('buffer'),
  ...config.resolver.extraNodeModules
}

// Add wasm support for expo-sqlite on web
config.resolver.assetExts.push('wasm')

// Add COEP and COOP headers required for SharedArrayBuffer (used by expo-sqlite on web)
config.server = config.server || {}
const originalEnhanceMiddleware = config.server.enhanceMiddleware
config.server.enhanceMiddleware = (middleware) => {
  const enhanced = originalEnhanceMiddleware ? originalEnhanceMiddleware(middleware) : middleware
  return (req, res, next) => {
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    return enhanced(req, res, next)
  }
}

module.exports = config
