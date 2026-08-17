const { withEntitlementsPlist } = require('@expo/config-plugins')

/**
 * Re-applies `com.apple.developer.web-browser`, which prebuild strips.
 *
 * Apple granted this entitlement for the App ID, and the App Store profile
 * (production, local credentials) carries it. Expo-generated AdHoc profiles for
 * the internal-distribution dev profiles do NOT, and Xcode refuses to archive
 * when the entitlement is present but the profile lacks the capability:
 *
 *   Provisioning Profile "*[expo] org.bsvassociation.browser AdHoc ..." does
 *   not support the Default Web Browser capability.
 *
 * So the dev profiles opt out via EXPO_NO_WEB_BROWSER_ENTITLEMENT=1 (set in
 * eas.json). A dev client cannot register as the default browser without it,
 * which does not matter for a build whose purpose is testing on device.
 *
 * The default is deliberately ON: forgetting the flag yields a production build
 * WITH the entitlement, which is correct. Inverting that default would let a
 * silent strip ship to the App Store, where the entitlement is load-bearing.
 */
const disabled = process.env.EXPO_NO_WEB_BROWSER_ENTITLEMENT === '1'

module.exports = config =>
  disabled
    ? config
    : withEntitlementsPlist(config, mod => {
        mod.modResults['com.apple.developer.web-browser'] = true
        return mod
      })
