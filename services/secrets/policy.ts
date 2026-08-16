/**
 * Which protection class the KEK gets on this device and this build.
 *
 * expo-local-authentication is used here as a *capability probe only*. It must
 * never be used to gate access to a secret: its authenticateAsync builds a
 * throwaway LAContext that is never handed to Security.framework, and on
 * Android it authenticates with no CryptoObject, so it unlocks no Keystore key.
 * A passed LocalAuthentication check proves nothing about the enclave. The only
 * ceremony that counts is the one SecureStore itself triggers when reading an
 * item written with requireAuthentication.
 */
import * as LocalAuthentication from 'expo-local-authentication'
import { KekPolicy } from './types'

/** ALWAYS written with requireAuthentication: true. */
export const KEK_AUTH_KEY = 'kekAuthV1'
/** ALWAYS written with requireAuthentication: false. */
export const KEK_PLAIN_KEY = 'kekPlainV1'

export interface ResolvedPolicy {
  policy: KekPolicy
  keyName: string
  requireAuthentication: boolean
  /** Show the "no biometric protection on this device" disclosure. */
  disclose: boolean
}

const BIOMETRIC: ResolvedPolicy = {
  policy: 'biometric',
  keyName: KEK_AUTH_KEY,
  requireAuthentication: true,
  disclose: false
}

const DEGRADED: ResolvedPolicy = {
  policy: 'degraded',
  keyName: KEK_PLAIN_KEY,
  requireAuthentication: false,
  disclose: true
}

const DEV_PLAIN: ResolvedPolicy = {
  policy: 'dev-plain',
  keyName: KEK_PLAIN_KEY,
  requireAuthentication: false,
  disclose: true
}

export function policyFor(policy: KekPolicy): ResolvedPolicy {
  switch (policy) {
    case 'biometric':
      return BIOMETRIC
    case 'degraded':
      return DEGRADED
    case 'dev-plain':
      return DEV_PLAIN
  }
}

/**
 * True when the device can actually satisfy an OS biometric ceremony.
 *
 * getEnrolledLevelAsync is the only correct probe here. hasHardwareAsync
 * returns true on an unenrolled simulator, and isEnrolledAsync returns true
 * under biometric lockout on iOS and only checks the *weak* class on Android —
 * while the Keystore key we mint requires BIOMETRIC_STRONG, so a weak-only
 * device would hard-fail provisioning.
 */
export async function hasStrongBiometrics(): Promise<boolean> {
  try {
    const level = await LocalAuthentication.getEnrolledLevelAsync()
    return level === LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG
  } catch {
    return false
  }
}

/** Copy helper: "Face ID" vs "Touch ID" vs "fingerprint". */
export async function biometricKind(): Promise<'face' | 'fingerprint' | 'iris' | 'unknown'> {
  try {
    const types = await LocalAuthentication.supportedAuthenticationTypesAsync()
    if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) return 'face'
    if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) return 'fingerprint'
    if (types.includes(LocalAuthentication.AuthenticationType.IRIS)) return 'iris'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Policy for minting a NEW KEK.
 *
 * Production with strong biometrics is the only path that yields `biometric`;
 * everything else degrades, and degradation is always disclosed. Development
 * builds without biometrics get `dev-plain` so simulators and CI still work —
 * that branch lives behind __DEV__, which Metro folds out of release bundles,
 * so it is not merely unreachable in production, it is not present.
 */
export async function resolveProvisioningPolicy(): Promise<ResolvedPolicy> {
  const strong = await hasStrongBiometrics()
  if (strong) return BIOMETRIC
  return __DEV__ ? DEV_PLAIN : DEGRADED
}

/**
 * Whether an EXISTING install's recorded policy is still acceptable.
 *
 * This closes a hole that needs no attacker: a dev build and a release build
 * share a bundle id, hence one keychain. A developer or internal tester who
 * runs a dev build first legitimately provisions `dev-plain`, and the release
 * build installed over it would otherwise read that unauthenticated KEK with
 * no prompt at all. In production, any non-biometric policy on a device that
 * *can* do biometrics must be re-wrapped before the KEK is honoured.
 */
export async function needsUpgrade(current: KekPolicy): Promise<boolean> {
  if (current === 'biometric') return false
  if (__DEV__) return false
  return hasStrongBiometrics()
}
