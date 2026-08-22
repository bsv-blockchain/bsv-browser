/**
 * Ceremony controller — the UI-free state machine that turns "the vault key is
 * needed" into an insert → PIN → tap flow and back into a VaultKeyHandle: the
 * unwrapped vault HD node, held for the retention window and dropped on
 * release. Driven entirely by the mock driver plus a fake store view that
 * vends the enrollment meta and a seal built against the mock card's own slot
 * key, so one tap really does have to unwrap something.
 */
import { HD, Utils } from '@bsv/sdk'
import { CeremonyController } from '../../services/vault/ceremony'
import { MockYubiKey } from '../../services/vault/mockYubiKey'
import { sealVaultKey } from '../../services/vault/sealing'
import { SealedBlob, VaultError } from '../../services/vault/types'

const VAULT_SLOT = 0x82
const RETENTION = 120_000
const DEFAULT_SERIAL = '12345678'

/** A fixed, throwaway 64-byte vault seed. NEVER a real wallet's seed — it is a
 * printable pattern, not entropy, and exists only so every fixture seals and
 * unseals the same well-known value. */
const vaultSeed = (): number[] => new Array(64).fill(0).map((_, i) => (i * 7 + 3) & 0xff)

interface CeremonyHarness {
  ceremony: CeremonyController
  mock: MockYubiKey
  /** Enrollment meta the store view vends — no key material, v4 shape. */
  meta: { slot: number; yubiSerial: string }
  /** The seal the store view vends, wrapped to `mock`'s own slot key. */
  seal: SealedBlob
  /** The HD node the sealed seed reconstructs — what one tap must produce. */
  expectedHd: HD
}

/**
 * Wire a CeremonyController to a fresh MockYubiKey that already holds a
 * generated slot key, plus an enrollment record (meta + seal) bound to it —
 * mirrors a vault that has already been set up. Enrollment needs the key
 * briefly present to generate into the slot; it is removed again afterward so
 * every test starts from "no key seen yet" unless it calls mock.insertKey()
 * itself, matching the shape of the brief's own test snippets.
 */
async function makeCeremony(opts: { retentionMs?: number; sessionBased?: boolean } = {}): Promise<CeremonyHarness> {
  const mock = new MockYubiKey()
  if (opts.sessionBased) (mock as unknown as { sessionBased: boolean }).sessionBased = true
  mock.insertKey(DEFAULT_SERIAL)
  const { publicKey } = await mock.generateVaultKey(VAULT_SLOT)
  mock.removeKey()

  const seal = sealVaultKey(vaultSeed(), publicKey, { slot: VAULT_SLOT, serial: DEFAULT_SERIAL })
  const meta = { slot: VAULT_SLOT, yubiSerial: DEFAULT_SERIAL }
  const ceremony = new CeremonyController({
    getDriver: () => mock,
    store: { getMeta: async () => meta, getSeal: async () => seal },
    retentionMs: opts.retentionMs ?? RETENTION
  })
  return { ceremony, mock, meta, seal, expectedHd: HD.fromSeed(vaultSeed()) }
}

// microtask flush helper — drains microtasks by hopping the macrotask queue
const flush = () => new Promise<void>(r => setTimeout(r, 0))

