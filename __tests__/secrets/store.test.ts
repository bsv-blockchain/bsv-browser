/**
 * Secret store: everything after the one unlock must be prompt-free, and
 * deletion must work without a key.
 */
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)

import { fake as secureStore } from '../__mocks__/secureStoreFake'
import { fake as localAuth } from '../__mocks__/localAuthFake'
import { __resetForTests, readSentinel, unlockKek } from '../../services/secrets/kek'
import {
  deleteAllSecrets,
  deleteSecret,
  getSecret,
  hasSecret,
  putSecret
} from '../../services/secrets/store'

const ENV_SERVICE = 'bsvb.secrets.v1'
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const WIF = 'L1uyy5qTuGrVXrmrsvHWHgVzW9kKdrp27wBC7Vs6nZDTF2BRUVwy'

describe('secret store', () => {
  beforeEach(() => {
    secureStore.__reset()
    localAuth.__reset()
    __resetForTests()
    ;(global as any).__DEV__ = false
  })

  it('stores ciphertext, never the plaintext', async () => {
    expect(await putSecret('mnemonic', MNEMONIC)).toBe(true)
    const stored = secureStore.__get('envV1.mnemonic', { service: ENV_SERVICE })
    expect(stored).toBeDefined()
    expect(stored).not.toContain('abandon')
    const blob = JSON.parse(stored as string)
    expect(blob).toMatchObject({ v: 1 })
    expect(typeof blob.c).toBe('string')
  })

  it('writes envelopes unauthenticated, so reading them never prompts', async () => {
    await putSecret('mnemonic', MNEMONIC)
    for (const opts of secureStore.__optionsFor('set', 'envV1.mnemonic')) {
      expect(opts).toMatchObject({ keychainService: ENV_SERVICE, requireAuthentication: false })
    }
  })

  it('costs exactly one ceremony for a whole session of reads and writes', async () => {
    await putSecret('mnemonic', MNEMONIC)
    await putSecret('recoveredKey', WIF)
    __resetForTests() // fresh process, storage intact
    secureStore.__clearPrompts()

    expect((await unlockKek()).status).toBe('unlocked')
    expect(await getSecret('mnemonic')).toBe(MNEMONIC)
    expect(await getSecret('recoveredKey')).toBe(WIF)
    expect(await getSecret('mnemonic')).toBe(MNEMONIC)
    await putSecret('mnemonic', MNEMONIC)
    await hasSecret('mnemonic')

    expect(secureStore.__prompts()).toBe(1)
  })

  it('returns null while locked and does not unlock implicitly', async () => {
    await putSecret('mnemonic', MNEMONIC)
    __resetForTests()
    secureStore.__clearPrompts()

    // The one automatic unlock belongs to the wallet-build path, not to
    // whichever screen happens to read a secret first.
    expect(await getSecret('mnemonic')).toBeNull()
    expect(secureStore.__prompts()).toBe(0)
  })

  it('answers hasSecret while locked, without a ceremony', async () => {
    await putSecret('mnemonic', MNEMONIC)
    __resetForTests()
    secureStore.__clearPrompts()

    expect(await hasSecret('mnemonic')).toBe(true)
    expect(await hasSecret('recoveredKey')).toBe(false)
    expect(secureStore.__prompts()).toBe(0)
  })

  it('refuses to open a blob sealed by a different KEK', async () => {
    await putSecret('mnemonic', MNEMONIC)
    const blob = JSON.parse(secureStore.__get('envV1.mnemonic', { service: ENV_SERVICE }) as string)
    secureStore.__seed('envV1.mnemonic', JSON.stringify({ ...blob, kekId: 'ffffffffffffffff' }), {
      service: ENV_SERVICE
    })
    expect(await getSecret('mnemonic')).toBeNull()
  })

  it('deletes a secret without a ceremony and forgets it in the sentinel', async () => {
    await putSecret('mnemonic', MNEMONIC)
    await putSecret('recoveredKey', WIF)
    secureStore.__clearPrompts()

    await deleteSecret('recoveredKey')
    expect(await hasSecret('recoveredKey')).toBe(false)
    expect(await hasSecret('mnemonic')).toBe(true)
    expect((await readSentinel())?.names).toEqual(['mnemonic'])
    expect(secureStore.__prompts()).toBe(0)
  })

  it('logs out a user whose biometrics changed — deletion needs no key', async () => {
    await putSecret('mnemonic', MNEMONIC)
    __resetForTests()
    secureStore.__invalidateBiometrics()
    expect((await unlockKek()).status).toBe('lost')
    secureStore.__clearPrompts()

    await deleteAllSecrets()

    expect(await hasSecret('mnemonic')).toBe(false)
    expect(await readSentinel()).toBeNull()
    expect(secureStore.__prompts()).toBe(0)
  })

  it('leaves the next launch looking like a clean install after a wipe', async () => {
    await putSecret('mnemonic', MNEMONIC)
    await deleteAllSecrets()
    __resetForTests()
    secureStore.__clearPrompts()

    // No orphan sentinel means no biometric sheet on the create-wallet screen.
    expect((await unlockKek()).status).toBe('absent')
    expect(secureStore.__prompts()).toBe(0)
  })
})
