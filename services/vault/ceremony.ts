/**
 * Ceremony controller — UI-free state machine for the insert → PIN → tap flow
 * that unwraps the vault key. Consumed by a React context that renders the
 * ceremony sheet; kept free of React and native imports so it is fully
 * unit-testable against the mock driver.
 *
 * What a ceremony PRODUCES: the YubiKey is an unwrap oracle, not a signer. One
 * tap performs exactly ONE on-token ECDH (PIV KeyAgreement) against the seal's
 * ephemeral public key; that shared secret opens the sealed 64-byte vault seed,
 * which becomes an HD node and is then zeroized. The ceremony's product is that
 * node — a VaultKeyHandle — from which the spend path derives every K1 child it
 * needs, in software, with no further card contact. There is no per-digest
 * round trip and no signing on the card at all.
 *
 * Concurrency: one ceremony ARMING at a time — `requestKey()` calls that
 * overlap a single in-flight arm attempt (e.g. a deposit and its re-vault, or
 * two callers racing while `running` is true) share that one attempt and all
 * resolve to the SAME VaultKeyHandle; release() on it is idempotent by
 * construction, so whichever caller releases last simply no-ops. That guarantee
 * does NOT extend across separate ceremonies: once an attempt finishes arming,
 * `running` goes back to false, and the NEXT requestKey() call starts an
 * entirely new ceremony with its own handle — even if the previous one has not
 * been released yet. Two live, independently-armed handles can therefore
 * coexist for a stretch (see ceremony.test.ts's "late release() from a stale
 * handle" case); what is guaranteed is that a handle released late can only
 * affect its OWN subscription, never a successor's — see makeHandle's
 * `release()` doc for the one exception (the shared native transport).
 *
 * Session lifetime: arming means "the key is unwrapped and held", not "the
 * operation is done." A session-based transport's driver.stop() (which
 * dismisses the iOS NFC sheet) is therefore NOT called when the ceremony
 * completes; it moves to VaultKeyHandle.release(), so the session's lifetime
 * still brackets the caller's whole operation. The one exception is the error
 * path: if arming itself fails, no handle exists to own the session, so run()'s
 * finally closes it there.
 *
 * The retention window is now a ZEROIZATION BOUNDARY, not a convenience timer.
 * While a handle is armed, the vault key is live in JS memory; release() (or
 * the retention timeout, or a detach) drops the reference so the runtime can
 * collect it.
 *
 * Two caveats on that word "boundary", both deliberate and both bounded:
 *   - The window is refreshable. A post-arm progress note restarts it (see
 *     noteProgress), so an operation that legitimately outruns one window is
 *     not cut off mid-flight. It is NOT an open-ended lease: ARM_MAX_MULTIPLE
 *     caps a session's total life at 3× the window measured from `armedAt`,
 *     after which the relock fires however fresh the progress is. The
 *     boundary is therefore "at most 3× retention", not "exactly retention".
 *   - What gets dropped is a REFERENCE, not the bytes. The seed IS wiped
 *     (fill(0)) the moment the HD node is built, but the node itself cannot
 *     be zeroized — @bsv/sdk's HD holds the key as BigNumber/array internals
 *     with no wipe API, and Hermes may have copied them anyway. Dropping the
 *     reference is the best the runtime allows; this is the accepted residual
 *     risk the K1-only design documents. And the ceremony can only drop its
 *     OWN reference — see VaultKeyHandle on why callers must not keep one.
 *
 * SECURITY: the PIN lives in the arm flow's closure until release(), and the
 * unwrapped key lives in the handle for the same span. Never log the PIN, the
 * ECDH secret, the seed, the HD node, or a mnemonic — and never put any of them
 * in CeremonyState, which is React-visible.
 */
import { HD } from '@bsv/sdk'
import { VaultDriver } from './driver'
import { unsealVaultKey } from './sealing'
import { SealedBlob, VaultError, VaultErrorCode } from './types'

export type CeremonyPhase =
  | 'idle'
  | 'waiting-for-key'
  | 'connecting'
  | 'pin-entry'
  | 'awaiting-touch'
  | 'preparing'
  | 'broadcasting'
  | 'armed'
  | 'error'

/**
 * Work happening AFTER the key is armed, reported by the spend path so the
 * sheet can show activity instead of a frozen screen.
 *
 * There is no per-signature variant anymore: K1 signing is software-only and
 * fast, so the seconds-long stretches worth reporting are transaction assembly
 * ('preparing') and the network round trip ('broadcasting').
 */
export type VaultProgress = { phase: 'preparing' } | { phase: 'broadcasting' }

export interface CeremonyState {
  phase: CeremonyPhase
  reason?: string
  error?: { code: VaultErrorCode; retriesLeft?: number }
  armedUntil?: number
  keySerial?: string
}