describe('CeremonyController: arming', () => {
  test('driver unavailable rejects with driver-unavailable', async () => {
    const c = new CeremonyController({
      getDriver: () => null,
      store: { getMeta: async () => null, getSeal: async () => null },
      retentionMs: RETENTION
    })
    await expect(c.requestKey('x')).rejects.toMatchObject({ code: 'driver-unavailable' })
  })

  test('no meta (not enrolled) rejects with not-enrolled', async () => {
    const mock = new MockYubiKey()
    mock.insertKey(DEFAULT_SERIAL)
    const c = new CeremonyController({
      getDriver: () => mock,
      store: { getMeta: async () => null, getSeal: async () => null },
      retentionMs: RETENTION
    })
    await expect(c.requestKey('x')).rejects.toMatchObject({ code: 'not-enrolled' })
  })

  test('meta without a seal rejects with not-enrolled BEFORE asking for a tap', async () => {
    // Half-enrolled (meta written, seal missing) has nothing to unwrap, so
    // there is no point raising a YubiKey prompt the user cannot satisfy.
    const { mock, meta } = await makeCeremony()
    const startSpy = jest.spyOn(mock, 'start')
    const c = new CeremonyController({
      getDriver: () => mock,
      store: { getMeta: async () => meta, getSeal: async () => null },
      retentionMs: RETENTION
    })
    await expect(c.requestKey('x')).rejects.toMatchObject({ code: 'not-enrolled' })
    expect(startSpy).not.toHaveBeenCalled()
  })

  test('two concurrent requestKey calls share one ceremony and resolve to the SAME handle', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const p1 = c.requestKey('op A')
    const p2 = c.requestKey('op B')
    mock.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    const [h1, h2] = await Promise.all([p1, p2])
    expect(h1).toBe(h2) // release() is idempotent by construction because of this
    h1.release()
  })

  test('wrong key serial (persistent reader) → serial-mismatch error', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const p = c.requestKey('x')
    mock.insertKey('WRONG-SERIAL')
    const settled = expect(p).rejects.toMatchObject({ code: 'serial-mismatch' })
    await flush()
    expect(c.state.phase).toBe('error')
    expect(c.state.error?.code).toBe('serial-mismatch')
    await settled
  })

  test('wrong key serial (NFC tap) → serial-mismatch, and the finally still stops the session (nothing was armed)', async () => {
    const { ceremony: c, mock: nfc } = await makeCeremony({ sessionBased: true })
    const stopSpy = jest.spyOn(nfc, 'stop')
    const p = c.requestKey('x')
    nfc.insertKey('WRONG-SERIAL')
    c.submitPin('123456')
    await expect(p).rejects.toMatchObject({ code: 'serial-mismatch' })
    expect(stopSpy).toHaveBeenCalledTimes(1)
  })

  test('a wrong serial is rejected before any ECDH — a foreign card never gets asked to unwrap', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const ecdhSpy = jest.spyOn(mock, 'ecdh')
    const p = c.requestKey('x')
    mock.insertKey('WRONG-SERIAL')
    await expect(p).rejects.toMatchObject({ code: 'serial-mismatch' })
    expect(ecdhSpy).not.toHaveBeenCalled()
  })

  test('wrong PIN (persistent reader) returns to pin-entry with retriesLeft, then succeeds', async () => {
    const { ceremony: c, mock, expectedHd } = await makeCeremony()
    const p = c.requestKey('x')
    mock.insertKey(DEFAULT_SERIAL)
    await flush()
    c.submitPin('000000')
    await flush()
    expect(c.state.phase).toBe('pin-entry')
    expect(c.state.error?.code).toBe('pin-invalid')
    expect(c.state.error?.retriesLeft).toBe(2)
    c.submitPin('123456')
    const handle = await p
    expect(handle.hd.toString()).toBe(expectedHd.toString())
    handle.release()
  })

  test('NFC: a wrong PIN aborts the whole ceremony (no in-place retry) with retriesLeft intact, and stops the session', async () => {
    // A wrong PIN cannot be corrected in place on NFC — the PIN is collected
    // before the system scan sheet ever opens, so there is nothing to
    // re-prompt mid-tap. The caller (a fresh withdraw attempt) collects the
    // PIN again.
    const { ceremony: c, mock: nfc } = await makeCeremony({ sessionBased: true })
    const stopSpy = jest.spyOn(nfc, 'stop')
    const p = c.requestKey('x')
    nfc.insertKey(DEFAULT_SERIAL)
    c.submitPin('000000') // wrong
    await expect(p).rejects.toMatchObject({ code: 'pin-invalid', retriesLeft: 2 })
    expect(c.state.phase).toBe('error')
    expect(c.state.error?.code).toBe('pin-invalid')
    expect(c.state.error?.retriesLeft).toBe(2)
    expect(stopSpy).toHaveBeenCalledTimes(1) // nothing armed → the finally closed it
  })

  test('detach while waiting for the PIN → key-removed-mid-op', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const p = c.requestKey('x')
    mock.insertKey(DEFAULT_SERIAL)
    await flush()
    expect(c.state.phase).toBe('pin-entry')
    mock.removeKey() // pulled before the PIN is ever submitted
    await expect(p).rejects.toMatchObject({ code: 'key-removed-mid-op' })
    expect(c.state.phase).toBe('error')
  })

  test('cancel rejects the pending request with user-cancelled', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const p = c.requestKey('x')
    mock.insertKey(DEFAULT_SERIAL)
    await flush()
    c.cancel()
    await expect(p).rejects.toMatchObject({ code: 'user-cancelled' })
    expect(c.state.phase).toBe('idle')
  })

  test('armed window expires back to idle, fires onRelock(timeout), and drops the key', async () => {
    const { ceremony: c, mock } = await makeCeremony({ retentionMs: 1000 })
    const relocks: string[] = []
    c.onRelock = why => relocks.push(why)
    const p = c.requestKey('x')
    mock.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456') // queued; applied when the flow reaches pin-entry
    const handle = await p
    expect(c.state.phase).toBe('armed')
    await new Promise<void>(r => setTimeout(r, 1050))
    expect(c.state.phase).toBe('idle')
    expect(relocks).toEqual(['timeout'])

    // The key is gone for good: the handle must not hand it out after this.
    expect(() => handle.hd).toThrow(expect.objectContaining({ code: 'key-removed-mid-op' }))
  })

  test('notifyKeyDetached during the armed window relocks immediately and drops the key', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const relocks: string[] = []
    c.onRelock = why => relocks.push(why)
    const p = c.requestKey('x')
    mock.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456') // queued
    const handle = await p
    expect(c.state.phase).toBe('armed')
    c.notifyKeyDetached()
    expect(c.state.phase).toBe('idle')
    expect(relocks).toEqual(['detached'])

    expect(() => handle.hd).toThrow(expect.objectContaining({ code: 'key-removed-mid-op' }))
  })

  test('arming a session-based driver does NOT stop it — only release() does', async () => {
    const { ceremony: c, mock: nfc } = await makeCeremony({ sessionBased: true })
    const stopSpy = jest.spyOn(nfc, 'stop')
    const p = c.requestKey('x')
    nfc.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    const handle = await p
    expect(c.state.phase).toBe('armed')
    expect(stopSpy).not.toHaveBeenCalled()

    handle.release()
    expect(stopSpy).toHaveBeenCalledTimes(1)
    handle.release() // idempotent
    expect(stopSpy).toHaveBeenCalledTimes(1)
  })

  test('arming a persistent reader never stops it, matching before', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const stopSpy = jest.spyOn(mock, 'stop')
    const p = c.requestKey('x')
    mock.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    const handle = await p
    expect(stopSpy).not.toHaveBeenCalled()
    handle.release()
    expect(stopSpy).not.toHaveBeenCalled()
  })

  test('a session-based driver keeps notifying the ceremony after arm — an unprompted detach while armed still relocks', async () => {
    // WalletContext's own persistent-reader listener explicitly skips
    // sessionBased drivers (it exists only for Android USB unplug), so the
    // ceremony's OWN run()-level subscription is the only thing that can ever
    // learn an NFC session detached. If that subscription were torn down the
    // moment run() completes, a real driver-emitted 'detached' event — not a
    // manually-invoked one — would be silently dropped for the rest of the
    // handle's life, leaving the unwrapped key alive in memory after the card
    // that authorized it is gone. This drives the event through the MOCK's own
    // emit, not through calling ceremony.notifyKeyDetached() directly, so it
    // actually exercises the subscription wiring rather than the method body.
    const { ceremony: c, mock: nfc } = await makeCeremony({ sessionBased: true })
    const relocks: string[] = []
    c.onRelock = why => relocks.push(why)
    const p = c.requestKey('x')
    nfc.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    const handle = await p
    expect(c.state.phase).toBe('armed')

    nfc.removeKey() // a real driver-emitted detach, not a manual notify call
    expect(c.state.phase).toBe('idle')
    expect(relocks).toEqual(['detached'])
    expect(() => handle.hd).toThrow(expect.objectContaining({ code: 'key-removed-mid-op' }))
  })
})

