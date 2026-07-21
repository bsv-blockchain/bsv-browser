const path = require('path')

/**
 * Whether a Metro resolve should rewrite a module request to fastECDSA.
 * Only aliases relative ECDSA imports that originate from inside @bsv/sdk.
 */
function shouldAliasBsvEcdsa(moduleName, originModulePath) {
  if (!originModulePath || !originModulePath.includes(`${path.sep}@bsv${path.sep}sdk`)) {
    return false
  }
  return (
    moduleName === './ECDSA.js' ||
    moduleName === './ECDSA' ||
    moduleName === '../primitives/ECDSA.js' ||
    moduleName === '../primitives/ECDSA' ||
    /[/\\]primitives[/\\]ECDSA(\.js)?$/.test(moduleName)
  )
}

module.exports = { shouldAliasBsvEcdsa }
