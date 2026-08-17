/**
 * Ceremony controller — the UI-free state machine that turns "a vault signer
 * is needed" into an insert → PIN → arm flow and back into a VaultR1Signer
 * that can sign digests for as long as its session stays open. Driven
 * entirely by the mock driver + a fake meta store.
 */
import { Utils } from '@bsv/sdk'
import { CeremonyController } from '../../services/vault/ceremony'
import { MockYubiKey } from '../../services/vault/mockYubiKey'
import { compressP256 } from '../../services/vault/r1k1'
import { VaultError } from '../../services/vault/types'

const VAULT_SLOT = 0x82
const RETENTION = 120_000
const DEFAULT_SERIAL = '12345678'

interface CeremonyHarness {
  ceremony: CeremonyController
  mock: MockYubiKey
}

/**
 * Wire a CeremonyController to a fresh MockYubiKey that already holds a
 * generated slot key and an enrollment record bound to it — mirrors a vault
 * that has already been set up. Enrollment needs the key briefly present to
 * generate into the slot; it is removed again afterward so every test starts
 * from "no key seen yet" unless it calls mock.insertKey() itself, matching
 * the shape of the brief's own test snippets.
 */
async function makeCeremony(opts: { retentionMs?: number; sessionBased?: boolean } = {}): Promise<CeremonyHarness> {
  const mock = new MockYubiKey()
  if (opts.sessionBased) (mock as unknown as { sessionBased: boolean }).sessionBased = true
  mock.insertKey(DEFAULT_SERIAL)
  const { publicKey } = await mock.generateVaultKey(VAULT_SLOT)
  mock.removeKey()

  const meta = { slot: VAULT_SLOT, yubiSerial: DEFAULT_SERIAL, r1PublicKey: compressP256(publicKey) }
  const ceremony = new CeremonyController({
    getDriver: () => mock,
    store: { getMeta: async () => meta },
    retentionMs: opts.retentionMs ?? RETENTION
  })
  return { ceremony, mock }
}

// microtask flush helper — drains microtasks by hopping the macrotask queue
const flush = () => new Promise<void>(r => setTimeout(r, 0))

const digest = (fill: number) => Uint8Array.from(new Array(32).fill(fill))

