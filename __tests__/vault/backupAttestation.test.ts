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
import { backupAttestation, ATTEST_KEY_PREFIX } from '../../services/vault/backupAttestation'

const IDENTITY_A = '02' + 'a'.repeat(62)
const IDENTITY_B = '02' + 'b'.repeat(62)

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
