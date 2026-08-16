/* global jest */
/**
 * A fake expo-secure-store that models the parts of the real native modules
 * that this scheme depends on. A naive record<string,string> fake cannot prove
 * anything here, because the properties under test are all about *how* items
 * are stored:
 *
 *  - entries are keyed by (keychainService, key, authMode), so an
 *    unauthenticated item can shadow an authenticated one under the same key —
 *    this is what makes distinct KEK key names load-bearing rather than
 *    cosmetic;
 *  - reads probe unauthenticated first, then authenticated, mirroring iOS;
 *  - authenticated reads AND authenticated writes each cost one prompt, so
 *    tests can assert exact prompt totals;
 *  - a biometric-enrolment change makes authenticated reads resolve null
 *    (never throw), which is how both platforms actually report it;
 *  - cancellation and lockout reject with the platforms' real message strings.
 */
const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 'afudo'
const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 'wudo'

const state = {
  entries: new Map(),
  optionsSeen: [],
  prompts: 0,
  outcome: 'ok',
  invalidated: false,
  readOverrides: new Map()
}

const svc = options => (options && options.keychainService) || 'app'
const mode = options => (options && options.requireAuthentication ? 'auth' : 'noauth')
const id = (service, key, m) => `${service}|${key}|${m}`

function prompt() {
  state.prompts++
  if (state.outcome === 'cancel') {
    throw new Error('User canceled the operation.')
  }
  if (state.outcome === 'lockout') {
    throw new Error('Could not Authenticate the user: Lockout. Too many attempts.')
  }
}

const fake = {
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  WHEN_UNLOCKED: 'wu',
  AFTER_FIRST_UNLOCK: 'afu',

  getItemAsync: jest.fn(async (key, options) => {
    const service = svc(options)
    state.optionsSeen.push({ op: 'get', key, options })

    if (state.readOverrides.has(key)) return state.readOverrides.get(key)

    // Unauthenticated entries win, exactly as iOS's alias probing does.
    const plain = state.entries.get(id(service, key, 'noauth'))
    if (plain !== undefined) return plain

    const authed = state.entries.get(id(service, key, 'auth'))
    if (authed === undefined) return null

    // The OS destroyed the key: reported as a plain null, not an error.
    if (state.invalidated) return null

    prompt()
    return authed
  }),

  setItemAsync: jest.fn(async (key, value, options) => {
    const service = svc(options)
    const m = mode(options)
    state.optionsSeen.push({ op: 'set', key, options })

    if (m === 'auth') {
      // Minting/using an auth-bound key requires a ceremony on Android.
      prompt()
      // Writing re-creates the key, which clears a prior invalidation.
      state.invalidated = false
    }
    state.entries.set(id(service, key, m), value)
    // The native modules drop the opposite-mode entry on a successful write.
    state.entries.delete(id(service, key, m === 'auth' ? 'noauth' : 'auth'))
  }),

  deleteItemAsync: jest.fn(async (key, options) => {
    const service = svc(options)
    state.optionsSeen.push({ op: 'delete', key, options })
    // Deletion never prompts, and clears every alias for the key.
    state.entries.delete(id(service, key, 'auth'))
    state.entries.delete(id(service, key, 'noauth'))
  }),

  /* ------------------------------ test surface ----------------------------- */

  __reset() {
    state.entries.clear()
    state.readOverrides.clear()
    state.optionsSeen = []
    state.prompts = 0
    state.outcome = 'ok'
    state.invalidated = false
    fake.getItemAsync.mockClear()
    fake.setItemAsync.mockClear()
    fake.deleteItemAsync.mockClear()
  },
  /** Force a key's read to return a fixed value, e.g. to simulate a blob
   * that came back corrupted from storage. */
  __overrideRead(key, value) {
    state.readOverrides.set(key, value)
  },
  __prompts: () => state.prompts,
  /** Zero the counter without touching stored entries, so a test can set up an
   * install and then measure only what a subsequent cold start costs. */
  __clearPrompts() {
    state.prompts = 0
  },
  __setOutcome(outcome) {
    state.outcome = outcome
  },
  /** Simulates a biometric enrolment change / screen-lock removal. */
  __invalidateBiometrics() {
    state.invalidated = true
  },
  __seed(key, value, { service = 'app', auth = false } = {}) {
    state.entries.set(id(service, key, auth ? 'auth' : 'noauth'), value)
  },
  __get(key, { service = 'app', auth = false } = {}) {
    return state.entries.get(id(service, key, auth ? 'auth' : 'noauth'))
  },
  __has(key, opts) {
    return fake.__get(key, opts) !== undefined
  },
  __keys: () => [...state.entries.keys()],
  __optionsFor(op, key) {
    return state.optionsSeen.filter(o => o.op === op && o.key === key).map(o => o.options)
  },
  __ops: () => state.optionsSeen.map(o => `${o.op}:${o.key}`)
}

module.exports = { fake }