describe('CeremonyController: arming', () => {
  test('driver unavailable rejects with driver-unavailable', async () => {
    const c = new CeremonyController({
      getDriver: () => null,
      store: { getMeta: async () => null },
      retentionMs: RETENTION
    })
    await expect(c.requestSigner('x')).rejects.toMatchObject({ code: 'driver-unavailable' })
  })

  test('no meta (not enrolled) rejects with not-enrolled', async () => {
    const mock = new MockYubiKey()
    mock.insertKey(DEFAULT_SERIAL)
    const c = new CeremonyController({
      getDriver: () => mock,
      store: { getMeta: async () => null },
      retentionMs: RETENTION
    })
    await expect(c.requestSigner('x')).rejects.toMatchObject({ code: 'not-enrolled' })
  })

  test('two concurrent requestSigner calls share one ceremony and resolve to the SAME signer', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const p1 = c.requestSigner('op A')
    const p2 = c.requestSigner('op B')
    mock.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    const [s1, s2] = await Promise.all([p1, p2])
    expect(s1).toBe(s2) // release() is idempotent by construction because of this
    s1.release()
  })

  test('wrong key serial (persistent reader) → serial-mismatch error', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const p = c.requestSigner('x')
    mock.insertKey('WRONG-SERIAL')
    const settled = expect(p).rejects.toMatchObject({ code: 'serial-mismatch' })
    await flush()
    expect(c.state.phase).toBe('error')
    expect(c.state.error?.code).toBe('serial-mismatch')
    await settled
  })

  test('wrong key serial (NFC tap) → serial-mismatch, and the finally still stops the session (no signer was armed)', async () => {
    const { ceremony: c, mock: nfc } = await makeCeremony({ sessionBased: true })
    const stopSpy = jest.spyOn(nfc, 'stop')
    const p = c.requestSigner('x')
    nfc.insertKey('WRONG-SERIAL')
    c.submitPin('123456')
    await expect(p).rejects.toMatchObject({ code: 'serial-mismatch' })
    expect(stopSpy).toHaveBeenCalledTimes(1)
  })

  test('wrong PIN (persistent reader) returns to pin-entry with retriesLeft, then succeeds', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const p = c.requestSigner('x')
    mock.insertKey(DEFAULT_SERIAL)
    await flush()
    c.submitPin('000000')
    await flush()
    expect(c.state.phase).toBe('pin-entry')
    expect(c.state.error?.code).toBe('pin-invalid')
    expect(c.state.error?.retriesLeft).toBe(2)
    c.submitPin('123456')
    const signer = await p
    expect(signer.publicKey.length).toBe(33)
    signer.release()
  })

  test('NFC: a wrong PIN aborts the whole ceremony (no in-place retry) with retriesLeft intact, and stops the session', async () => {
    // A wrong PIN cannot be corrected in place on NFC — the PIN is collected
    // before the system scan sheet ever opens, so there is nothing to
    // re-prompt mid-tap. The caller (a fresh withdraw attempt) collects the
    // PIN again.
    const { ceremony: c, mock: nfc } = await makeCeremony({ sessionBased: true })
    const stopSpy = jest.spyOn(nfc, 'stop')
    const p = c.requestSigner('x')
    nfc.insertKey(DEFAULT_SERIAL)
    c.submitPin('000000') // wrong
    await expect(p).rejects.toMatchObject({ code: 'pin-invalid', retriesLeft: 2 })
    expect(c.state.phase).toBe('error')
    expect(c.state.error?.code).toBe('pin-invalid')
    expect(c.state.error?.retriesLeft).toBe(2)
    expect(stopSpy).toHaveBeenCalledTimes(1) // no signer armed → the finally closed it
  })

  test('detach while waiting for the PIN → key-removed-mid-op', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const p = c.requestSigner('x')
    mock.insertKey(DEFAULT_SERIAL)
    await flush()
    expect(c.state.phase).toBe('pin-entry')
    mock.removeKey() // pulled before the PIN is ever submitted
    await expect(p).rejects.toMatchObject({ code: 'key-removed-mid-op' })
    expect(c.state.phase).toBe('error')
  })

  test('cancel rejects the pending request with user-cancelled', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const p = c.requestSigner('x')
    mock.insertKey(DEFAULT_SERIAL)
    await flush()
    c.cancel()
    await expect(p).rejects.toMatchObject({ code: 'user-cancelled' })
    expect(c.state.phase).toBe('idle')
  })

  test('armed window expires back to idle, fires onRelock(timeout), and releases the signer', async () => {
    const { ceremony: c, mock } = await makeCeremony({ retentionMs: 1000 })
    const relocks: string[] = []
    c.onRelock = why => relocks.push(why)
    const p = c.requestSigner('x')
    mock.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456') // queued; applied when the flow reaches pin-entry
    const signer = await p
    expect(c.state.phase).toBe('armed')
    await new Promise<void>(r => setTimeout(r, 1050))
    expect(c.state.phase).toBe('idle')
    expect(relocks).toEqual(['timeout'])

    // The session is closed for good: sign() must not succeed after this.
    await expect(signer.sign(digest(1))).rejects.toMatchObject({ code: 'key-removed-mid-op' })
  })

  test('notifyKeyDetached during the armed window relocks immediately and releases the signer', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const relocks: string[] = []
    c.onRelock = why => relocks.push(why)
    const p = c.requestSigner('x')
    mock.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456') // queued
    const signer = await p
    expect(c.state.phase).toBe('armed')
    c.notifyKeyDetached()
    expect(c.state.phase).toBe('idle')
    expect(relocks).toEqual(['detached'])

    await expect(signer.sign(digest(1))).rejects.toMatchObject({ code: 'key-removed-mid-op' })
  })

  test('arming a session-based driver does NOT stop it — only release() does, so the session stays open for signing', async () => {
    const { ceremony: c, mock: nfc } = await makeCeremony({ sessionBased: true })
    const stopSpy = jest.spyOn(nfc, 'stop')
    const p = c.requestSigner('x')
    nfc.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    const signer = await p
    expect(c.state.phase).toBe('armed')
    expect(stopSpy).not.toHaveBeenCalled()

    await signer.sign(digest(1))
    expect(stopSpy).not.toHaveBeenCalled() // still open after a signature

    signer.release()
    expect(stopSpy).toHaveBeenCalledTimes(1)
    signer.release() // idempotent
    expect(stopSpy).toHaveBeenCalledTimes(1)
  })

  test('arming a persistent reader never stops it, matching before', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const stopSpy = jest.spyOn(mock, 'stop')
    const p = c.requestSigner('x')
    mock.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    const signer = await p
    expect(stopSpy).not.toHaveBeenCalled()
    signer.release()
    expect(stopSpy).not.toHaveBeenCalled()
  })

  test('a session-based driver keeps notifying the ceremony after arm — an unprompted detach while idle-armed still relocks', async () => {
    // WalletContext's own persistent-reader listener explicitly skips
    // sessionBased drivers (it exists only for Android USB unplug), so the
    // ceremony's OWN run()-level subscription is the only thing that can ever
    // learn an NFC session detached. If that subscription were torn down the
    // moment run() completes (as arming's own request/response cycle no
    // longer needs it), a real driver-emitted 'detached' event — not a
    // manually-invoked one — would be silently dropped for the rest of the
    // signer's life. This drives the event through the MOCK's own emit, not
    // through calling ceremony.notifyKeyDetached() directly, so it actually
    // exercises the subscription wiring rather than just the method body.
    const { ceremony: c, mock: nfc } = await makeCeremony({ sessionBased: true })
    const relocks: string[] = []
    c.onRelock = why => relocks.push(why)
    const p = c.requestSigner('x')
    nfc.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    const signer = await p
    expect(c.state.phase).toBe('armed')

    nfc.removeKey() // a real driver-emitted detach, not a manual notify call
    expect(c.state.phase).toBe('idle')
    expect(relocks).toEqual(['detached'])
    await expect(signer.sign(digest(1))).rejects.toMatchObject({ code: 'key-removed-mid-op' })
  })
})

