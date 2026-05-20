const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const config = getDefaultConfig(__dirname)

const localSdkPath = path.resolve(__dirname, '../../ts-stack/packages/sdk')

config.watchFolders = [...(config.watchFolders || []), localSdkPath]

// Crypto polyfills
config.resolver.extraNodeModules = {
  crypto: require.resolve('react-native-quick-crypto'),
  stream: require.resolve('stream-browserify'),
  buffer: require.resolve('buffer'),
  ...config.resolver.extraNodeModules
}

// Hard override @bsv/sdk → local dev copy. extraNodeModules is fallback-only;
// hoisted node_modules/@bsv/sdk would otherwise win. resolveRequest intercepts first.
const localSdkPkgJson = require(path.join(localSdkPath, 'package.json'))
const sdkMainAbs = path.join(localSdkPath, localSdkPkgJson.main || 'dist/cjs/mod.js')

const emptyShim = path.resolve(__dirname, 'metro-shims/empty.js')
const quickCryptoMain = require.resolve('react-native-quick-crypto')

const upstream = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Route node:crypto → react-native-quick-crypto so SDK uses native SHA256/PBKDF2.
  if (moduleName === 'node:crypto') {
    return { type: 'sourceFile', filePath: quickCryptoMain }
  }
  if (moduleName === 'node:buffer' || moduleName === 'node:process') {
    return { type: 'sourceFile', filePath: emptyShim }
  }
  if (moduleName === '@bsv/sdk') {
    return { type: 'sourceFile', filePath: sdkMainAbs }
  }
  if (moduleName.startsWith('@bsv/sdk/')) {
    // Subpath imports — map to local dist/cjs/src/<rest>.js
    const sub = moduleName.slice('@bsv/sdk/'.length).replace(/\.ts$/, '')
    const candidates = [
      path.join(localSdkPath, 'dist/cjs/src', `${sub}.js`),
      path.join(localSdkPath, 'dist/cjs/src', sub, 'index.js'),
      path.join(localSdkPath, 'dist/cjs', `${sub}.js`)
    ]
    for (const c of candidates) {
      try {
        require('fs').accessSync(c)
        return { type: 'sourceFile', filePath: c }
      } catch { /* try next */ }
    }
  }
  if (typeof upstream === 'function') return upstream(context, moduleName, platform)
  return context.resolveRequest(context, moduleName, platform)
}

// Prevent Metro from resolving deps from any node_modules nested inside local sdk
const escapedSdk = localSdkPath.replace(/[/\\]/g, '[/\\\\]')
config.resolver.blockList = [
  new RegExp(`${escapedSdk}[/\\\\](?:.*[/\\\\])?node_modules[/\\\\].*`)
]

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