/**
 * A briefly-held, unwrapped vault key.
 *
 * `hd` is the vault's private HD node — every deposit address and every
 * spending key derives from it, in software, for free. Callers MUST call
 * release() in a finally: on session-based transports that is what dismisses
 * the system NFC sheet, and on every transport it is what drops the key.
 *
 * Reading `hd` after release (or after a timeout/detach relock) throws
 * `key-removed-mid-op` rather than handing back a key the ceremony has
 * declared dead. That check happens PER READ and nowhere else: it can refuse
 * to hand the node out again, but it cannot reach into a reference a caller
 * already took. A variable holding `handle.hd` keeps working — and keeps the
 * key alive — for as long as the caller holds it, whatever the ceremony
 * thinks.
 *
 * So: read `handle.hd` at each point of use. Passing it straight into a
 * derive/spend operation that completes inside the armed window, with
 * `release()` in a finally, is the intended shape. NEVER stash it in module
 * state, React state, a closure that outlives the operation, or any cache —
 * the ceremony has no way to revoke that, and the whole point of the
 * retention window is that the key does not outlive one operation.
 */
export interface VaultKeyHandle {
  readonly hd: HD
  /** Idempotent: safe to call more than once, and safe for concurrent callers
   * that were all handed the same handle to release independently. */
  release(): void
}

interface CeremonyMeta {
  slot: number
  yubiSerial: string
}

interface CeremonyStoreView {
  getMeta(): Promise<CeremonyMeta | null>
  getSeal(): Promise<SealedBlob | null>
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}

function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * A single arm attempt's driver-event subscription, boxed so each attempt
 * owns its OWN unsubscribe token instead of sharing one controller-wide
 * field. This is load-bearing, not tidiness: with a single shared field, a
 * handle released late (after a successor ceremony has already resubscribed
 * for its own arm) would unsubscribe the SUCCESSOR's listener and stop the
 * SUCCESSOR's session — the successor's own openTapSession would then await
 * an attachWaiter nothing can ever resolve. A per-attempt box makes a stale
 * release() structurally unable to touch a later attempt's subscription.
 */
interface KeyEventSession {
  off?: () => void
}

export class CeremonyController {
  state: CeremonyState = { phase: 'idle' }

  onRelock?: (why: 'timeout' | 'detached' | 'manual') => void
  onArmed?: (handle: VaultKeyHandle) => void

  private subscribers = new Set<(s: CeremonyState) => void>()
  private waiters: ((h: VaultKeyHandle) => void)[] = []
  private rejecters: ((e: unknown) => void)[] = []
  private running = false
  private reason = ''

  /** Monotonic id of the newest arm attempt. `running` alone cannot tell an
   * attempt that it has been replaced: cancel() sets running=false while the
   * cancelled attempt is still parked inside an await (a tap can still land
   * seconds later), and the requestKey() that follows starts a fresh attempt
   * AND resets `cancelled`. Every run() captures its own generation and
   * re-checks it before touching any shared state, so a late-returning attempt
   * can only ever clean itself up. */
  private generation = 0

  /** The handle for the currently-armed session, if any. Set once arming
   * succeeds. Cleared by VaultKeyHandle.release() itself (identity-checked
   * against this field — see makeHandle) rather than by whoever calls
   * release(), so this is accurate whether release() was invoked by the caller
   * finishing normally, or by cancel()/notifyKeyDetached()/the retention timer
   * relocking it. Its presence — not `state.phase` — is what the relock paths
   * key off of, because a handle can be "active" while the visible phase is
   * 'preparing' or 'broadcasting', not just 'armed'. */
  private activeHandle?: VaultKeyHandle

  private pinWaiter?: Deferred<string>
  private queuedPin?: string
  private retryWaiter?: Deferred<void>
  private attachWaiter?: Deferred<void>
  private cancelled = false
  private armTimer?: ReturnType<typeof setTimeout>
  /** When the current session armed. The anchor for the absolute ceiling — see
   * ARM_MAX_MULTIPLE — so a stream of progress notes cannot renew the retention
   * window forever. */
  private armedAt = 0

  /** Grace period given to an operation that is still reporting progress when
   * the retention window elapses, before the timeout is enforced regardless of
   * phase. See checkArmTimeout. */
  private static readonly ARM_GRACE_MS = 5_000

  /** Hard ceiling on a session's life, as a multiple of the retention window.
   * A progress note refreshes the window (see noteProgress), which on its own
   * would make the retention period a lease the caller can renew indefinitely —
   * i.e. no zeroization boundary at all. Past `armedAt + this × retentionMs` the
   * relock fires no matter how fresh the progress is, and the grace window is
   * clamped to it too, so the key's maximum lifetime is bounded by construction
   * rather than by caller good behaviour. */
  private static readonly ARM_MAX_MULTIPLE = 3

