// Grants the smart-card entitlement the YubiKey PIV module needs to talk to a
// YubiKey 5C over USB-C / CCID on iOS 16+ (TKSmartCard slot access). Applied
// both here (prebuild output) and to the tracked ios/BSVBrowser.entitlements so
// the two never drift — the same discipline as withWebBrowserEntitlement.js.
//
// NOTE (memory: com.apple.developer.web-browser has a history of spurious
// ITMS-90683 Bluetooth-purpose-string demands at Deliver that Transporter
// Verify does not catch): validate this entitlement through a real Deliver
// upload early, not just Verify.
const { withEntitlementsPlist } = require('@expo/config-plugins')

module.exports = (config) =>
  withEntitlementsPlist(config, (mod) => {
    mod.modResults['com.apple.security.smartcard'] = true
    return mod
  })