describe('ceremony signing session', () => {
  test('signs several digests from one arm without re-collecting or re-verifying the PIN', async () => {
    const { ceremony, mock } = await makeCeremony()
    const verifyPinSpy = jest.spyOn(mock, 'verifyPin')
    const p = ceremony.requestSigner('Withdraw from vault')
    mock.insertKey(DEFAULT_SERIAL)
    ceremony.submitPin('123456')
    const signer = await p
    expect(verifyPinSpy).toHaveBeenCalledTimes(1)

    const a = await signer.sign(digest(1))
    const b = await signer.sign(digest(2))

    expect(a.length).toBeGreaterThan(0)
    expect(Utils.toHex(a)).not.toBe(Utils.toHex(b))
    expect(signer.publicKey.length).toBe(33)
    expect(verifyPinSpy).toHaveBeenCalledTimes(1) // still just the one, from arming
    expect(ceremony.state.phase).toBe('armed') // back to armed between signatures
    signer.release()
  })

  test('rejects a digest that is not 32 bytes without touching the driver', async () => {
    const { ceremony, mock } = await makeCeremony()
    const signEcdsaSpy = jest.spyOn(mock, 'signEcdsa')
    const p = ceremony.requestSigner('Withdraw from vault')
    mock.insertKey(DEFAULT_SERIAL)
    ceremony.submitPin('123456')
    const signer = await p

    await expect(signer.sign(Uint8Array.from(new Array(31).fill(1)))).rejects.toMatchObject({
      code: 'template-invalid'
    })
    expect(signEcdsaSpy).not.toHaveBeenCalled()
    expect(ceremony.state.phase).toBe('armed') // rejected before ever touching the phase machinery
    signer.release()
  })

  test('refuses to sign after release', async () => {
    const { ceremony, mock } = await makeCeremony()
    const p = ceremony.requestSigner('Withdraw from vault')
    mock.insertKey(DEFAULT_SERIAL)
    ceremony.submitPin('123456')
    const signer = await p
    signer.release()

    await expect(signer.sign(digest(1))).rejects.toMatchObject({ code: 'key-removed-mid-op' })
  })

  test('persistent reader: a touch timeout mid-signature returns to error, and retry succeeds without re-entering the PIN', async () => {
    const { ceremony, mock } = await makeCeremony()
    const verifyPinSpy = jest.spyOn(mock, 'verifyPin')
    const p = ceremony.requestSigner('Withdraw from vault')
    mock.insertKey(DEFAULT_SERIAL)
    ceremony.submitPin('123456')
    const signer = await p
    expect(verifyPinSpy).toHaveBeenCalledTimes(1)

    mock.setTouchBehavior('timeout')
    const signing = signer.sign(digest(3))
    await flush()
    expect(ceremony.state.phase).toBe('error')
    expect(ceremony.state.error?.code).toBe('touch-timeout')

    mock.setTouchBehavior('instant')
    ceremony.retry()
    const sig = await signing
    expect(sig.length).toBeGreaterThan(0)
    expect(verifyPinSpy).toHaveBeenCalledTimes(1) // no reopen on a persistent reader → no re-verify
    signer.release()
  })

  test('NFC: a dropped tap mid-signature closes the dead session and reopens a fresh one — re-checking the serial and re-verifying the PIN — before retrying that signature', async () => {
    // Regression for the sealed-key design's freeze: any tap hiccup used to
    // kill the whole ceremony with a dead Retry button. Here the hiccup
    // happens mid-WITHDRAWAL (after arming, during a signature), which is the
    // scenario this whole task exists to support.
    const { ceremony: c, mock: nfc } = await makeCeremony({ sessionBased: true })
    const startSpy = jest.spyOn(nfc, 'start')
    const stopSpy = jest.spyOn(nfc, 'stop')
    const verifyPinSpy = jest.spyOn(nfc, 'verifyPin')
    const getKeyInfoSpy = jest.spyOn(nfc, 'getKeyInfo')

    const p = c.requestSigner('Withdraw from vault')
    nfc.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    const signer = await p
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(verifyPinSpy).toHaveBeenCalledTimes(1)
    expect(getKeyInfoSpy).toHaveBeenCalledTimes(1)
    expect(stopSpy).not.toHaveBeenCalled() // session stays open across the arm

    nfc.setTouchBehavior('timeout') // the tap drops mid-signature
    const signing = signer.sign(digest(7))
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
    const sig = await signing
    expect(sig.length).toBeGreaterThan(0)
    expect(startSpy).toHaveBeenCalledTimes(2) // retry reopened a fresh NFC session
    expect(verifyPinSpy).toHaveBeenCalledTimes(2) // PIN re-verified on the fresh session
    expect(getKeyInfoSpy).toHaveBeenCalledTimes(2) // serial re-checked on the fresh session
    expect(c.state.phase).toBe('armed')

    signer.release()
    expect(stopSpy).toHaveBeenCalledTimes(2) // release() closes the reopened session
  })

  test('a genuine detach while a mid-signature retry is pending releases the signer and fails that signature', async () => {
    // Simulates WalletContext's own persistent-reader listener, which keeps
    // forwarding detach events after the ceremony's OWN run()-level
    // subscription has already unsubscribed post-arm (see run()'s finally).
    // Without notifyKeyDetached reacting to an active (not just 'armed')
    // signer, this event would be silently dropped and the retry wait would
    // hang forever.
    const { ceremony: c, mock } = await makeCeremony()
    const relocks: string[] = []
    c.onRelock = why => relocks.push(why)
    const p = c.requestSigner('Withdraw from vault')
    mock.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    const signer = await p
    expect(c.state.phase).toBe('armed')

    mock.setTouchBehavior('timeout')
    const signing = signer.sign(digest(4))
    await flush()
    expect(c.state.phase).toBe('error')
    expect(c.state.error?.code).toBe('touch-timeout')

    mock.removeKey()
    c.notifyKeyDetached()

    await expect(signing).rejects.toMatchObject({ code: 'key-removed-mid-op' })
    expect(c.state.phase).toBe('idle')
    expect(relocks).toEqual(['detached'])

    // The session is closed for good — a later signature must not succeed.
    await expect(signer.sign(digest(5))).rejects.toMatchObject({ code: 'key-removed-mid-op' })
  })

  test('cancelling during a mid-signature retry wait releases the signer and fails that signature', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const relocks: string[] = []
    c.onRelock = why => relocks.push(why)
    const p = c.requestSigner('Withdraw from vault')
    mock.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    const signer = await p

    mock.setTouchBehavior('timeout')
    const signing = signer.sign(digest(6))
    await flush()
    expect(c.state.phase).toBe('error')

    c.cancel()
    await expect(signing).rejects.toMatchObject({ code: 'user-cancelled' })
    expect(c.state.phase).toBe('idle')
    expect(relocks).toEqual(['manual'])

    await expect(signer.sign(digest(7))).rejects.toMatchObject({ code: 'key-removed-mid-op' })
  })
})