  constructor(
    private deps: {
      getDriver: () => VaultDriver | null
      store: CeremonyStoreView
      retentionMs: number
    }
  ) {}

  subscribe(cb: (s: CeremonyState) => void): () => void {
    this.subscribers.add(cb)
    cb(this.state)
    return () => this.subscribers.delete(cb)
  }

  /** Ask for the unwrapped vault key. Concurrent calls share one ceremony and
   * all receive the SAME handle, so release() is idempotent by construction. */
  requestKey(reason: string): Promise<VaultKeyHandle> {
    return new Promise<VaultKeyHandle>((resolve, reject) => {
      this.waiters.push(resolve)
      this.rejecters.push(reject)
      if (this.running) return // join the in-flight ceremony
      this.reason = reason
      this.cancelled = false
      this.running = true
      void this.run()
    })
  }

  /**
   * Report post-arm progress from the spend path.
   *
   * Guarded on an armed session: the K1 recovery sweep runs the same spend code
   * from a mnemonic-derived HD node with no ceremony at all, and must not raise
   * a YubiKey sheet. Also ignores anything arriving mid-arm, where the arming
   * phases own the display.
   *
   * A progress note also REFRESHES the retention window. Nothing else can:
   * the single ECDH is spent at arm time, so without this an operation that
   * legitimately outlives the window (a slow broadcast) would have the key
   * pulled out from under it mid-flight. This is the direct successor of the
   * old design's "every signature re-arms" refresh.
   *
   * The refresh is bounded twice over, so it cannot become an unbounded lease
   * a caller renews at will: progress must keep arriving (or checkArmTimeout's
   * grace path relocks), AND no refresh may push the relock past
   * `armedAt + ARM_MAX_MULTIPLE × retentionMs` — see startArmTimer.
   */
  noteProgress(p: VaultProgress): void {
    if (!this.activeHandle || this.running) return
    this.set({ phase: p.phase, armedUntil: this.startArmTimer(), error: undefined })
  }

  submitPin(pin: string): void {
    if (this.pinWaiter) {
      const w = this.pinWaiter
      this.pinWaiter = undefined
      w.resolve(pin)
    } else {
      this.queuedPin = pin
    }
  }

  retry(): void {
    this.retryWaiter?.resolve()
    this.retryWaiter = undefined
  }

  /** Give up. Aborts an in-flight arm attempt (rejecting every waiter with
   * user-cancelled), and — separately — releases an already-armed session,
   * since cancelling out of a mid-withdrawal prompt must not leave a key live
   * in memory behind a session the UI just dismissed. release() itself does the
   * activeHandle/timer/phase cleanup (identity checked), so this only needs to
   * trigger it. */
  cancel(): void {
    this.cancelled = true
    const err = new VaultError('user-cancelled')
    this.pinWaiter?.reject(err)
    this.retryWaiter?.reject(err)
    this.attachWaiter?.reject(err)
    if (this.running) {
      this.failAll(err)
      this.running = false
      this.set({ phase: 'idle' })
    }
    if (this.activeHandle) {
      this.activeHandle.release()
      this.onRelock?.('manual')
    }
  }

  /** A key detached. Aborts an in-flight arm attempt; releases an armed
   * session, since the hardware that authorized holding this key is gone.
   * release() itself does the activeHandle/timer/phase cleanup. */
  notifyKeyDetached(): void {
    if (this.activeHandle) {
      const err = new VaultError('key-removed-mid-op')
      this.retryWaiter?.reject(err)
      this.attachWaiter?.reject(err)
      this.activeHandle.release()
      this.onRelock?.('detached')
      return
    }
    if (this.running) {
      const err = new VaultError('key-removed-mid-op')
      this.pinWaiter?.reject(err)
      this.retryWaiter?.reject(err)
      this.attachWaiter?.reject(err)
    }
  }

  /** A key attached — resolves a waiting waiting-for-key phase. */
  notifyKeyAttached(): void {
    this.attachWaiter?.resolve()
    this.attachWaiter = undefined
  }

  /**
   * Why this outlives `run()` for a session-based transport: WalletContext's
   * own persistent-reader listener explicitly skips `sessionBased` drivers
   * (it exists only to relock Android USB on unplug), so a session's OWN
   * subscription (in its own KeyEventSession box) is the only thing that can
   * ever learn a tap-session detached while a handle is armed. A persistent
   * reader has that separate always-on listener, so its ceremony-owned
   * subscription is dropped right after arming.
   */
  private subscribeKeyEvents(driver: VaultDriver, session: KeyEventSession): void {
    session.off?.()
    session.off = driver.onKeyEvent(e => {
      if (e.type === 'attached') this.notifyKeyAttached()
      else this.notifyKeyDetached()
    })
  }

