const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

// Add crypto polyfill configuration
config.resolver.extraNodeModules = {
  crypto: require.resolve('react-native-quick-crypto'),
  stream: require.resolve('stream-browserify'),
  buffer: require.resolve('buffer'),
  ...config.resolver.extraNodeModules
}

module.exports = config