describe('ceremony key handle', () => {
  test('one tap yields an HD node that derives the enrolled vault keys', async () => {
    const { ceremony, mock, expectedHd } = await makeCeremony()
    const p = ceremony.requestKey('test withdrawal')
    mock.insertKey(DEFAULT_SERIAL)
    ceremony.submitPin('123456')
    const handle = await p

    expect(handle.hd.toString()).toBe(expectedHd.toString())
    // The whole point of the K1-only design: the node is real enough to derive
    // spendable children, not just a matching string.
    expect(handle.hd.deriveChild(0).privKey.toHex()).toBe(expectedHd.deriveChild(0).privKey.toHex())
    handle.release()
  })

  test('release drops the key and relocks', async () => {
    const { ceremony, mock } = await makeCeremony()
    const p = ceremony.requestKey('r')
    mock.insertKey(DEFAULT_SERIAL)
    ceremony.submitPin('123456')
    const handle = await p
    expect(ceremony.state.phase).toBe('armed')

    handle.release()
    expect(ceremony.state.phase).toBe('idle')
    expect(() => handle.hd).toThrow(expect.objectContaining({ code: 'key-removed-mid-op' }))
  })

  test('exactly ONE on-token ECDH per tap, and no signing at all', async () => {
    const { ceremony, mock } = await makeCeremony()
    const ecdhSpy = jest.spyOn(mock, 'ecdh')
    const signSpy = jest.spyOn(mock, 'signEcdsa')
    const verifyPinSpy = jest.spyOn(mock, 'verifyPin')

    const p = ceremony.requestKey('Withdraw from vault')
    mock.insertKey(DEFAULT_SERIAL)
    ceremony.submitPin('123456')
    const handle = await p

    expect(ecdhSpy).toHaveBeenCalledTimes(1)
    expect(ecdhSpy).toHaveBeenCalledWith(VAULT_SLOT, '123456', expect.any(String))
    expect(signSpy).not.toHaveBeenCalled() // the card is an unwrap oracle now
    expect(verifyPinSpy).toHaveBeenCalledTimes(1)

    // Deriving many children costs nothing more — no second tap, no second ECDH.
    for (let i = 0; i < 8; i++) handle.hd.deriveChild(i)
    expect(ecdhSpy).toHaveBeenCalledTimes(1)
    handle.release()
  })

  test('the unsealed seed is zeroized as soon as the HD node is built', async () => {
    // The seed is the one artifact that CAN be wiped (the HD node itself
    // cannot — see ceremony.ts's release() doc). If this regressed, a 64-byte
    // copy of the vault seed would linger for the whole session.
    const { ceremony, mock } = await makeCeremony()
    const fillSpy = jest.spyOn(Array.prototype, 'fill')
    let zeroedA64ByteArray: boolean
    let handle
    try {
      const p = ceremony.requestKey('x')
      mock.insertKey(DEFAULT_SERIAL)
      ceremony.submitPin('123456')
      handle = await p
      zeroedA64ByteArray = fillSpy.mock.calls.some(
        ([value], i) => value === 0 && (fillSpy.mock.instances[i] as unknown[]).length === 64
      )
    } finally {
      // A spy on Array.prototype leaks into every later test in the suite if a
      // failure above skips the restore.
      fillSpy.mockRestore()
    }
    expect(zeroedA64ByteArray).toBe(true)
    handle.release()
  })

  test('nothing key-shaped reaches the React-visible ceremony state', async () => {
    const { ceremony, mock, expectedHd } = await makeCeremony()
    const seen: string[] = []
    const unsubscribe = ceremony.subscribe(s => seen.push(JSON.stringify(s)))
    const p = ceremony.requestKey('x')
    mock.insertKey(DEFAULT_SERIAL)
    ceremony.submitPin('123456')
    const handle = await p
    unsubscribe()

    const xprv = expectedHd.toString()
    const seedHex = Utils.toHex(vaultSeed())
    for (const snapshot of seen) {
      expect(snapshot).not.toContain(xprv)
      expect(snapshot).not.toContain(seedHex)
      expect(snapshot).not.toContain('123456') // the PIN never lands in state either
    }
    expect(Object.keys(ceremony.state).sort()).toEqual(['armedUntil', 'error', 'phase', 'reason'])
    handle.release()
  })

  test('a tampered seal fails the ceremony with seal-corrupt and arms nothing', async () => {
    const { mock, meta, seal } = await makeCeremony()
    const tampered: SealedBlob = { ...seal, c: seal.c.slice(0, -2) + (seal.c.endsWith('00') ? '11' : '00') }
    const c = new CeremonyController({
      getDriver: () => mock,
      store: { getMeta: async () => meta, getSeal: async () => tampered },
      retentionMs: RETENTION
    })
    const p = c.requestKey('x')
    mock.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    await expect(p).rejects.toMatchObject({ code: 'seal-corrupt' })
    expect(c.state.phase).toBe('error')
    expect(c.state.error?.code).toBe('seal-corrupt')
    // The message must not echo anything about the blob it failed to open.
    expect(c.state.error).toEqual({ code: 'seal-corrupt', retriesLeft: undefined })
  })

  test('a card whose slot key does not match the seal fails closed with seal-corrupt', async () => {
    // Same serial, different slot key — e.g. the slot was regenerated behind
    // the app's back. The ECDH succeeds; only the unseal can catch it.
    const { meta, seal } = await makeCeremony()
    const other = new MockYubiKey()
    other.insertKey(DEFAULT_SERIAL)
    await other.generateVaultKey(VAULT_SLOT)
    const c = new CeremonyController({
      getDriver: () => other,
      store: { getMeta: async () => meta, getSeal: async () => seal },
      retentionMs: RETENTION
    })
    const p = c.requestKey('x')
    c.submitPin('123456')
    await expect(p).rejects.toMatchObject({ code: 'seal-corrupt' })
  })

  test('persistent reader: a touch timeout during the unwrap returns to error, and retry succeeds without re-entering the PIN', async () => {
    const { ceremony, mock, expectedHd } = await makeCeremony()
    const verifyPinSpy = jest.spyOn(mock, 'verifyPin')
    mock.setTouchBehavior('timeout') // the touch is missed on the first try
    const p = ceremony.requestKey('Withdraw from vault')
    mock.insertKey(DEFAULT_SERIAL)
    ceremony.submitPin('123456')
    await flush()
    expect(ceremony.state.phase).toBe('error')
    expect(ceremony.state.error?.code).toBe('touch-timeout')
    expect(verifyPinSpy).toHaveBeenCalledTimes(1)

    mock.setTouchBehavior('instant')
    ceremony.retry()
    const handle = await p
    expect(handle.hd.toString()).toBe(expectedHd.toString())
    expect(verifyPinSpy).toHaveBeenCalledTimes(1) // no reopen on a persistent reader → no re-verify
    expect(ceremony.state.phase).toBe('armed')
    handle.release()
  })

  test('NFC: a dropped tap during the unwrap closes the dead session and reopens a fresh one — re-checking the serial and re-verifying the PIN — before retrying the ECDH', async () => {
    // Regression for the sealed-key design's freeze: any tap hiccup used to
    // kill the whole ceremony with a dead Retry button. The unwrap is now the
    // one touch-gated operation there is, so this is where a hiccup lands.
    const { ceremony: c, mock: nfc, expectedHd } = await makeCeremony({ sessionBased: true })
    const startSpy = jest.spyOn(nfc, 'start')
    const stopSpy = jest.spyOn(nfc, 'stop')
    const verifyPinSpy = jest.spyOn(nfc, 'verifyPin')
    const getKeyInfoSpy = jest.spyOn(nfc, 'getKeyInfo')
    const ecdhSpy = jest.spyOn(nfc, 'ecdh')

    nfc.setTouchBehavior('timeout') // the tap drops mid-ECDH
    const p = c.requestKey('Withdraw from vault')
    nfc.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    await flush()
    expect(c.state.phase).toBe('error')
    expect(c.state.error?.code).toBe('touch-timeout')
    expect(startSpy).toHaveBeenCalledTimes(1) // no reopen yet — still waiting on Retry
    // The dead session is NOT torn down just for showing the error — only
    // once the user actually retries, so a touch-timeout that turns out to be
    // a false alarm (session still alive) never had to be closed at all.
    expect(stopSpy).not.toHaveBeenCalled()

    nfc.setTouchBehavior('instant') // the second tap will succeed
    c.retry()
    await flush()
    expect(stopSpy).toHaveBeenCalledTimes(1) // retry closes the dead session before reopening

    const handle = await p
    expect(handle.hd.toString()).toBe(expectedHd.toString())
    expect(startSpy).toHaveBeenCalledTimes(2) // retry reopened a fresh NFC session
    expect(verifyPinSpy).toHaveBeenCalledTimes(2) // PIN re-verified on the fresh session
    expect(getKeyInfoSpy).toHaveBeenCalledTimes(2) // serial RE-CHECKED on the fresh session
    expect(ecdhSpy).toHaveBeenCalledTimes(2) // one failed unwrap, one that landed
    expect(c.state.phase).toBe('armed')

    handle.release()
    expect(stopSpy).toHaveBeenCalledTimes(2) // release() closes the reopened session
  })

  test('NFC: a card swap between the dropped tap and the retry is caught by the re-check', async () => {
    // The serial check has to survive at BOTH sites: if the reopened session
    // trusted the first tap's check, a second card presented on the retry
    // would be asked to unwrap a seal that is not its own.
    const { ceremony: c, mock: nfc } = await makeCeremony({ sessionBased: true })
    const ecdhSpy = jest.spyOn(nfc, 'ecdh')
    nfc.setTouchBehavior('timeout')
    const p = c.requestKey('x')
    nfc.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    await flush()
    expect(c.state.error?.code).toBe('touch-timeout')
    expect(ecdhSpy).toHaveBeenCalledTimes(1)

    nfc.setTouchBehavior('instant')
    nfc.insertKey('SOME-OTHER-KEY') // a different card lands on the retry tap
    c.retry()
    await expect(p).rejects.toMatchObject({ code: 'serial-mismatch' })
    expect(ecdhSpy).toHaveBeenCalledTimes(1) // the foreign card was never asked to unwrap
  })

  test('a genuine detach while a retry is pending fails the request instead of hanging', async () => {
    // Without notifyKeyDetached rejecting the pending retry waiter, this event
    // would be silently dropped and the retry wait would hang forever behind a
    // live "Retry?" prompt for a session that is already dead.
    const { ceremony: c, mock } = await makeCeremony()
    const relocks: string[] = []
    c.onRelock = why => relocks.push(why)
    mock.setTouchBehavior('timeout')
    const p = c.requestKey('Withdraw from vault')
    mock.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    await flush()
    expect(c.state.phase).toBe('error')
    expect(c.state.error?.code).toBe('touch-timeout')

    mock.removeKey()

    await expect(p).rejects.toMatchObject({ code: 'key-removed-mid-op' })
    expect(c.state.phase).toBe('error')
    expect(c.state.error?.code).toBe('key-removed-mid-op')
    // Nothing was ever armed — the drop happened before the key was unwrapped
    // — so there is no session to relock, only a request to fail.
    expect(relocks).toEqual([])
  })

  test('cancelling during a retry wait rejects the request', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const relocks: string[] = []
    c.onRelock = why => relocks.push(why)
    mock.setTouchBehavior('timeout')
    const p = c.requestKey('Withdraw from vault')
    mock.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    await flush()
    expect(c.state.phase).toBe('error')

    c.cancel()
    await expect(p).rejects.toMatchObject({ code: 'user-cancelled' })
    expect(c.state.phase).toBe('idle')
    expect(relocks).toEqual([])
  })
})

