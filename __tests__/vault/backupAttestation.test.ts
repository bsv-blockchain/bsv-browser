/**
 * The attestation records that a user SAID they wrote something down. It is
 * advisory, not a security control. What matters here is scoping: a global
 * flag would survive Delete Wallet (wired straight to logout) and the next
 * wallet on the device would be born already backed up.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  backupAttestation,
  ATTEST_KEY_PREFIX,
  resolveAttestationIdentity,
  readBackupAttestation,
  recordBackupAttestation
} from '../../services/vault/backupAttestation'

const IDENTITY_A = '02' + 'a'.repeat(62)
const IDENTITY_B = '02' + 'b'.repeat(62)
const ADMIN = 'admin.com'

/** Minimal stand-in for the permissions manager the screens actually hold. */
const walletReturning = (publicKey: string) => ({
  getPublicKey: jest.fn(async () => ({ publicKey }))
})
const walletRejecting = (message = 'managers not ready') => ({
  getPublicKey: jest.fn(async () => {
    throw new Error(message)
  })
})

beforeEach(async () => {
  await AsyncStorage.clear()
})

describe('backupAttestation', () => {
  test('returns null before anything is recorded', async () => {
    expect(await backupAttestation.get(IDENTITY_A)).toBeNull()
  })

  test('records the medium and a timestamp', async () => {
    await backupAttestation.set(IDENTITY_A, 'phrase')
    const got = await backupAttestation.get(IDENTITY_A)

    expect(got).toMatchObject({ v: 1, medium: 'phrase' })
    expect(typeof got?.at).toBe('number')
    expect(got!.at).toBeGreaterThan(0)
  })

  test('scopes per wallet identity', async () => {
    await backupAttestation.set(IDENTITY_A, 'shares')

    expect(await backupAttestation.get(IDENTITY_B)).toBeNull()
    expect((await backupAttestation.get(IDENTITY_A))?.medium).toBe('shares')
  })

  test('the later medium replaces the earlier one', async () => {
    await backupAttestation.set(IDENTITY_A, 'shares')
    await backupAttestation.set(IDENTITY_A, 'phrase')

    expect((await backupAttestation.get(IDENTITY_A))?.medium).toBe('phrase')
  })

  test('clear removes only the named identity', async () => {
    await backupAttestation.set(IDENTITY_A, 'phrase')
    await backupAttestation.set(IDENTITY_B, 'phrase')
    await backupAttestation.clear(IDENTITY_A)

    expect(await backupAttestation.get(IDENTITY_A)).toBeNull()
    expect(await backupAttestation.get(IDENTITY_B)).not.toBeNull()
  })

  test('clearAll removes every attestation and nothing else', async () => {
    await AsyncStorage.setItem('unrelated_key', 'keep me')
    await backupAttestation.set(IDENTITY_A, 'phrase')
    await backupAttestation.set(IDENTITY_B, 'shares')

    await backupAttestation.clearAll()

    expect(await backupAttestation.get(IDENTITY_A)).toBeNull()
    expect(await backupAttestation.get(IDENTITY_B)).toBeNull()
    expect(await AsyncStorage.getItem('unrelated_key')).toBe('keep me')
  })

  test('a corrupt value reads as absent rather than throwing', async () => {
    await AsyncStorage.setItem(ATTEST_KEY_PREFIX + IDENTITY_A.slice(-8), 'not json')

    expect(await backupAttestation.get(IDENTITY_A)).toBeNull()
  })

  test('an unknown persisted version reads as absent', async () => {
    await AsyncStorage.setItem(
      ATTEST_KEY_PREFIX + IDENTITY_A.slice(-8),
      JSON.stringify({ v: 99, medium: 'phrase', at: 1 })
    )

    expect(await backupAttestation.get(IDENTITY_A)).toBeNull()
  })
})

