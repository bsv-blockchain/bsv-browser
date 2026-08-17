/**
 * SecureStore placement for the envelope scheme.
 *
 * Two separate keychain services, deliberately:
 *
 *  - `bsvb.kek.v1`     holds only the KEK. On Android this bounds the blast
 *                      radius of the module's own invalidation cleanup, which
 *                      wipes entries under a keychainService.
 *  - `bsvb.secrets.v1` holds the inert ciphertexts and the sentinel, always
 *                      unauthenticated so reading them never shows a prompt.
 *
 * Never change these constants. Changing keychainService orphans existing
 * items, and changing keychainAccessible on an existing item is a silent no-op
 * on iOS — the update path writes only the value.
 */
import * as SecureStore from 'expo-secure-store'

export const KEK_SERVICE = 'bsvb.kek.v1'
export const ENV_SERVICE = 'bsvb.secrets.v1'

export const SENTINEL_KEY = 'secretsSentinelV1'

export const envKey = (name: string) => `envV1.${name}`

/**
 * Options for the KEK item.
 *
 * WHEN_UNLOCKED_THIS_DEVICE_ONLY rather than AFTER_FIRST_UNLOCK: a biometric
 * sheet cannot run on a locked device anyway, so the weaker class buys nothing.
 * ALWAYS* would throw when combined with an access-control flag.
 */
export function kekOptions(
  requireAuthentication: boolean,
  authenticationPrompt?: string
): SecureStore.SecureStoreOptions {
  return {
    keychainService: KEK_SERVICE,
    requireAuthentication,
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    ...(authenticationPrompt ? { authenticationPrompt } : {})
  }
}

/**
 * Options for ciphertexts and the sentinel. requireAuthentication is false and
 * must stay false — these are useless without the KEK, and making them
 * authenticated would cost a prompt per read, which is the whole thing we are
 * avoiding.
 */
export const envOptions: SecureStore.SecureStoreOptions = {
  keychainService: ENV_SERVICE,
  requireAuthentication: false,
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY
}