// The ceremonyHost singleton is ONE CeremonyController for the whole process
// lifetime — every fixture above builds a fresh controller per test, which
// cannot see anything that only becomes reachable on a SECOND ceremony
// against the same controller. These tests deliberately reuse one `c` across
// two (or more) full arm→sign→release cycles, the way production actually
// runs.
describe('CeremonyController: one singleton, sequential ceremonies', () => {
  test("a signer released normally clears activeSigner, so a SECOND ceremony's error path still stops the session", async () => {
    const { ceremony: c, mock: nfc } = await makeCeremony({ sessionBased: true })

    // Ceremony 1: arm normally and release, exactly as a caller finishing a
    // withdrawal would in its own finally.
    const p1 = c.requestSigner('withdraw 1')
    nfc.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    const signer1 = await p1
    expect(c.state.phase).toBe('armed')
    signer1.release()
    expect(c.state.phase).toBe('idle')

    // Ceremony 2: force a serial-mismatch by presenting a different key.
    const stopSpy = jest.spyOn(nfc, 'stop')
    const p2 = c.requestSigner('withdraw 2')
    nfc.insertKey('WRONG-SERIAL')
    c.submitPin('123456')
    await expect(p2).rejects.toMatchObject({ code: 'serial-mismatch' })

    // The bug this guards against: if release() never cleared activeSigner,
    // run()'s finally guard `if (!this.activeSigner)` would see the STALE
    // signer from ceremony 1 and skip closing ceremony 2's dead session
    // entirely — leaving the system NFC sheet open on exactly the error path
    // that guard exists to handle.
    expect(stopSpy).toHaveBeenCalledTimes(1)

    // And the controller is left clean enough for a third ceremony to arm.
    const p3 = c.requestSigner('withdraw 3')
    nfc.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    const signer3 = await p3
    expect(c.state.phase).toBe('armed')
    signer3.release()
  })

  test("a late release() from a stale signer must not steal a successor's PENDING attach-wait", async () => {
    const { ceremony: c, mock: nfc } = await makeCeremony({ sessionBased: true })

    // Ceremony A arms normally.
    const p1 = c.requestSigner('withdraw A')
    nfc.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    const signerA = await p1
    expect(c.state.phase).toBe('armed')

    // Ceremony B starts — a SECOND, independent ceremony — before A's caller
    // has released: the realistic "slow finalize/broadcast" case the module
    // doc describes. The mock's start() would normally re-detect the
    // still-"present" key SYNCHRONOUSLY (see MockYubiKey.start), which
    // resolves B's own attach-wait before this test ever gets a chance to
    // interleave anything — exactly why the PREVIOUS version of this test
    // could never actually land A's release() while B was inside
    // `await waiter.promise`, and so never exercised the real bug (it passed
    // whether or not the per-attempt KeyEventSession box existed). Stubbing
    // start() removes that synchronous shortcut and opens the genuine
    // window: B is now parked awaiting a fresh attach event, same as a real
    // NFC tap that has not landed yet.
    const startSpy = jest.spyOn(nfc, 'start').mockImplementation(() => {})
    const p2 = c.requestSigner('withdraw B')
    c.submitPin('123456')
    await flush()
    expect(c.state.phase).toBe('waiting-for-key') // B is genuinely pending, not yet armed

    // *** A's caller finally releases here — squarely inside B's pending
    // attach-wait. This is exactly the scenario the KeyEventSession box (a
    // per-attempt subscription, not one shared controller-wide field) exists
    // to protect: with a single shared field, A's release() unsubscribing it
    // would remove the listener B just registered for its own arm, and B's
    // `await waiter.promise` below would then hang forever — the physical
    // tap fired below would have no listener left to reach. ***
    signerA.release()

    // The physical tap for B lands.
    startSpy.mockRestore()
    nfc.insertKey(DEFAULT_SERIAL)
    const signerB = await p2
    expect(signerB).not.toBe(signerA) // a genuinely new session, not shared
    expect(c.state.phase).toBe('armed')

    signerB.release()
  })
})

