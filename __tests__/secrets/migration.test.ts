/**
 * Migration off the legacy plaintext scheme.
 *
 * The ordering assertions here are the point: the legacy plaintext must
 * survive every failure mode, and must only be deleted after the envelope has
 * been written, read back and decrypted.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)

import AsyncStorage from '@react-native-async-storage/async-storage'
import { fake as secureStore } from '../__mocks__/secureStoreFake'
import { fake as localAuth } from '../__mocks__/localAuthFake'
import { __resetForTests, readSentinel, unlockKek } from '../../services/secrets/kek'
import { migrateLegacySecrets } from '../../services/secrets/migration'
import { getSecret, hasSecret } from '../../services/secrets/store'

const ENV_SERVICE = 'bsvb.secrets.v1'
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const WIF = 'L1uyy5qTuGrVXrmrsvHWHgVzW9kKdrp27wBC7Vs6nZDTF2BRUVwy'

/** Recreate what the pre-envelope provider left on disk. */
function seedLegacyInstall({ mnemonic = MNEMONIC, recoveredKey = '', password = '' } = {}) {
  if (mnemonic) secureStore.__seed('mnemonic', mnemonic)
  if (recoveredKey) secureStore.__seed('recoveredKey', recoveredKey)
  if (password) secureStore.__seed('password', password)
  return AsyncStorage.setItem('hasWalletKeys', 'true')
}

