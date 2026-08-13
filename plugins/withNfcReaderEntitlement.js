// Grants the NFC Tag-reading entitlement the vault uses to talk to a YubiKey's
// PIV applet over NFC (ISO7816) on iOS. This is the App-Store-valid transport
// for a hardware key on iOS — unlike com.apple.security.smartcard (a macOS App
// Sandbox entitlement that iOS App Store validation rejects, which is why the
// USB-C CCID path cannot ship through the store).
//
// "TAG" enables ISO7816 application tags (the PIV applet). The matching
// Info.plist keys (NFCReaderUsageDescription and the iso7816 select-identifiers
// AID list) live in app.json ios.infoPlist.
//
// NOTE: com.apple.developer.nfc.readersession.formats IS a real, provisionable
// iOS capability ("NFC Tag Reading") — the App ID must have it enabled and the
// provisioning profile regenerated, or codesign/App Store will reject it.
const { withEntitlementsPlist } = require('@expo/config-plugins')

module.exports = (config) =>
  withEntitlementsPlist(config, (mod) => {
    mod.modResults['com.apple.developer.nfc.readersession.formats'] = ['TAG']
    return mod
  })
