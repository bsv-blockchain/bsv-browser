/**
 * Jest mock: native backend unavailable under unit tests.
 * Install selection falls through to @noble/secp256k1.
 */
module.exports = {
  isAvailable: () => false,
  ecdsaSign: () => {
    throw new Error('native-secp256k1 mock: not available in Jest')
  },
  ecdsaVerify: () => false,
  pubkeyCreate: () => {
    throw new Error('native-secp256k1 mock: not available in Jest')
  }
}
