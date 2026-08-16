/**
 * Wallet secret storage: OS-enforced at-rest protection for the mnemonic and
 * the recovered key.
 *
 * The contract this directory exists to provide:
 *
 *   1. Exactly one biometric ceremony per process, at wallet instantiation.
 *   2. Between ceremonies the secrets are AES-256-GCM ciphertext whose key the
 *      Secure Enclave / Keystore will not release without a biometric match.
 *
 * (2) is the part the previous design lacked. Authentication used to be a
 * JavaScript boolean that the read path consulted and the OS knew nothing
 * about; now the read path *is* the ceremony.
 *
 * peekKek is intentionally not re-exported.
 */
export type {
  EnvelopeBlob,
  KekPolicy,
  KekSentinel,
  SecretName,
  UnavailableReason,
  UnlockState
} from './types'
export { EnvelopeError, SECRET_NAMES } from './types'

export { openSecret, sealSecret } from './envelope'

export {
  biometricKind,
  hasStrongBiometrics,
  resolveProvisioningPolicy,
  type ResolvedPolicy
} from './policy'

export {
  autoUnlockKek,
  destroyKek,
  getUnlockState,
  isUnlocked,
  lockKek,
  readSentinel,
  subscribeUnlockState,
  unlockKek
} from './kek'

export {
  deleteAllSecrets,
  deleteSecret,
  getSecret,
  hasAnySecret,
  hasSecret,
  putSecret
} from './store'

export {
  hasLegacySecrets,
  migrateLegacySecrets,
  migrationAttemptsExhausted,
  readLegacySecret,
  sweepLegacyKeys,
  type MigrationResult
} from './migration'