  private unsubscribeKeyEvents(session: KeyEventSession): void {
    session.off?.()
    session.off = undefined
  }

  private async run(): Promise<void> {
    // This attempt's identity for the rest of its life — see `generation`.
    const gen = ++this.generation
    const driver = this.deps.getDriver()
    if (!driver) {
      this.failAll(new VaultError('driver-unavailable'))
      this.running = false
      return
    }
    // This attempt's own driver-event subscription box: a key connecting (an
    // NFC tap / a USB plug) resolves waiting-for-key; a key dropping mid-flow
    // aborts. Self-contained so it works whether or not WalletContext also
    // watches for persistent relock. Boxed per-attempt — see KeyEventSession.
    const session: KeyEventSession = {}
    this.subscribeKeyEvents(driver, session)
    // Attempt-local: whether THIS run() reached a successful arm. Deliberately
    // NOT this.activeHandle, which is controller-wide — see the finally guard
    // below for why that distinction is load-bearing.
    let armed = false
    // Set when this attempt discovers it has been superseded: it has already
    // torn its own session down, so the finally must not do it twice.
    let superseded = false
    try {
      // Both halves of an enrollment, read before any hardware prompt: a
      // half-enrolled install (meta but no seal, or the reverse) has nothing
      // a tap could unwrap, so it must fail before the sheet ever opens.
      // Mirrors vaultStore.isEnrolled(), which also requires both.
      const [meta, seal] = await Promise.all([this.deps.store.getMeta(), this.deps.store.getSeal()])
      if (!meta || !seal) throw new VaultError('not-enrolled')

      // NFC (session-based) collects the PIN BEFORE the tap and verifies it in
      // that one tap (the scan sheet covers the app, so no PIN entry mid-tap).
      // A persistent USB reader can interleave PIN entry and the serial/PIN
      // checks.
      const handle = driver.sessionBased
        ? await this.armViaTap(driver, meta, seal, session, gen)
        : await this.armViaReader(driver, meta, seal, session, gen)
      this.throwIfCancelled()

      // Have we been superseded while parked on the tap? `cancelled` cannot
      // answer this: cancel() sets it, but the very next requestKey() resets it
      // to false for the NEW attempt, so by the time a cancelled-then-replaced
      // attempt's ECDH lands, the flag reads clean again. Only the generation
      // does. Without this check that attempt would install ITS handle as
      // activeHandle over the successor's, arm a second timer, and hand its own
      // key to whoever is waiting on the successor — two unwrapped keys live,
      // one of them owned by nobody.
      if (gen !== this.generation) {
        superseded = true
        // Drop THIS attempt's listener box first (release() only unsubscribes
        // on a session-based transport, and the post-arm unsubscribe below is
        // never reached from here — without this a cancelled-and-replaced
        // attempt would leave a live listener behind on every persistent-reader
        // ceremony), then drop its key and close its session. The identity
        // check inside release() means none of the controller's shared state
        // (the successor's activeHandle, timer or phase) is touched.
        this.unsubscribeKeyEvents(session)
        handle.release()
        return
      }

      this.activeHandle = handle
      armed = true
      this.arm()
      this.resolveAll(handle)
      this.onArmed?.(handle)

      // Persistent readers hand relock-on-unplug to WalletContext's
      // longer-lived listener — drop ours now. Session-based transports keep
      // listening: see subscribeKeyEvents' doc above.
      if (!driver.sessionBased) this.unsubscribeKeyEvents(session)
    } catch (e) {
      // Anything that is not a VaultError gets relabelled 'driver-unavailable',
      // which renders as "YubiKey support is unavailable on this device" — so
      // the original message is carried across as the detail rather than being
      // dropped, otherwise an unrelated failure is indistinguishable from a
      // genuinely absent driver.
      const err = e instanceof VaultError ? e : new VaultError('driver-unavailable', String(e))
      // Same generation guard as the success path, for the same reason: a
      // superseded attempt's failure is not the CURRENT attempt's failure, and
      // must not reject the successor's waiters or paint its phase. Its own
      // waiters were already failed by the cancel() that superseded it, so
      // there is nobody left to tell. The finally still closes its session.
      if (gen !== this.generation) return
      if (err.code === 'user-cancelled') {
        this.set({ phase: 'idle' })
      } else {
        this.set({ phase: 'error', error: { code: err.code, retriesLeft: err.retriesLeft } })
      }
      this.failAll(err)
    } finally {
      // Only the CURRENT attempt owns `running`. A superseded attempt clearing
      // it would declare the successor's still-in-flight ceremony finished, so
      // the next requestKey() would start a third attempt alongside it instead
      // of joining the second.
      if (gen === this.generation) this.running = false
      // `armed` (this attempt's own outcome), NOT this.activeHandle (whoever
      // the CONTROLLER currently considers active): an unreleased predecessor
      // ceremony leaves this.activeHandle truthy for the whole time this
      // attempt runs, which would otherwise make a FAILED successor's finally
      // wrongly conclude "some handle must already own this session/
      // subscription" and skip closing its own — the predecessor's activeHandle
      // has nothing to do with whether this attempt itself succeeded.
      if (!armed && !superseded) {
        // Arming never completed: no handle exists to own the subscription
        // or the session, so close both now — nothing else ever will.
        // (A superseded attempt DID build a handle and released it above,
        // which already did exactly this teardown — don't repeat it.)
        // Unsubscribe BEFORE any stop so a session-end detach echo cannot
        // relock a session that was already dead.
        this.unsubscribeKeyEvents(session)
        if (driver.sessionBased) {
          try {
            driver.stop()
          } catch {
            /* stop is best-effort */
          }
        }
      }
    }
  }