describe('CeremonyController: retention timeout robustness', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  test('the retention window elapsing during a mid-signature retry wait relocks rather than staying armed forever', async () => {
    jest.useFakeTimers()
    const { ceremony: c, mock } = await makeCeremony({ retentionMs: 1000 })
    const relocks: string[] = []
    c.onRelock = why => relocks.push(why)
    const p = c.requestSigner('x')
    mock.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    const signer = await p
    expect(c.state.phase).toBe('armed')

    mock.setTouchBehavior('timeout')
    const signing = signer.sign(digest(1))
    // The real assertion is the `await expect(signing).rejects...` below, but
    // that rejection actually happens asynchronously inside the
    // advanceTimersByTimeAsync call further down — attach a no-op handler
    // now so Node never sees an unhandled rejection in the gap between then
    // and when this test gets around to awaiting it.
    signing.catch(() => {})
    // Let the touch-timeout rejection land us in the retry wait — phase is
    // 'error', not 'armed', for the whole rest of this test.
    await jest.advanceTimersByTimeAsync(0)
    expect(c.state.phase).toBe('error')

    // Nobody ever calls retry() — simulating a user who wandered off
    // mid-hiccup. Advance past the full retention window plus the grace
    // recheck the busy-path fallback schedules.
    await jest.advanceTimersByTimeAsync(1000 + 5_000 + 10)

    // The bug this guards against: the ORIGINAL one-shot timer's callback was
    // guarded by `phase === 'armed'`, which is false here (phase is 'error');
    // without a reschedule, the callback would return and NOTHING would ever
    // check again — an armed session that never auto-relocks.
    expect(c.state.phase).toBe('idle')
    expect(relocks).toEqual(['timeout'])
    await expect(signing).rejects.toMatchObject({ code: 'key-removed-mid-op' })

    // The session is closed for good.
    await expect(signer.sign(digest(2))).rejects.toMatchObject({ code: 'key-removed-mid-op' })
  })

  test('a successful signature refreshes the retention window instead of letting the original deadline expire underneath it', async () => {
    jest.useFakeTimers()
    const { ceremony: c, mock } = await makeCeremony({ retentionMs: 1000 })
    const relocks: string[] = []
    c.onRelock = why => relocks.push(why)
    const p = c.requestSigner('x')
    mock.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    const signer = await p

    // Sign well before the window elapses...
    await jest.advanceTimersByTimeAsync(600)
    await signer.sign(digest(1))
    expect(c.state.phase).toBe('armed')

    // ...then advance PAST the original window's nominal deadline (600 + 500
    // = 1100 > 1000) without ever going idle, proving the signature refreshed
    // armedUntil and rescheduled the timer rather than leaving the original
    // one-shot deadline to fire underneath the still-active session.
    await jest.advanceTimersByTimeAsync(500)
    expect(c.state.phase).toBe('armed')
    expect(relocks).toEqual([])

    signer.release()
  })
})

