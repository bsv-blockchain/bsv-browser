// Drops react-native-webrtc's screen-capture service from the Android manifest.
//
// react-native-webrtc's library manifest declares com.oney.WebRTCModule.MediaProjectionService
// with android:foregroundServiceType="mediaProjection", for screen sharing. This app only uses
// WebRTC data channels for live payments and never captures the screen, but Google Play asks
// every app whose manifest declares a foreground service type to justify it in the Play
// Console. A `tools:node="remove"` entry in the app manifest takes the service out at manifest
// merge, so the release bundle declares no media-projection service at all.
const { withAndroidManifest } = require('@expo/config-plugins')

const SERVICE = 'com.oney.WebRTCModule.MediaProjectionService'

module.exports = (config) =>
  withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest
    manifest.$['xmlns:tools'] = manifest.$['xmlns:tools'] || 'http://schemas.android.com/tools'
    const application = manifest.application?.[0]
    if (!application) throw new Error('[withoutWebRTCMediaProjection] AndroidManifest has no <application>')
    application.service = (application.service || []).filter((s) => s.$?.['android:name'] !== SERVICE)
    application.service.push({ $: { 'android:name': SERVICE, 'tools:node': 'remove' } })
    return mod
  })