  private async safeKeyInfo(driver: VaultDriver) {
    try {
      return await driver.getKeyInfo()
    } catch {
      return null
    }
  }

  /** Persistent reader (Android USB): key present, PIN entry and token ops
   * interleave, so a wrong PIN is retried in place. */
  private async armViaReader(
    driver: VaultDriver,
    meta: CeremonyMeta,
    seal: SealedBlob,
    session: KeyEventSession,
    gen: number
  ): Promise<VaultKeyHandle> {
    this.throwIfStale(gen)
    this.set({ phase: 'connecting' })
    let info = await this.safeKeyInfo(driver)
    if (!info) {
      this.set({ phase: 'waiting-for-key' })
      const waiter = (this.attachWaiter = defer<void>())
      driver.start()
      await waiter.promise
      this.throwIfStale(gen)
      this.set({ phase: 'connecting' })
      info = await this.safeKeyInfo(driver)
    }
    if (!info) throw new VaultError('no-key')
    if (info.serial !== meta.yubiSerial) {
      throw new VaultError('serial-mismatch', `Expected key ${meta.yubiSerial}`)
    }
    const pin = await this.collectPin(driver, gen)
    return this.makeHandle(driver, meta, seal, pin, session, gen)
  }

  /** Errors from a single tap/touch attempt that are worth retrying without
   * throwing away the whole ceremony: a missed/short touch, or the field
   * dropping mid-command (phone shifted, key lifted a hair early). On a
   * session-based transport both leave the dead NFC session behind, so a
   * retry must close it and open a fresh one — see the reopen in
   * unwrapVaultKey. */
  private static readonly RETRYABLE_TAP_ERRORS = new Set(['touch-timeout', 'nfc-lost', 'key-removed-mid-op'])

  /** NFC tap (iOS): PIN first in-app (the scan sheet is modal), then one tap
   * connects, checks the serial, verifies the PIN, and performs the unwrap. A
   * wrong PIN aborts the ceremony — we cannot re-prompt beneath an open system
   * NFC sheet. */
  private async armViaTap(
    driver: VaultDriver,
    meta: CeremonyMeta,
    seal: SealedBlob,
    session: KeyEventSession,
    gen: number
  ): Promise<VaultKeyHandle> {
    const pin = await this.collectPinValue(gen)
    await this.openTapSession(driver, meta, pin, session, gen)
    return this.makeHandle(driver, meta, seal, pin, session, gen)
  }

  /** Open (or reopen) an NFC session and get as far as a verified PIN. Used
   * both for the initial arm and — on a session-based transport — to
   * re-establish a fresh session after a dropped tap mid-unwrap. The serial
   * check lives here as well as in armViaReader deliberately: EVERY session,
   * including a reopened one, re-checks it, so a different card presented on
   * the retry tap is never asked to unwrap this vault's seal.
   * (Re)subscribes `session` every time: the very first call replaces run()'s
   * top-level subscription on the SAME box (harmless — nothing was pending on
   * it yet), and every reopen needs a fresh one since the caller unsubscribed
   * this same box around its matching driver.stop(). */
  private async openTapSession(
    driver: VaultDriver,
    meta: CeremonyMeta,
    pin: string,
    session: KeyEventSession,
    gen: number
  ): Promise<void> {
    this.throwIfStale(gen)
    this.subscribeKeyEvents(driver, session)
    this.set({ phase: 'waiting-for-key' })
    const waiter = (this.attachWaiter = defer<void>())
    driver.start()
    await waiter.promise
    this.throwIfStale(gen)
    this.set({ phase: 'connecting' })
    const info = await driver.getKeyInfo()
    // getKeyInfo is a native call cancel() cannot interrupt.
    this.throwIfStale(gen)
    if (info.serial !== meta.yubiSerial) {
      throw new VaultError('serial-mismatch', `Expected key ${meta.yubiSerial}`)
    }
    const res = await driver.verifyPin(pin)
    this.throwIfStale(gen)
    if (!res.ok) throw new VaultError('pin-invalid', 'Wrong PIN', res.retriesLeft)
  }

