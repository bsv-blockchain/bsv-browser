const { withEntitlementsPlist } = require('@expo/config-plugins')

module.exports = (config) =>
  withEntitlementsPlist(config, (mod) => {
    mod.modResults['com.apple.developer.web-browser'] = true
    return mod
  })
