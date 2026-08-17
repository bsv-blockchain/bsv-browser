/**
 * KEK lifecycle: the prompt-count and never-mint-over-a-sentinel guarantees.
 *
 * These are the tests that encode the actual product constraint — one OS
 * ceremony per process — and the actual security constraint — a missing key is
 * reported as lost, never replaced with a fresh one.
 */
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)

import { fake as secureStore } from '../__mocks__/secureStoreFake'
import { fake as localAuth } from '../__mocks__/localAuthFake'
import {
  __resetForTests,
  autoUnlockKek,
  destroyKek,
  provisionKek,
  readSentinel,
  recordSecretName,
  unlockKek
} from '../../services/secrets/kek'
import { KEK_AUTH_KEY, KEK_PLAIN_KEY } from '../../services/secrets/policy'

const KEK_SERVICE = 'bsvb.kek.v1'
const ENV_SERVICE = 'bsvb.secrets.v1'

/** provisionKek writes a sentinel with no names; a sentinel only counts as a
 * committed wallet once it names a secret, which is how a half-finished
 * migration stays invisible. */
async function provisionWithSecret() {
  const state = await provisionKek()
  await recordSecretName('mnemonic')
  return state
}

describe('KEK lifecycle', () => {
  beforeEach(() => {
    secureStore.__reset()
    localAuth.__reset()
    __resetForTests()
    ;(global as any).__DEV__ = false
  })

  it('provisions with exactly one ceremony and no read-back', async () => {
    const state = await provisionKek()
    expect(state.status).toBe('unlocked')
    // One authenticated write. Reading back what we just wrote would be a
    // second prompt on every fresh install.
    expect(secureStore.__prompts()).toBe(1)
    expect(secureStore.getItemAsync).not.toHaveBeenCalledWith(KEK_AUTH_KEY, expect.anything())
    expect(secureStore.__has(KEK_AUTH_KEY, { service: KEK_SERVICE, auth: true })).toBe(true)
  })

  it('stores the KEK authenticated and the sentinel unauthenticated', async () => {
    await provisionWithSecret()
    const [kekOpts] = secureStore.__optionsFor('set', KEK_AUTH_KEY)
    expect(kekOpts).toMatchObject({ keychainService: KEK_SERVICE, requireAuthentication: true })

    const sentinelOpts = secureStore.__optionsFor('set', 'secretsSentinelV1')
    expect(sentinelOpts[0]).toMatchObject({
      keychainService: ENV_SERVICE,
      requireAuthentication: false
    })
  })

  it('unlocks once per process no matter how many callers ask', async () => {
    await provisionWithSecret()
    __resetForTests() // simulate a fresh process with storage intact
    secureStore.__clearPrompts() // count only what the cold start costs

    const first = await unlockKek()
    expect(first.status).toBe('unlocked')
    for (let i = 0; i < 5; i++) await unlockKek()

    expect(secureStore.__prompts()).toBe(1)
  })

  it('single-flights concurrent unlocks', async () => {
    await provisionWithSecret()
    __resetForTests()
    secureStore.__clearPrompts()

    // Android throws outright if a second prompt is requested while one is up.
    const results = await Promise.all([unlockKek(), unlockKek(), unlockKek(), unlockKek()])
    expect(results.every(r => r.status === 'unlocked')).toBe(true)
    expect(secureStore.__prompts()).toBe(1)
  })

  it('reports absent without touching SecureStore on a fresh install', async () => {
    const state = await unlockKek()
    expect(state.status).toBe('absent')
    expect(secureStore.getItemAsync).not.toHaveBeenCalledWith(KEK_AUTH_KEY, expect.anything())
    expect(secureStore.__prompts()).toBe(0)
  })

  it('treats an orphan sentinel with no secrets as absent, so logout does not leave a prompt behind', async () => {
    await provisionKek() // sentinel written, no names recorded
    __resetForTests()
    secureStore.__clearPrompts()

    const state = await unlockKek()
    expect(state.status).toBe('absent')
    expect(secureStore.__prompts()).toBe(0)
  })

  it('reports lost — and never mints a replacement — when the OS destroyed the key', async () => {
    await provisionWithSecret()
    __resetForTests()
    secureStore.__invalidateBiometrics()
    secureStore.setItemAsync.mockClear()

    const state = await unlockKek()
    expect(state.status).toBe('lost')
    // The single most important negative assertion here: silently re-minting
    // would strand the user's ciphertexts behind a key nobody can match.
    expect(secureStore.setItemAsync).not.toHaveBeenCalled()
  })

  it('distinguishes a cancelled prompt from a lost key', async () => {
    await provisionWithSecret()
    __resetForTests()
    secureStore.__setOutcome('cancel')
    secureStore.setItemAsync.mockClear()

    const state = await unlockKek()
    expect(state.status).toBe('cancelled')
    expect(secureStore.setItemAsync).not.toHaveBeenCalled()
  })

  it('classifies lockout as unavailable', async () => {
    await provisionWithSecret()
    __resetForTests()
    secureStore.__setOutcome('lockout')

    const state = await unlockKek()
    expect(state).toEqual({ status: 'unavailable', reason: 'lockout' })
  })

  it('auto-unlocks at most once, so a cancellation cannot become a prompt loop', async () => {
    await provisionWithSecret()
    __resetForTests()
    secureStore.__setOutcome('cancel')

    expect((await autoUnlockKek()).status).toBe('cancelled')
    const promptsAfterFirst = secureStore.__prompts()
    await autoUnlockKek()
    await autoUnlockKek()
    expect(secureStore.__prompts()).toBe(promptsAfterFirst)
  })

  it('ignores an unauthenticated item squatting on the authenticated key name', async () => {
    await provisionWithSecret()
    __resetForTests()
    secureStore.__clearPrompts()
    // An unauthenticated entry squatting on the authenticated key name shadows
    // the real one on read — which is exactly why the two policies use
    // different key names rather than the same name with a different flag.
    secureStore.__seed(KEK_AUTH_KEY, 'de'.repeat(32), { service: KEK_SERVICE, auth: false })

    const state = await unlockKek()
    expect(state.status).toBe('unlocked')
    // A biometric install never reads the plain key name at all, so a planted
    // plain KEK under *that* name is unreachable.
    expect(secureStore.__optionsFor('get', KEK_PLAIN_KEY)).toHaveLength(0)
  })

  it('a tampered sentinel yields lost, never an unauthenticated read of the real key', async () => {
    await provisionWithSecret()
    const sentinel = await readSentinel()
    __resetForTests()
    // Rewrite the sentinel as if the install were degraded. The KEK still only
    // exists under the authenticated key name, so this buys the attacker a
    // failed lookup, not a decryption.
    secureStore.__seed(
      'secretsSentinelV1',
      JSON.stringify({ ...sentinel, policy: 'degraded' }),
      { service: ENV_SERVICE }
    )
    secureStore.setItemAsync.mockClear()

    const state = await unlockKek()
    expect(state.status).toBe('lost')
    expect(secureStore.setItemAsync).not.toHaveBeenCalled()
  })

  it('re-wraps a dev-provisioned KEK when a production build finds biometrics', async () => {
    // A dev build and a release build share a keychain, so a release binary
    // can legitimately find an unauthenticated KEK left by a dev build.
    ;(global as any).__DEV__ = true
    localAuth.__setLevel(localAuth.SecurityLevel.NONE)
    await provisionWithSecret()
    expect(secureStore.__has(KEK_PLAIN_KEY, { service: KEK_SERVICE, auth: false })).toBe(true)

    __resetForTests()
    ;(global as any).__DEV__ = false
    localAuth.__setLevel(localAuth.SecurityLevel.BIOMETRIC_STRONG)

    const state = await unlockKek()
    expect(state.status).toBe('unlocked')
    expect(state).toMatchObject({ policy: 'biometric' })
    // The plain copy must be gone, not merely ignored.
    expect(secureStore.__has(KEK_PLAIN_KEY, { service: KEK_SERVICE, auth: false })).toBe(false)
    expect(secureStore.__has(KEK_AUTH_KEY, { service: KEK_SERVICE, auth: true })).toBe(true)
    expect((await readSentinel())?.policy).toBe('biometric')
  })

  it('keeps a degraded install degraded on a device with no biometrics', async () => {
    localAuth.__setLevel(localAuth.SecurityLevel.SECRET)
    const state = await provisionWithSecret()
    expect(state).toMatchObject({ policy: 'degraded' })
    expect(secureStore.__prompts()).toBe(0)
  })

  it('treats Android weak biometrics as degraded, since the keystore key requires strong', async () => {
    localAuth.__setLevel(localAuth.SecurityLevel.BIOMETRIC_WEAK)
    const state = await provisionWithSecret()
    expect(state).toMatchObject({ policy: 'degraded' })
  })

  it('destroys the KEK and the sentinel without a ceremony, even while lost', async () => {
    await provisionWithSecret()
    __resetForTests()
    secureStore.__invalidateBiometrics()
    expect((await unlockKek()).status).toBe('lost')

    const before = secureStore.__prompts()
    await destroyKek()
    expect(secureStore.__prompts()).toBe(before)
    expect(await readSentinel()).toBeNull()
    expect(secureStore.__has(KEK_AUTH_KEY, { service: KEK_SERVICE, auth: true })).toBe(false)
  })

  it('never authenticates through expo-local-authentication', async () => {
    await provisionWithSecret()
    __resetForTests()
    await unlockKek()
    // A LocalAuthentication prompt authorises nothing at the OS level; using
    // one to gate a secret is the exact bug this whole change removes.
    expect(localAuth.authenticateAsync).not.toHaveBeenCalled()
  })
})