// The ceremonyHost singleton is ONE CeremonyController for the whole process
// lifetime — every fixture above builds a fresh controller per test, which
// cannot see anything that only becomes reachable on a SECOND ceremony
// against the same controller. These tests deliberately reuse one `c` across
// two (or more) full arm→use→release cycles, the way production actually runs.
describe('CeremonyController: one singleton, sequential ceremonies', () => {
  test("a handle released normally clears activeHandle, so a SECOND ceremony's error path still stops the session", async () => {
    const { ceremony: c, mock: nfc } = await makeCeremony({ sessionBased: true })

    // Ceremony 1: arm normally and release, exactly as a caller finishing a
    // withdrawal would in its own finally.
    const p1 = c.requestKey('withdraw 1')
    nfc.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    const handle1 = await p1
    expect(c.state.phase).toBe('armed')
    handle1.release()
    expect(c.state.phase).toBe('idle')

    // Ceremony 2: force a serial-mismatch by presenting a different key.
    const stopSpy = jest.spyOn(nfc, 'stop')
    const p2 = c.requestKey('withdraw 2')
    nfc.insertKey('WRONG-SERIAL')
    c.submitPin('123456')
    await expect(p2).rejects.toMatchObject({ code: 'serial-mismatch' })

    // The bug this guards against: if release() never cleared activeHandle,
    // run()'s finally guard `if (!armed)` would be reasoning about a STALE
    // handle from ceremony 1 and skip closing ceremony 2's dead session
    // entirely — leaving the system NFC sheet open on exactly the error path
    // that guard exists to handle.
    expect(stopSpy).toHaveBeenCalledTimes(1)

    // And the controller is left clean enough for a third ceremony to arm.
    const p3 = c.requestKey('withdraw 3')
    nfc.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    const handle3 = await p3
    expect(c.state.phase).toBe('armed')
    handle3.release()
  })

  test("a late release() from a stale handle must not steal a successor's PENDING attach-wait", async () => {
    const { ceremony: c, mock: nfc } = await makeCeremony({ sessionBased: true })

    // Ceremony A arms normally.
    const p1 = c.requestKey('withdraw A')
    nfc.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    const handleA = await p1
    expect(c.state.phase).toBe('armed')

    // Ceremony B starts — a SECOND, independent ceremony — before A's caller
    // has released: the realistic "slow finalize/broadcast" case the module
    // doc describes. The mock's start() would normally re-detect the
    // still-"present" key SYNCHRONOUSLY (see MockYubiKey.start), which
    // resolves B's own attach-wait before this test ever gets a chance to
    // interleave anything. Stubbing start() removes that synchronous shortcut
    // and opens the genuine window: B is now parked awaiting a fresh attach
    // event, same as a real NFC tap that has not landed yet.
    const startSpy = jest.spyOn(nfc, 'start').mockImplementation(() => {})
    const p2 = c.requestKey('withdraw B')
    c.submitPin('123456')
    await flush()
    expect(c.state.phase).toBe('waiting-for-key') // B is genuinely pending, not yet armed

    // *** A's caller finally releases here — squarely inside B's pending
    // attach-wait. This is exactly the scenario the KeyEventSession box (a
    // per-attempt subscription, not one shared controller-wide field) exists
    // to protect: with a single shared field, A's release() unsubscribing it
    // would remove the listener B just registered for its own arm, and B's
    // `await waiter.promise` below would then hang forever. ***
    handleA.release()

    // The physical tap for B lands.
    startSpy.mockRestore()
    nfc.insertKey(DEFAULT_SERIAL)
    const handleB = await p2
    expect(handleB).not.toBe(handleA) // a genuinely new session, not shared
    expect(c.state.phase).toBe('armed')

    handleB.release()
  })

  test('an attempt cancelled while its ECDH is in flight cannot arm behind the successor that replaced it', async () => {
    // The resurrection race. cancel() sets running=false while attempt #1 is
    // still parked inside driver.ecdh — a real NFC tap can land seconds after
    // the user gives up — and the requestKey() that follows both starts
    // attempt #2 AND resets `cancelled` to false. When #1's tap finally lands,
    // every "am I still wanted?" flag reads clean. Without the generation
    // check, #1 then installs its own handle over #2's, arms a second timer,
    // and fires onArmed with a key nobody asked for: two unwrapped vault keys
    // live at once, one of them owned by no caller and released by nothing.
    const { ceremony: c, mock, expectedHd } = await makeCeremony()
    const armedHandles: unknown[] = []
    c.onArmed = h => armedHandles.push(h)

    // Park attempt #1 inside the ECDH until we say so.
    const realEcdh = mock.ecdh.bind(mock)
    let landTap: (() => void) | undefined
    jest
      .spyOn(mock, 'ecdh')
      .mockImplementationOnce(
        (slot, pin, peer) =>
          new Promise(resolve => {
            landTap = () => resolve(realEcdh(slot, pin, peer))
          })
      )

    const p1 = c.requestKey('op 1')
    mock.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    await flush()
    expect(c.state.phase).toBe('awaiting-touch')
    expect(landTap).toBeDefined() // #1 is genuinely parked mid-ECDH

    // The user gives up. #1 is still holding an open tap.
    const rejected = expect(p1).rejects.toMatchObject({ code: 'user-cancelled' })
    c.cancel()
    await rejected

    // A second ceremony starts immediately — this one gets the real ecdh.
    const p2 = c.requestKey('op 2')
    c.submitPin('123456')
    const handle2 = await p2
    expect(c.state.phase).toBe('armed')
    expect(armedHandles).toEqual([handle2])

    // *** #1's abandoned tap lands here, well after it was replaced. ***
    landTap!()
    await flush()

    // Nothing changed hands: #2 is still the one and only armed session, and
    // #1's key never reached a caller, a timer, or onArmed.
    expect(armedHandles).toEqual([handle2])
    expect(c.state.phase).toBe('armed')
    expect(handle2.hd.toString()).toBe(expectedHd.toString())
    // #1 also cleaned up after itself: no orphaned key-event listener. (A
    // persistent reader's ceremony drops its own listener once armed, so an
    // armed, tidy controller holds none at all.)
    expect((mock as unknown as { listeners: Set<unknown> }).listeners.size).toBe(0)

    // And #2 still owns the controller's state: its release relocks.
    handle2.release()
    expect(c.state.phase).toBe('idle')
    expect(() => handle2.hd).toThrow(expect.objectContaining({ code: 'key-removed-mid-op' }))
  })

  test('a superseded attempt that FAILS never rejects the successor waiting behind it', async () => {
    // Same race, error arm: #1's abandoned tap comes back as a hard failure
    // instead of a secret. Its rejection belongs to a ceremony nobody is
    // waiting on any more, so it must not reject #2's caller or repaint the
    // phase out from under an armed session.
    const { ceremony: c, mock } = await makeCeremony()
    const realEcdh = mock.ecdh.bind(mock)
    let failTap: (() => void) | undefined
    jest.spyOn(mock, 'ecdh').mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failTap = () => reject(new VaultError('pin-locked', 'PIN is blocked'))
        })
    )

    const p1 = c.requestKey('op 1')
    mock.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    await flush()
    const rejected = expect(p1).rejects.toMatchObject({ code: 'user-cancelled' })
    c.cancel()
    await rejected

    ;(mock.ecdh as jest.Mock).mockImplementation(realEcdh)
    const p2 = c.requestKey('op 2')
    c.submitPin('123456')
    const handle2 = await p2
    expect(c.state.phase).toBe('armed')

    failTap!()
    await flush()

    // #2 is untouched: still armed, still usable, no error painted.
    expect(c.state.phase).toBe('armed')
    expect(c.state.error).toBeUndefined()
    expect(handle2.hd).toBeDefined()
    handle2.release()
  })
})