  /** Collect a PIN value from the UI only (no token verify) — used by the NFC
   * path, which must gather the PIN before the tap. */
  private async collectPinValue(gen: number): Promise<string> {
    this.throwIfStale(gen)
    this.set({ phase: 'pin-entry' })
    if (this.queuedPin !== undefined) {
      const p = this.queuedPin
      this.queuedPin = undefined
      return p
    }
    this.pinWaiter = defer<string>()
    return this.pinWaiter.promise
  }

  private async collectPin(driver: VaultDriver, gen: number): Promise<string> {
    for (;;) {
      this.throwIfStale(gen)
      this.set({ phase: 'pin-entry', error: this.state.error })
      let pin: string
      if (this.queuedPin !== undefined) {
        pin = this.queuedPin
        this.queuedPin = undefined
      } else {
        this.pinWaiter = defer<string>()
        pin = await this.pinWaiter.promise
      }
      const res = await driver.verifyPin(pin)
      // verifyPin is a native call cancel() cannot interrupt: without this, an
      // attempt superseded while parked in it would resume and repaint the
      // SUCCESSOR's phase back to 'pin-entry' over its armed session, then walk
      // on to spend a second, unwanted touch on the card.
      this.throwIfStale(gen)
      if (res.ok) {
        this.set({ phase: 'pin-entry', error: undefined })
        return pin
      }
      this.set({ phase: 'pin-entry', error: { code: 'pin-invalid', retriesLeft: res.retriesLeft } })
    }
  }

  /**
   * The one touch-gated operation in the whole flow: on-token ECDH against the
   * seal's ephemeral public key, retried in place on a dropped tap.
   *
   * The PIN is already known good by the time we get here — only the physical
   * touch can fail — so a hiccup does not throw away the collected PIN or (on
   * a persistent reader) the connection. On a session-based transport the retry
   * closes the dead session and opens a fresh one, RE-CHECKING THE SERIAL and
   * re-verifying the PIN, before retrying the ECDH.
   *
   * Only the ECDH is inside the retry loop. The unseal that follows is pure
   * software: `seal-corrupt` means the wrong card, a rewritten slot, or a
   * tampered blob — never something another tap could fix — so it must not be
   * mistaken for a retryable tap error.
   *
   * `secret` is a hex STRING (the driver's JSON-bridge shape) and so cannot be
   * wiped — same residual as the PIN. It is confined to this function's frame
   * and never stored, returned, or logged; the seed it opens IS wiped.
   */
  private async unwrapVaultKey(
    driver: VaultDriver,
    meta: CeremonyMeta,
    seal: SealedBlob,
    pin: string,
    session: KeyEventSession,
    gen: number
  ): Promise<HD> {
    let secret: string
    for (;;) {
      // Redundant by construction today — every path into this loop (first
      // entry via collectPin/openTapSession, re-entry via the retry branch
      // below) has already checked. Kept anyway, and deliberately not
      // load-bearing: this loop's body spends a TOUCH on the card, so it
      // guards itself rather than trusting each caller to have done it. No
      // test can distinguish it; nothing reaches here stale.
      this.throwIfStale(gen)
      this.set({ phase: 'awaiting-touch' })
      try {
        secret = (await driver.ecdh(meta.slot, pin, seal.ePub)).secret
        break
      } catch (e) {
        const err = e instanceof VaultError ? e : new VaultError('nfc-lost')
        if (!CeremonyController.RETRYABLE_TAP_ERRORS.has(err.code)) {
          // A hard failure (pin-locked, an unexpected native error) is not
          // retryable — rethrow and let run()'s catch surface it as a real
          // error rather than leaving the machine stuck showing "awaiting
          // touch" forever.
          throw err
        }
        // driver.ecdh is the one park point cancel() cannot interrupt, so a
        // superseded attempt lands HERE with `cancelled` already reset to false
        // by the requestKey() that replaced it. Both statements below are
        // shared state: `set` would flip the SUCCESSOR's visible phase to
        // 'error' while its handle is legitimately armed — inviting a cancel()
        // that releases the successor's live vault key mid-operation — and
        // `retryWaiter` would hand the successor's retry()/cancel() a deferred
        // belonging to a dead ceremony. Bail before either.
        this.throwIfStale(gen)
        this.set({ phase: 'error', error: { code: err.code } })
        this.retryWaiter = defer<void>()
        await this.retryWaiter.promise // resolves on retry(); rejects on cancel/detach
        this.throwIfStale(gen)
        if (driver.sessionBased) {
          // Unsubscribe BEFORE our own stop() so its session-end detach echo
          // cannot be mistaken for a real one and abort the ceremony we are
          // about to legitimately continue. openTapSession resubscribes this
          // SAME box fresh for the reopened session.
          this.unsubscribeKeyEvents(session)
          try {
            driver.stop()
          } catch {
            /* best-effort */
          }
          await this.openTapSession(driver, meta, pin, session, gen)
        }
        // loop: retry the same ECDH
      }
    }
    // Software from here on. The seed is the one secret that CAN be wiped, so
    // it is wiped the instant the HD node exists — on the throwing path too.
    const seed = unsealVaultKey(seal, secret)
    try {
      return HD.fromSeed(seed)
    } finally {
      seed.fill(0)
    }
  }