/**
 * The helpers below are the single writer every backup surface goes through.
 * Two screens can satisfy the vault's backup prerequisite — the enrollment
 * wizard and the Settings print row — and before these existed each guarded
 * the identity lookup its own way, which is how one of them ended up silently
 * skipping the write.
 */
describe('resolveAttestationIdentity', () => {
  test('returns the wallet identity key', async () => {
    const w = walletReturning(IDENTITY_A)
    expect(await resolveAttestationIdentity(w, ADMIN)).toBe(IDENTITY_A)
    expect(w.getPublicKey).toHaveBeenCalledWith({ identityKey: true }, ADMIN)
  })

  test('returns null rather than throwing when the lookup rejects', async () => {
    // An unguarded rejection surfaces as an unhandled promise, which in the
    // wizard left the phrase sheet mounted on screen with no feedback.
    await expect(resolveAttestationIdentity(walletRejecting(), ADMIN)).resolves.toBeNull()
  })

  test('returns null when there is no wallet yet', async () => {
    expect(await resolveAttestationIdentity(undefined, ADMIN)).toBeNull()
    expect(await resolveAttestationIdentity(null, ADMIN)).toBeNull()
  })

  test('treats an empty identity key as no identity', async () => {
    // Writing under an empty scope key would collide across every wallet.
    expect(await resolveAttestationIdentity(walletReturning(''), ADMIN)).toBeNull()
  })
})

describe('recordBackupAttestation', () => {
  test('persists under the resolved identity and reports success', async () => {
    expect(await recordBackupAttestation(walletReturning(IDENTITY_A), ADMIN, 'shares')).toBe(true)
    expect((await backupAttestation.get(IDENTITY_A))?.medium).toBe('shares')
  })

  test('reports failure and writes nothing when the identity cannot be resolved', async () => {
    expect(await recordBackupAttestation(walletRejecting(), ADMIN, 'phrase')).toBe(false)

    const keys = await AsyncStorage.getAllKeys()
    expect(keys.filter(k => k.startsWith(ATTEST_KEY_PREFIX))).toHaveLength(0)
  })

  test('reports failure rather than throwing when the write rejects', async () => {
    // The caller must be able to tell the user; a thrown error here used to be
    // swallowed by a catch that only logged.
    //
    // Swap the method rather than jest.spyOn: restoring a spy on the
    // async-storage jest mock leaves setItem inert for every later test.
    const original = AsyncStorage.setItem
    ;(AsyncStorage as unknown as Record<string, unknown>).setItem = jest.fn(async () => {
      throw new Error('quota exceeded')
    })

    try {
      expect(await recordBackupAttestation(walletReturning(IDENTITY_A), ADMIN, 'shares')).toBe(
        false
      )
      expect(await backupAttestation.get(IDENTITY_A)).toBeNull()
    } finally {
      ;(AsyncStorage as unknown as Record<string, unknown>).setItem = original
    }
  })

  test('scopes to the resolved wallet, not to another', async () => {
    await recordBackupAttestation(walletReturning(IDENTITY_A), ADMIN, 'phrase')
    expect(await backupAttestation.get(IDENTITY_B)).toBeNull()
  })
})

describe('readBackupAttestation', () => {
  test('reads back what was recorded for the same wallet', async () => {
    await recordBackupAttestation(walletReturning(IDENTITY_A), ADMIN, 'phrase')
    const got = await readBackupAttestation(walletReturning(IDENTITY_A), ADMIN)

    expect(got?.medium).toBe('phrase')
  })

  test('returns null when the identity cannot be resolved', async () => {
    await recordBackupAttestation(walletReturning(IDENTITY_A), ADMIN, 'phrase')
    expect(await readBackupAttestation(walletRejecting(), ADMIN)).toBeNull()
  })

  test('returns null for a wallet that never attested', async () => {
    expect(await readBackupAttestation(walletReturning(IDENTITY_B), ADMIN)).toBeNull()
  })
})
