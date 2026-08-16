/**
 * One-time migration of the plaintext-in-SecureStore wallet keys into the
 * envelope.
 *
 * Ordering is the whole design here. The only irreversible step is deleting the
 * legacy plaintext, and it happens strictly after the ciphertexts have been
 * written AND read back AND decrypted successfully. There is no window in which
 * the plaintext is gone and the envelope is unproven, so a crash or a denied
 * prompt at any point leaves the user on the old scheme rather than bricked.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { openSecret, sealSecret } from './envelope'
import { destroyKek, peekKek, provisionKek, readSentinel, recordSecretName } from './kek'
import { envKey, envOptions } from './storage'
import { EnvelopeBlob, SECRET_NAMES, SecretName } from './types'

/** Keys written by the pre-envelope LocalStorageProvider. */
const LEGACY_KEYS: Record<SecretName, string> = {
  mnemonic: 'mnemonic',
  recoveredKey: 'recoveredKey'
}
/** Had no consumers anywhere in the app: swept, never migrated. */
const LEGACY_PASSWORD_KEY = 'password'
const LEGACY_HAS_KEYS_FLAG = 'hasWalletKeys'

const FAILURE_COUNT_KEY = 'secrets.migration.failures'
const MAX_ATTEMPTS = 3

export type MigrationResult =
  | { outcome: 'not-needed' }
  | { outcome: 'migrated'; names: SecretName[] }
  | { outcome: 'failed'; stage: string; retryable: boolean }

/** Reads a legacy plaintext item. Prompt-free — these were always written
 * unauthenticated. Kept exported so the provider can still serve a session
 * whose migration failed, instead of showing the user an empty wallet. */
export async function readLegacySecret(name: SecretName): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(LEGACY_KEYS[name])
  } catch {
    return null
  }
}

export async function hasLegacySecrets(): Promise<boolean> {
  for (const name of SECRET_NAMES) {
    if (await readLegacySecret(name)) return true
  }
  return false
}

/**
 * Delete the legacy items and verify they are actually gone.
 *
 * iOS's delete discards every OSStatus and never throws, so "it returned" is
 * not evidence. If a legacy plaintext survived here the whole migration would
 * be cosmetic — the old unauthenticated item shadows the new one on read.
 */
export async function sweepLegacyKeys(): Promise<boolean> {
  const keys = [...Object.values(LEGACY_KEYS), LEGACY_PASSWORD_KEY]

  for (let attempt = 0; attempt < 2; attempt++) {
    for (const key of keys) {
      await SecureStore.deleteItemAsync(key).catch(() => {})
    }
    let remaining = 0
    for (const key of keys) {
      try {
        if ((await SecureStore.getItemAsync(key)) !== null) remaining++
      } catch {
        /* unreadable is as good as gone */
      }
    }
    if (remaining === 0) {
      await AsyncStorage.removeItem(LEGACY_HAS_KEYS_FLAG).catch(() => {})
      return true
    }
  }
  console.warn('[secrets] legacy plaintext survived deletion')
  return false
}

async function rollback(written: SecretName[]): Promise<void> {
  for (const name of written) {
    await SecureStore.deleteItemAsync(envKey(name), envOptions).catch(() => {})
  }
  // Removes the KEK and the sentinel; the legacy plaintext is untouched.
  await destroyKek()
}

async function bumpFailures(): Promise<number> {
  const raw = await AsyncStorage.getItem(FAILURE_COUNT_KEY)
  const next = (Number(raw) || 0) + 1
  await AsyncStorage.setItem(FAILURE_COUNT_KEY, String(next))
  return next
}

export async function migrationAttemptsExhausted(): Promise<boolean> {
  const raw = await AsyncStorage.getItem(FAILURE_COUNT_KEY)
  return (Number(raw) || 0) >= MAX_ATTEMPTS
}

export async function migrateLegacySecrets(): Promise<MigrationResult> {
  // Step 0 — idempotence. A committed sentinel means we already migrated;
  // sweeping here is what makes a crash between commit and delete harmless.
  const existing = await readSentinel()
  if (existing && existing.names.length > 0) {
    await sweepLegacyKeys()
    return { outcome: 'not-needed' }
  }

  // Step 1 — read the legacy plaintext. Zero prompts: these are unauthenticated.
  const legacy: Partial<Record<SecretName, string>> = {}
  for (const name of SECRET_NAMES) {
    const value = await readLegacySecret(name)
    if (value) legacy[name] = value
  }
  const names = Object.keys(legacy) as SecretName[]

  // Step 2 — nothing to migrate. Provisioning happens naturally at onboarding.
  if (names.length === 0) {
    await sweepLegacyKeys()
    return { outcome: 'not-needed' }
  }

  if (await migrationAttemptsExhausted()) {
    return { outcome: 'failed', stage: 'attempts-exhausted', retryable: false }
  }

  // Step 3 — mint the KEK. Costs one prompt on Android, none on iOS.
  const provisioned = await provisionKek()
  if (provisioned.status !== 'unlocked') {
    await bumpFailures()
    return {
      outcome: 'failed',
      stage: 'provision',
      retryable: provisioned.status === 'cancelled'
    }
  }
  const held = peekKek()
  if (!held) {
    await bumpFailures()
    return { outcome: 'failed', stage: 'provision', retryable: true }
  }

  // Step 4 — seal and write.
  const written: SecretName[] = []
  try {
    for (const name of names) {
      const blob = sealSecret(held.kek, held.kekId, name, legacy[name] as string)
      await SecureStore.setItemAsync(envKey(name), JSON.stringify(blob), envOptions)
      written.push(name)
    }
  } catch (err) {
    console.warn('[secrets] migration write failed', (err as Error)?.message)
    await rollback(written)
    await bumpFailures()
    return { outcome: 'failed', stage: 'write', retryable: true }
  }

  // Step 5 — prove the envelope before trusting it.
  try {
    for (const name of names) {
      const raw = await SecureStore.getItemAsync(envKey(name), envOptions)
      if (!raw) throw new Error(`blob missing for ${name}`)
      const opened = openSecret(held.kek, name, JSON.parse(raw) as EnvelopeBlob)
      if (opened !== legacy[name]) throw new Error(`round-trip mismatch for ${name}`)
    }
  } catch (err) {
    console.warn('[secrets] migration verification failed', (err as Error)?.message)
    await rollback(written)
    await bumpFailures()
    return { outcome: 'failed', stage: 'verify', retryable: true }
  }

  // Step 6 — commit. A sentinel only counts once it names a secret, so this is
  // the point of no return, and it comes after verification.
  for (const name of names) {
    await recordSecretName(name)
  }

  // Step 7 — the irreversible bit.
  await sweepLegacyKeys()
  await AsyncStorage.removeItem(FAILURE_COUNT_KEY).catch(() => {})

  return { outcome: 'migrated', names }
}