describe('CeremonyController: post-arm progress', () => {
  test('progress from the spend path shows through, and never leaks the key', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const p = c.requestKey('x')
    mock.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    const handle = await p

    c.noteProgress({ phase: 'preparing' })
    expect(c.state.phase).toBe('preparing')
    c.noteProgress({ phase: 'broadcasting' })
    expect(c.state.phase).toBe('broadcasting')

    handle.release()
    expect(c.state.phase).toBe('idle')
  })

  test('progress with nothing armed is ignored — this is what keeps the ceremony-free sweep sheet-free', async () => {
    const { ceremony: c } = await makeCeremony()
    c.noteProgress({ phase: 'preparing' })
    expect(c.state.phase).toBe('idle')
    c.noteProgress({ phase: 'broadcasting' })
    expect(c.state.phase).toBe('idle')
  })

  test('progress arriving mid-arm is ignored — the arming phases own the display', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const p = c.requestKey('x')
    mock.insertKey(DEFAULT_SERIAL)
    await flush()
    expect(c.state.phase).toBe('pin-entry')
    c.noteProgress({ phase: 'preparing' })
    expect(c.state.phase).toBe('pin-entry')
    c.submitPin('123456')
    ;(await p).release()
  })
})

describe('CeremonyController: retention timeout robustness', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  test('the retention window elapsing while the spend path is still working relocks rather than staying armed forever', async () => {
    jest.useFakeTimers()
    const { ceremony: c, mock } = await makeCeremony({ retentionMs: 1000 })
    const relocks: string[] = []
    c.onRelock = why => relocks.push(why)
    const p = c.requestKey('x')
    mock.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    const handle = await p
    expect(c.state.phase).toBe('armed')

    // A withdrawal that stalls in broadcast: phase is 'broadcasting', not
    // 'armed', for the whole rest of this test.
    c.noteProgress({ phase: 'broadcasting' })
    expect(c.state.phase).toBe('broadcasting')

    // Advance past the full retention window plus the grace recheck the
    // busy-path fallback schedules.
    await jest.advanceTimersByTimeAsync(1000 + 5_000 + 10)

    // The bug this guards against: the ORIGINAL one-shot timer's callback was
    // guarded by `phase === 'armed'`, which is false here; without a
    // reschedule, the callback would return and NOTHING would ever check
    // again — an unwrapped vault key that never leaves memory.
    expect(c.state.phase).toBe('idle')
    expect(relocks).toEqual(['timeout'])
    expect(() => handle.hd).toThrow(expect.objectContaining({ code: 'key-removed-mid-op' }))
  })

  test('reported progress refreshes the retention window instead of letting the original deadline expire underneath an active withdrawal', async () => {
    jest.useFakeTimers()
    // 10s window → the 3x absolute ceiling sits at t=30_000, well clear of
    // everything this test exercises; the ceiling gets its own test below.
    const { ceremony: c, mock } = await makeCeremony({ retentionMs: 10_000 })
    const relocks: string[] = []
    c.onRelock = why => relocks.push(why)
    const p = c.requestKey('x')
    mock.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    const handle = await p
    const firstDeadline = c.state.armedUntil!

    // Report progress well before the window elapses...
    await jest.advanceTimersByTimeAsync(6_000)
    c.noteProgress({ phase: 'preparing' })
    expect(c.state.armedUntil!).toBeGreaterThan(firstDeadline) // the deadline moved

    // ...then advance past the ORIGINAL deadline (t=10_000) AND the grace
    // recheck that would have followed it (t=15_000) — i.e. the exact instant
    // an unrefreshed window would have relocked — without ever going idle.
    // Proves the progress note rescheduled the timer rather than leaving the
    // original one-shot deadline to fire underneath a live withdrawal.
    await jest.advanceTimersByTimeAsync(12_000) // t = 18_000
    expect(c.state.phase).toBe('preparing')
    expect(relocks).toEqual([])
    expect(handle.hd).toBeDefined()

    handle.release()
  })

  test('the absolute ceiling relocks a session that keeps renewing itself with progress notes', async () => {
    // The refresh above must not become a lease a caller can renew forever:
    // that would make the retention window no boundary at all, and the
    // unwrapped vault key would live for as long as the spend path felt like
    // reporting. Past armedAt + 3x retention the relock fires regardless.
    jest.useFakeTimers()
    const { ceremony: c, mock } = await makeCeremony({ retentionMs: 1000 })
    const relocks: string[] = []
    c.onRelock = why => relocks.push(why)
    const p = c.requestKey('x')
    mock.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    const handle = await p
    expect(c.state.phase).toBe('armed')

    // A note every 200ms — never letting a full window elapse — for well past
    // the 3x ceiling at t=3000.
    for (let t = 0; t < 6_000; t += 200) {
      await jest.advanceTimersByTimeAsync(200)
      c.noteProgress({ phase: 'broadcasting' })
    }

    expect(relocks).toEqual(['timeout'])
    expect(c.state.phase).toBe('idle')
    expect(() => handle.hd).toThrow(expect.objectContaining({ code: 'key-removed-mid-op' }))
  })

  test('the ceiling is anchored per ceremony, so a fresh arm gets a full new life', async () => {
    jest.useFakeTimers()
    const { ceremony: c, mock } = await makeCeremony({ retentionMs: 1000 })
    const p1 = c.requestKey('x')
    mock.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    const h1 = await p1
    await jest.advanceTimersByTimeAsync(4_000) // past ceremony 1's ceiling
    expect(c.state.phase).toBe('idle')
    expect(() => h1.hd).toThrow(expect.objectContaining({ code: 'key-removed-mid-op' }))

    // Ceremony 2 on the same controller starts its own clock.
    const p2 = c.requestKey('y')
    c.submitPin('123456')
    const h2 = await p2
    expect(c.state.phase).toBe('armed')
    await jest.advanceTimersByTimeAsync(900)
    expect(c.state.phase).toBe('armed') // not inheriting ceremony 1's exhausted ceiling
    h2.release()
  })
})