  /**
   * Unwrap the vault key and wrap it in the armed handle.
   *
   * `hd` is read through a getter that refuses once released: whichever path
   * ends the session (the caller finishing normally, or the controller's own
   * cancel/detach/timeout relock) makes every later READ throw
   * `key-removed-mid-op` instead of handing back a key the ceremony considers
   * dead. It is only a read barrier — a reference the caller already took is
   * beyond its reach, which is why VaultKeyHandle's docblock tells callers to
   * read `hd` at each point of use and never to store it.
   *
   * `release()` drops the only reference this module keeps to the node, so the
   * runtime can collect it. It CANNOT zeroize it: @bsv/sdk's HD exposes no wipe
   * API and Hermes may have copied the internals anyway (the K1-only design's
   * accepted residual risk #1). The 64-byte seed the node came from is wiped in
   * unwrapVaultKey; the node itself is only dereferenced.
   *
   * release() is identity-checked against the controller's `activeHandle`:
   * whichever call reaches it first does the real cleanup — the transport
   * session AND, only if this is still the current handle, the shared arm
   * timer, activeHandle, and phase. That makes a handle released late (after a
   * successor has already armed) a no-op against the CONTROLLER's own state and
   * against the SUBSCRIPTION (each attempt owns its own KeyEventSession box, so
   * unsubscribing here can never touch a successor's listener — see
   * KeyEventSession).
   *
   * That scoping does NOT extend to the native transport itself:
   * `driver.stop()` (via the real adapter, `driver.ts`'s `adaptNative.stop`)
   * calls `native.stopDiscovery()` + `native.clearKeyListener()`, which are
   * process-wide — there is exactly one NFC/USB discovery session at the
   * native layer, not one per KeyEventSession box. A late release() on a
   * session-based transport therefore CAN silence a successor's still-open
   * native session even though it cannot touch the successor's JS-level
   * subscription or controller state. In practice this window is narrow (the
   * successor's own subsequent driver.start() reopens discovery), but it is
   * a real gap, not a theoretical one — do not read the subscription-safety
   * property above as a transport-safety one too.
   */
  private async makeHandle(
    driver: VaultDriver,
    meta: CeremonyMeta,
    seal: SealedBlob,
    pin: string,
    session: KeyEventSession,
    gen: number
  ): Promise<VaultKeyHandle> {
    let hd: HD | undefined = await this.unwrapVaultKey(driver, meta, seal, pin, session, gen)
    let released = false
    const handle: VaultKeyHandle = {
      get hd(): HD {
        if (released || !hd) {
          throw new VaultError('key-removed-mid-op', 'Vault key handle already released')
        }
        return hd
      },
      release: () => {
        if (released) return
        released = true
        // Drop the only reference this module holds, so the node becomes
        // collectable. It cannot be wiped in place — see this method's doc.
        hd = undefined
        // Session-based transports (iOS NFC) held the scan session open for the
        // caller's whole operation; this is what finally dismisses the sheet.
        // Unsubscribe first so our own stop() cannot echo back as a detach and
        // re-enter this relock path. Scoped to THIS handle's own session box —
        // see KeyEventSession — so a late release() here can never touch a
        // successor ceremony's subscription or session.
        if (driver.sessionBased) {
          this.unsubscribeKeyEvents(session)
          try {
            driver.stop()
          } catch {
            /* stop is best-effort */
          }
        }
        // Only touch controller-wide state if this is still THE active handle:
        // a stale/superseded handle's release() must not clobber a successor
        // ceremony's armed state, timer, or phase.
        if (this.activeHandle === handle) {
          this.clearArmTimer()
          this.activeHandle = undefined
          this.set({ phase: 'idle' })
        }
        // Bound the PIN's exposure now that the session is closed for good —
        // strings can't be wiped, but there is no reason to keep pinning the
        // value in the module singleton once release() has run.
        pin = ''
      }
    }
    return handle
  }

  private arm(): void {
    // Anchor the absolute ceiling BEFORE the first startArmTimer, which clamps
    // against it.
    this.armedAt = now()
    this.set({ phase: 'armed', armedUntil: this.startArmTimer(), error: undefined })
  }