describe('legacy secret migration', () => {
  beforeEach(async () => {
    secureStore.__reset()
    localAuth.__reset()
    __resetForTests()
    await AsyncStorage.clear()
    ;(global as any).__DEV__ = false
  })

  it('migrates a legacy wallet and removes the plaintext', async () => {
    await seedLegacyInstall({ recoveredKey: WIF, password: 'hunter2' })

    const result = await migrateLegacySecrets()
    expect(result).toEqual({ outcome: 'migrated', names: ['mnemonic', 'recoveredKey'] })

    expect(secureStore.__has('mnemonic')).toBe(false)
    expect(secureStore.__has('recoveredKey')).toBe(false)
    expect(await AsyncStorage.getItem('hasWalletKeys')).toBeNull()
    expect(await hasSecret('mnemonic')).toBe(true)
    expect(await getSecret('mnemonic')).toBe(MNEMONIC)
    expect(await getSecret('recoveredKey')).toBe(WIF)
  })

  it('deletes the legacy password without ever sealing it', async () => {
    await seedLegacyInstall({ password: 'hunter2' })
    await migrateLegacySecrets()

    expect(secureStore.__has('password')).toBe(false)
    expect(secureStore.__has('envV1.password', { service: ENV_SERVICE })).toBe(false)
    expect((await readSentinel())?.names).toEqual(['mnemonic'])
  })

  it('verifies the envelope before it deletes anything', async () => {
    await seedLegacyInstall()
    await migrateLegacySecrets()

    const ops = secureStore.__ops()
    const wroteBlob = ops.indexOf('set:envV1.mnemonic')
    const readBack = ops.indexOf('get:envV1.mnemonic')
    const wroteSentinel = ops.lastIndexOf('set:secretsSentinelV1')
    const deletedLegacy = ops.indexOf('delete:mnemonic')

    expect(wroteBlob).toBeGreaterThanOrEqual(0)
    expect(readBack).toBeGreaterThan(wroteBlob)
    expect(wroteSentinel).toBeGreaterThan(readBack)
    expect(deletedLegacy).toBeGreaterThan(wroteSentinel)
  })

  it('keeps the plaintext and writes no sentinel when verification fails', async () => {
    await seedLegacyInstall()
    // Corrupt only the verification read-back, as a storage-layer bug would.
    secureStore.__overrideRead(
      'envV1.mnemonic',
      JSON.stringify({ v: 1, kekId: 'x', salt: 'aa', c: 'bb' })
    )

    const result = await migrateLegacySecrets()

    expect(result).toMatchObject({ outcome: 'failed', stage: 'verify' })
    // The user still has a working wallet on the old scheme.
    expect(secureStore.__get('mnemonic')).toBe(MNEMONIC)
    expect(await readSentinel()).toBeNull()
    expect(secureStore.__has('envV1.mnemonic', { service: ENV_SERVICE })).toBe(false)
  })

  it('keeps the plaintext when the user cancels the provisioning prompt', async () => {
    await seedLegacyInstall()
    secureStore.__setOutcome('cancel')

    const result = await migrateLegacySecrets()

    expect(result).toMatchObject({ outcome: 'failed', stage: 'provision', retryable: true })
    expect(secureStore.__get('mnemonic')).toBe(MNEMONIC)
    expect(await readSentinel()).toBeNull()
  })

  it('retries on the next launch after a cancellation', async () => {
    await seedLegacyInstall()
    secureStore.__setOutcome('cancel')
    expect((await migrateLegacySecrets()).outcome).toBe('failed')

    secureStore.__setOutcome('ok')
    __resetForTests()
    expect((await migrateLegacySecrets()).outcome).toBe('migrated')
    expect(await getSecret('mnemonic')).toBe(MNEMONIC)
  })

  it('stops retrying after three failures instead of prompting every launch', async () => {
    await seedLegacyInstall()
    secureStore.__setOutcome('cancel')
    for (let i = 0; i < 3; i++) {
      __resetForTests()
      expect((await migrateLegacySecrets()).outcome).toBe('failed')
    }

    __resetForTests()
    secureStore.__clearPrompts()
    const result = await migrateLegacySecrets()
    expect(result).toMatchObject({ outcome: 'failed', stage: 'attempts-exhausted', retryable: false })
    expect(secureStore.__prompts()).toBe(0)
    expect(secureStore.__get('mnemonic')).toBe(MNEMONIC)
  })

  it('sweeps the plaintext on the next launch if it crashed after committing', async () => {
    await seedLegacyInstall()
    await migrateLegacySecrets()
    // Simulate the crash window: committed sentinel, legacy item still present.
    secureStore.__seed('mnemonic', MNEMONIC)

    __resetForTests()
    const result = await migrateLegacySecrets()

    expect(result).toEqual({ outcome: 'not-needed' })
    expect(secureStore.__has('mnemonic')).toBe(false)
  })

  it('is a no-op on a fresh install and never prompts', async () => {
    const result = await migrateLegacySecrets()
    expect(result).toEqual({ outcome: 'not-needed' })
    expect(await readSentinel()).toBeNull()
    expect(secureStore.__prompts()).toBe(0)
  })

  it('is idempotent and prompt-free on an already-migrated install', async () => {
    await seedLegacyInstall()
    await migrateLegacySecrets()

    __resetForTests()
    secureStore.__clearPrompts()
    expect(await migrateLegacySecrets()).toEqual({ outcome: 'not-needed' })
    expect(secureStore.__prompts()).toBe(0)
  })

  it('migrates a recovered-key-only wallet', async () => {
    await seedLegacyInstall({ mnemonic: '', recoveredKey: WIF })

    expect(await migrateLegacySecrets()).toEqual({ outcome: 'migrated', names: ['recoveredKey'] })
    expect(await getSecret('recoveredKey')).toBe(WIF)
  })

  it('costs one ceremony to migrate and one per launch thereafter', async () => {
    await seedLegacyInstall({ recoveredKey: WIF })
    await migrateLegacySecrets()
    expect(secureStore.__prompts()).toBe(1) // the provisioning write

    __resetForTests()
    secureStore.__clearPrompts()
    await migrateLegacySecrets()
    expect((await unlockKek()).status).toBe('unlocked')
    expect(await getSecret('mnemonic')).toBe(MNEMONIC)
    expect(await getSecret('recoveredKey')).toBe(WIF)
    expect(secureStore.__prompts()).toBe(1)
  })
})