describe('CeremonyController: unwrap error handling', () => {
  test('a non-retryable ecdh error surfaces phase: error with the code, instead of leaving awaiting-touch stuck', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const p = c.requestKey('x')
    mock.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')

    // pin-locked is a real driver failure, not one of the RETRYABLE_TAP_ERRORS
    // (touch-timeout / nfc-lost / key-removed-mid-op) — it must not be
    // retried in place.
    jest.spyOn(mock, 'ecdh').mockRejectedValueOnce(new VaultError('pin-locked', 'PIN is blocked'))

    await expect(p).rejects.toMatchObject({ code: 'pin-locked' })
    expect(c.state.phase).toBe('error')
    expect(c.state.error?.code).toBe('pin-locked')
  })

  test('an unrecognized (non-VaultError) ecdh failure is treated as a retryable field drop', async () => {
    const { ceremony: c, mock, expectedHd } = await makeCeremony()
    const p = c.requestKey('x')
    mock.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    jest.spyOn(mock, 'ecdh').mockRejectedValueOnce(new Error('tag connection lost'))
    await flush()
    expect(c.state.phase).toBe('error')
    expect(c.state.error?.code).toBe('nfc-lost')

    c.retry()
    const handle = await p
    expect(handle.hd.toString()).toBe(expectedHd.toString())
    handle.release()
  })
})