  /** The instant past which this session may not live, whatever it reports.
   * See ARM_MAX_MULTIPLE. */
  private armCeiling(): number {
    return this.armedAt + CeremonyController.ARM_MAX_MULTIPLE * this.deps.retentionMs
  }

  /** (Re)start the retention countdown and report the new deadline. Shared by
   * the initial arm and every progress note that refreshes it. The deadline is
   * clamped to the absolute ceiling, so a refresh can only ever move it
   * forward WITHIN the session's maximum life, never extend that maximum. */
  private startArmTimer(): number {
    this.clearArmTimer()
    const t = now()
    const deadline = Math.min(t + this.deps.retentionMs, this.armCeiling())
    this.armTimer = setTimeout(() => this.checkArmTimeout(), Math.max(0, deadline - t))
    // Don't let a pending relock timer keep a Node/Jest event loop alive; RN
    // timers have no unref, so guard for it.
    ;(this.armTimer as { unref?: () => void }).unref?.()
    return deadline
  }

  /**
   * Fires when the retention window elapses. If nothing is in flight
   * (phase === 'armed'), relock immediately. If the spend path is mid-operation
   * the phase won't be 'armed' at this exact instant ('preparing' /
   * 'broadcasting') — rather than silently giving up forever (a one-shot timer
   * that fires once and never reschedules would leave the vault key resident in
   * memory indefinitely once the timer happens to land mid-operation), give the
   * in-flight operation one short grace window to finish. A further progress
   * note calls startArmTimer, which cancels this and starts a fresh window; if
   * the operation still hasn't reported by the grace deadline, enforce the
   * timeout regardless of phase.
   *
   * The grace is clamped to the absolute ceiling as well. Without that clamp
   * the ceiling would be trivially escapable: each note past it would schedule
   * a fresh 5 s grace, and the two would trade off forever.
   */
  private checkArmTimeout(): void {
    if (!this.activeHandle) return // already released by some other path
    if (this.state.phase !== 'armed') {
      const t = now()
      const graceEnd = Math.min(t + CeremonyController.ARM_GRACE_MS, this.armCeiling())
      if (graceEnd > t) {
        this.armTimer = setTimeout(() => this.enforceArmTimeout(), graceEnd - t)
        ;(this.armTimer as { unref?: () => void }).unref?.()
        return
      }
      // Ceiling already reached — no more grace to give.
    }
    this.enforceArmTimeout()
  }

  private enforceArmTimeout(): void {
    if (!this.activeHandle) return // already released by some other path
    const err = new VaultError('key-removed-mid-op')
    this.retryWaiter?.reject(err)
    this.attachWaiter?.reject(err)
    this.activeHandle.release()
    this.onRelock?.('timeout')
  }

  private clearArmTimer(): void {
    if (this.armTimer) {
      clearTimeout(this.armTimer)
      this.armTimer = undefined
    }
  }

  private throwIfCancelled(): void {
    if (this.cancelled) throw new VaultError('user-cancelled')
  }

  /**
   * The guard every step of an arm attempt resumes behind.
   *
   * `cancelled` alone is not enough, and this is the whole subtlety of the
   * resurrection class: cancel() sets it, but the requestKey() that follows
   * resets it to false for the NEW attempt. An attempt parked in a native call
   * that cancel() cannot interrupt — `driver.ecdh`, `driver.verifyPin`,
   * `driver.getKeyInfo` — therefore comes back to a flag that reads clean, and
   * would carry on painting phases, installing waiters, and talking to the card
   * on behalf of a ceremony that no longer exists. Only the generation can tell
   * it apart, so every resumption point in the arm flow checks BOTH.
   *
   * Throwing (rather than returning) is deliberate: it unwinds to run()'s catch,
   * which is generation-guarded and so swallows a superseded attempt's failure
   * without touching the successor's waiters or phase, while its finally still
   * closes this attempt's own session.
   */
  private throwIfStale(gen: number): void {
    if (gen !== this.generation) {
      throw new VaultError('user-cancelled', 'Superseded by a newer ceremony')
    }
    this.throwIfCancelled()
  }

  private resolveAll(handle: VaultKeyHandle): void {
    const ws = this.waiters
    this.waiters = []
    this.rejecters = []
    ws.forEach(w => w(handle))
  }

  private failAll(e: unknown): void {
    const rs = this.rejecters
    this.waiters = []
    this.rejecters = []
    rs.forEach(r => r(e))
  }

  private set(patch: Partial<CeremonyState>): void {
    this.state = { ...this.state, ...patch, reason: this.reason }
    this.subscribers.forEach(cb => cb(this.state))
  }
}

// Wall-clock "now" for the arm timer's deadlines and its absolute ceiling.
// Kept as one named helper so the module's use of Date.now stays auditable in
// a single place; here Date.now is fine (RN app + jest).
function now(): number {
  return Date.now()
}
