/* global jest */
/**
 * Fake expo-local-authentication.
 *
 * authenticateAsync throws on purpose. It is not a mistake in the fake: the
 * scheme's central rule is that a LocalAuthentication prompt authorises nothing
 * — it builds a throwaway context the keychain never sees — so any code path
 * that calls it to gate a secret is a bug, and these tests should fail loudly
 * rather than quietly pass with two prompts.
 */
const SecurityLevel = {
  NONE: 0,
  SECRET: 1,
  BIOMETRIC_WEAK: 2,
  BIOMETRIC_STRONG: 3
}

const AuthenticationType = {
  FINGERPRINT: 1,
  FACIAL_RECOGNITION: 2,
  IRIS: 3
}

let level = SecurityLevel.BIOMETRIC_STRONG
let types = [AuthenticationType.FACIAL_RECOGNITION]

const fake = {
  SecurityLevel,
  AuthenticationType,
  getEnrolledLevelAsync: jest.fn(async () => level),
  supportedAuthenticationTypesAsync: jest.fn(async () => types),
  hasHardwareAsync: jest.fn(async () => level > SecurityLevel.SECRET),
  isEnrolledAsync: jest.fn(async () => level >= SecurityLevel.BIOMETRIC_WEAK),
  authenticateAsync: jest.fn(async () => {
    throw new Error('authenticateAsync must never gate a secret — it authorises nothing')
  }),

  __setLevel(next) {
    level = next
  },
  __setTypes(next) {
    types = next
  },
  __reset() {
    level = SecurityLevel.BIOMETRIC_STRONG
    types = [AuthenticationType.FACIAL_RECOGNITION]
    fake.getEnrolledLevelAsync.mockClear()
    fake.authenticateAsync.mockClear()
  }
}

module.exports = { fake }