describe('CeremonyController: signing error handling', () => {
  test('a non-retryable signEcdsa error surfaces phase: error with the code, instead of leaving awaiting-touch stuck', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const p = c.requestSigner('x')
    mock.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    const signer = await p

    // pin-locked is a real driver failure, not one of the RETRYABLE_TAP_ERRORS
    // (touch-timeout / nfc-lost / key-removed-mid-op) — it must not be
    // retried in place.
    jest.spyOn(mock, 'signEcdsa').mockRejectedValueOnce(new VaultError('pin-locked', 'PIN is blocked'))

    await expect(signer.sign(digest(1))).rejects.toMatchObject({ code: 'pin-locked' })
    // The bug: relocating signing out of run() dropped the conversion run()'s
    // own catch used to do (throw → phase: 'error' with the code). Without
    // it, a hard failure left the sheet stuck showing "awaiting touch" with
    // no error and no way forward.
    expect(c.state.phase).toBe('error')
    expect(c.state.error?.code).toBe('pin-locked')

    signer.release()
  })

  test('concurrent sign() calls on one signer reject instead of clobbering the shared retry state', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const p = c.requestSigner('x')
    mock.insertKey(DEFAULT_SERIAL)
    c.submitPin('123456')
    const signer = await p

    mock.setTouchBehavior('timeout')
    const first = signer.sign(digest(1)) // parks in the retry wait
    await flush()
    expect(c.state.phase).toBe('error')

    // A second, overlapping sign() call must fail fast, not hang forever
    // waiting on a retryWaiter the first call already owns (retryWaiter is a
    // controller field, not per-call, so a second retryable error here would
    // silently clobber the first call's deferred).
    await expect(signer.sign(digest(2))).rejects.toMatchObject({ code: 'template-invalid' })

    mock.setTouchBehavior('instant')
    c.retry()
    const sig = await first
    expect(sig.length).toBeGreaterThan(0)
    signer.release()
  })
})
