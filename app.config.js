/**
 * Expo config. Identical to app.json unless EXPO_PUBLIC_E2E=1, in which case
 * the native project may load the loopback fixture server over cleartext HTTP.
 * That exception is local-network only. It is not applied to production builds.
 */
const appJson = require('./app.json')

module.exports = () => {
  const expo = appJson.expo
  if (process.env.EXPO_PUBLIC_E2E !== '1') return expo

  const plugins = (expo.plugins || []).map(plugin => {
    if (!Array.isArray(plugin) || plugin[0] !== 'expo-build-properties') return plugin
    const options = plugin[1] || {}
    return [
      'expo-build-properties',
      {
        ...options,
        android: {
          ...(options.android || {}),
          usesCleartextTraffic: true
        }
      }
    ]
  })

  return {
    ...expo,
    plugins,
    ios: {
      ...expo.ios,
      infoPlist: {
        ...(expo.ios && expo.ios.infoPlist),
        NSAppTransportSecurity: {
          NSAllowsLocalNetworking: true
        }
      }
    }
  }
}
