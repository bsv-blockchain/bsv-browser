/**
 * Read/write wallet secrets through the envelope.
 *
 * Every operation here except the first unlock is prompt-free, because the
 * ciphertexts are unauthenticated items and the KEK is already in memory.
 *
 * SECURITY: never log values passed through these functions.
 */
import * as SecureStore from 'expo-secure-store'
import { openSecret, sealSecret, assertKekId } from './envelope'
import {
  destroyKek,
  forgetSecretName,
  peekKek,
  provisionKek,
  readSentinel,
  recordSecretName,
  unlockKek
} from './kek'
import { envKey, envOptions } from './storage'
import { EnvelopeBlob, EnvelopeError, SECRET_NAMES, SecretName } from './types'

/**
 * Is there a wrapped secret of this name? Prompt-free and works while locked.
 *
 * Note this is not strictly side-effect-free on Android: reading a blob whose
 * unauthenticated Keystore alias has gone missing makes the native module drop
 * the stale ciphertext. Harmless — it was already unopenable — but don't call
 * it speculatively in a hot path.
 */
export async function hasSecret(name: SecretName): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(envKey(name), envOptions)) !== null
  } catch {
    return false
  }
}

export async function hasAnySecret(): Promise<boolean> {
  for (const name of SECRET_NAMES) {
    if (await hasSecret(name)) return true
  }
  return false
}

/**
 * Returns null when locked. It deliberately does NOT unlock implicitly — the
 * one automatic unlock per process is initiated from the wallet-build effect,
 * where a prompt is expected, not from whichever screen happens to read a
 * secret first.
 */
export async function getSecret(name: SecretName): Promise<string | null> {
  const held = peekKek()
  if (!held) return null

  let raw: string | null
  try {
    raw = await SecureStore.getItemAsync(envKey(name), envOptions)
  } catch (err) {
    console.warn('[secrets] read failed', name, (err as Error)?.message)
    return null
  }
  if (!raw) return null

  try {
    const blob = JSON.parse(raw) as EnvelopeBlob
    assertKekId(blob, held.kekId)
    return openSecret(held.kek, name, blob)
  } catch (err) {
    const code = err instanceof EnvelopeError ? err.code : 'corrupt'
    console.warn('[secrets] could not open envelope', name, code)
    return null
  }
}

/**
 * Seal and store. Provisions a KEK on first use, which is the only moment a
 * write can prompt (and only on Android, where minting an auth-bound key
 * requires a ceremony).
 */
export async function putSecret(name: SecretName, value: string): Promise<boolean> {
  let held = peekKek()

  if (!held) {
    const sentinel = await readSentinel()
    const result = sentinel ? await unlockKek() : await provisionKek()
    if (result.status !== 'unlocked') return false
    held = peekKek()
    if (!held) return false
  }

  try {
    const blob = sealSecret(held.kek, held.kekId, name, value)
    await SecureStore.setItemAsync(envKey(name), JSON.stringify(blob), envOptions)
    await recordSecretName(name)
    return true
  } catch (err) {
    console.warn('[secrets] write failed', name, (err as Error)?.message)
    return false
  }
}

/** Prompt-free, and works while locked or lost: deleting ciphertext needs no
 * key. This is what makes logout possible for a user whose biometrics changed. */
export async function deleteSecret(name: SecretName): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(envKey(name), envOptions)
    await forgetSecretName(name)
  } catch (err) {
    console.warn('[secrets] delete failed', name, (err as Error)?.message)
  }
}

/** Removes every wrapped secret and the KEK itself, so the next launch reads
 * as a clean install rather than prompting for a wallet that no longer exists. */
export async function deleteAllSecrets(): Promise<void> {
  for (const name of SECRET_NAMES) {
    try {
      await SecureStore.deleteItemAsync(envKey(name), envOptions)
    } catch {
      /* best effort — destroyKek below is what matters */
    }
  }
  await destroyKek()
}
