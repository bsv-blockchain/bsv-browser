/**
 * Ceremony controller — UI-free state machine for the insert → PIN → arm flow
 * that opens a vault signing session. Consumed by a React context that
 * renders the ceremony sheet; kept free of React and native imports so it is
 * fully unit-testable against the mock driver.
 *
 * Concurrency: one ceremony at a time. Concurrent requestSigner() calls (e.g.
 * the several inputs of one withdrawal, or two callers racing) share the same
 * in-flight ceremony and all resolve to the SAME VaultR1Signer — release() on
 * it is idempotent by construction, so whichever caller releases last simply
 * no-ops.
 *
 * Session lifetime: arming no longer means "the operation is done" — it means
 * "the signer is ready." A session-based transport's driver.stop() (which
 * dismisses the iOS NFC sheet) is therefore NOT called when the ceremony
 * completes; it moves to VaultR1Signer.release(), so the session stays open
 * across every signature a withdrawal needs. The one exception is the error
 * path: if arming itself fails, no signer exists to own the session, so
 * run()'s finally closes it there.
 *
 * SECURITY: the PIN lives in the signer's closure for the signing session's
 * lifetime — the same exposure the old sealed-key design had across a single
 * tap, now spanning every signature in the session. Never log the PIN, a
 * signature, a private key, a seed, or a mnemonic.
 */
import { Utils } from '@bsv/sdk'
import { VaultDriver } from './driver'
import { VaultError, VaultErrorCode } from './types'

export type CeremonyPhase =
  | 'idle'
  | 'waiting-for-key'
  | 'connecting'
  | 'pin-entry'
  | 'awaiting-touch'
  | 'unsealing'
  | 'armed'
  | 'error'

export interface CeremonyState {
  phase: CeremonyPhase
  reason?: string
  error?: { code: VaultErrorCode; retriesLeft?: number }
  armedUntil?: number
  keySerial?: string
}

/**
 * An armed vault signing session.
 *
 * Holds the PIN — and on a session-based transport (iOS NFC) the open scan
 * session — for its lifetime, so a multi-input withdrawal costs one arm and
 * (with TouchPolicy.CACHED) one touch. Callers MUST call release() in a
 * finally: on session-based transports that is what dismisses the system NFC
 * sheet, and on every transport it is what lets a later sign() correctly fail
 * once the session is meant to be closed.
 */
export interface VaultR1Signer {
  /** 33-byte compressed P-256 public key. */
  publicKey: number[]
  /** DER signature over an exactly-32-byte digest. Retries a dropped tap in
   * place — the PIN is already known-good, only the physical touch failed —
   * so a hiccup on input 3 of 5 does not throw away the whole withdrawal. */
  sign(digest: Uint8Array): Promise<number[]>
  /** Idempotent: safe to call more than once, and safe for concurrent callers
   * that were all handed the same signer to call independently. */
  release(): void
}

interface CeremonyMeta {
  slot: number
  yubiSerial: string
  r1PublicKey: string
}

interface CeremonyStoreView {
  isEnrolled(): Promise<boolean>
  getMeta(): Promise<CeremonyMeta | null>
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

export class CeremonyController {
  state: CeremonyState = { phase: 'idle' }

  onRelock?: (why: 'timeout' | 'detached' | 'manual') => void
  onArmed?: (signer: VaultR1Signer) => void

  private subscribers = new Set<(s: CeremonyState) => void>()
  private waiters: ((s: VaultR1Signer) => void)[] = []
  private rejecters: ((e: unknown) => void)[] = []
  private running = false
  private reason = ''

  /** The signer for the currently-armed (or actively-signing) session, if
   * any. Set once arming succeeds; cleared by whichever path releases it
   * (manual release by a caller does NOT clear this — only the controller's
   * own relock paths do, since a caller's release() has no reason to reach
   * back into controller state). Its presence — not `state.phase` — is what
   * `run()`'s finally and the relock paths key off of, because a signer can
   * be "active" while the visible phase is 'error' (a mid-signature retry
   * wait) or 'awaiting-touch', not just 'armed'. */
  private activeSigner?: VaultR1Signer

  private pinWaiter?: Deferred<string>
  private queuedPin?: string
  private retryWaiter?: Deferred<void>
  private attachWaiter?: Deferred<void>
  private cancelled = false
  private armTimer?: ReturnType<typeof setTimeout>

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

  /** Ask for an armed signing session. Concurrent calls share one ceremony
   * and all receive the SAME signer, so release() is idempotent by
   * construction. */
  requestSigner(reason: string): Promise<VaultR1Signer> {
    return new Promise<VaultR1Signer>((resolve, reject) => {
      this.waiters.push(resolve)
      this.rejecters.push(reject)
      if (this.running) return // join the in-flight ceremony
      this.reason = reason
      this.cancelled = false
      this.running = true
      void this.run()
    })
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
   * user-cancelled), and — separately — releases and relocks an
   * already-armed or mid-signature session, since cancelling out of a
   * mid-withdrawal retry prompt must not leave a signer whose session the UI
   * just dismissed. */
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
    if (this.activeSigner) {
      this.clearArmTimer()
      this.activeSigner.release()
      this.activeSigner = undefined
      this.set({ phase: 'idle' })
      this.onRelock?.('manual')
    }
  }

  /** A key detached. Aborts an in-flight arm attempt; releases and relocks a
   * signer session — whether it is sitting idle between signatures ('armed')
   * or stuck mid a dropped-touch retry wait ('error') — since the hardware
   * connection it depended on is gone either way. */
  notifyKeyDetached(): void {
    if (this.activeSigner) {
      this.clearArmTimer()
      const err = new VaultError('key-removed-mid-op')
      this.retryWaiter?.reject(err)
      this.attachWaiter?.reject(err)
      this.activeSigner.release()
      this.activeSigner = undefined
      this.set({ phase: 'idle' })
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
   * The ceremony's own driver-event subscription, alive for as long as
   * something needs it. `subscribeKeyEvents` replaces whatever was there
   * before (so it is safe to call repeatedly — e.g. once at the top of
   * `run()` and again inside `openTapSession` for every reopen);
   * `unsubscribeKeyEvents` is idempotent.
   *
   * Why this outlives `run()`: for a session-based transport (iOS NFC),
   * WalletContext's own persistent-reader listener explicitly skips
   * `sessionBased` drivers (it exists only to relock Android USB on unplug),
   * so THIS listener is the only thing that can ever learn a tap-session
   * detached — whether that happens while idle-armed between signatures, or
   * mid a dropped-touch retry wait. A persistent reader has that separate
   * always-on listener, so its ceremony-owned subscription is dropped right
   * after arming, exactly as before Task 9.
   */
  private offKeyEvents?: () => void

  private subscribeKeyEvents(driver: VaultDriver): void {
    this.offKeyEvents?.()
    this.offKeyEvents = driver.onKeyEvent(e => {
      if (e.type === 'attached') this.notifyKeyAttached()
      else this.notifyKeyDetached()
    })
  }

  private unsubscribeKeyEvents(): void {
    this.offKeyEvents?.()
    this.offKeyEvents = undefined
  }

  private async run(): Promise<void> {
    const driver = this.deps.getDriver()
    if (!driver) {
      this.failAll(new VaultError('driver-unavailable'))
      this.running = false
      return
    }
    // Own driver-event subscription for the arm attempt: a key connecting (an
    // NFC tap / a USB plug) resolves waiting-for-key; a key dropping mid-flow
    // aborts. Self-contained so it works whether or not WalletContext also
    // watches for persistent relock.
    this.subscribeKeyEvents(driver)
    try {
      const meta = await this.deps.store.getMeta()
      if (!meta) throw new VaultError('not-enrolled')

      // NFC (session-based) collects the PIN BEFORE the tap and verifies it in
      // that one tap (the scan sheet covers the app, so no PIN entry mid-tap).
      // A persistent USB reader can interleave PIN entry and the serial/PIN
      // checks.
      const signer = driver.sessionBased
        ? await this.armViaTap(driver, meta)
        : await this.armViaReader(driver, meta)
      this.throwIfCancelled()

      this.activeSigner = signer
      this.arm()
      this.resolveAll(signer)
      this.onArmed?.(signer)

      // Persistent readers hand relock-on-unplug to WalletContext's
      // longer-lived listener — drop ours now, exactly as before Task 9.
      // Session-based transports keep listening: see the field doc above.
      if (!driver.sessionBased) this.unsubscribeKeyEvents()
    } catch (e) {
      const err = e instanceof VaultError ? e : new VaultError('driver-unavailable', String(e))
      if (err.code === 'user-cancelled') {
        this.set({ phase: 'idle' })
      } else {
        this.set({ phase: 'error', error: { code: err.code, retriesLeft: err.retriesLeft } })
      }
      this.failAll(err)
    } finally {
      this.running = false
      if (!this.activeSigner) {
        // Arming never completed: no signer exists to own the subscription
        // or the session, so close both now — nothing else ever will.
        // Unsubscribe BEFORE any stop so a session-end detach echo cannot
        // relock a session that was already dead.
        this.unsubscribeKeyEvents()
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
  private async armViaReader(driver: VaultDriver, meta: CeremonyMeta): Promise<VaultR1Signer> {
    this.set({ phase: 'connecting' })
    let info = await this.safeKeyInfo(driver)
    if (!info) {
      this.set({ phase: 'waiting-for-key' })
      const waiter = (this.attachWaiter = defer<void>())
      driver.start()
      await waiter.promise
      this.throwIfCancelled()
      this.set({ phase: 'connecting' })
      info = await this.safeKeyInfo(driver)
    }
    if (!info) throw new VaultError('no-key')
    if (info.serial !== meta.yubiSerial) {
      throw new VaultError('serial-mismatch', `Expected key ${meta.yubiSerial}`)
    }
    const pin = await this.collectPin(driver)
    return this.makeSigner(driver, meta, pin)
  }

  /** Errors from a single tap/touch attempt that are worth retrying without
   * throwing away the whole session: a missed/short touch, or the field
   * dropping mid-command (phone shifted, key lifted a hair early). On a
   * session-based transport both leave the dead NFC session behind, so a
   * retry must close it and open a fresh one — see the reopen in
   * makeSigner's sign(). */
  private static readonly RETRYABLE_TAP_ERRORS = new Set(['touch-timeout', 'nfc-lost', 'key-removed-mid-op'])

  /** NFC tap (iOS): PIN first in-app (the scan sheet is modal), then one tap
   * connects, checks the serial, and verifies the PIN. The session stays open
   * for signing. A wrong PIN aborts the ceremony — we cannot re-prompt beneath
   * an open system NFC sheet. */
  private async armViaTap(driver: VaultDriver, meta: CeremonyMeta): Promise<VaultR1Signer> {
    const pin = await this.collectPinValue()
    await this.openTapSession(driver, meta, pin)
    return this.makeSigner(driver, meta, pin)
  }

  /** Open (or reopen) an NFC session and get as far as a verified PIN. Used
   * both for the initial arm and — on a session-based transport — to
   * re-establish a fresh session after a dropped tap mid-signature.
   * (Re)subscribes to key events every time: the very first call replaces
   * run()'s top-level subscription (harmless — nothing was pending on it
   * yet), and every reopen needs a fresh one since the caller unsubscribed
   * around the matching driver.stop(). */
  private async openTapSession(driver: VaultDriver, meta: CeremonyMeta, pin: string): Promise<void> {
    this.throwIfCancelled()
    this.subscribeKeyEvents(driver)
    this.set({ phase: 'waiting-for-key' })
    const waiter = (this.attachWaiter = defer<void>())
    driver.start()
    await waiter.promise
    this.throwIfCancelled()
    this.set({ phase: 'connecting' })
    const info = await driver.getKeyInfo()
    if (info.serial !== meta.yubiSerial) {
      throw new VaultError('serial-mismatch', `Expected key ${meta.yubiSerial}`)
    }
    const res = await driver.verifyPin(pin)
    if (!res.ok) throw new VaultError('pin-invalid', 'Wrong PIN', res.retriesLeft)
  }

  /** Collect a PIN value from the UI only (no token verify) — used by the NFC
   * path, which must gather the PIN before the tap. */
  private async collectPinValue(): Promise<string> {
    this.throwIfCancelled()
    this.set({ phase: 'pin-entry' })
    if (this.queuedPin !== undefined) {
      const p = this.queuedPin
      this.queuedPin = undefined
      return p
    }
    this.pinWaiter = defer<string>()
    return this.pinWaiter.promise
  }

  private async collectPin(driver: VaultDriver): Promise<string> {
    for (;;) {
      this.throwIfCancelled()
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
      if (res.ok) {
        this.set({ phase: 'pin-entry', error: undefined })
        return pin
      }
      this.set({ phase: 'pin-entry', error: { code: 'pin-invalid', retriesLeft: res.retriesLeft } })
    }
  }

  /**
   * Build the armed session.
   *
   * `sign` retries a dropped tap in place — the PIN is already known good,
   * only the physical touch failed — so a hiccup on input 3 of 5 does not
   * throw away the whole withdrawal. On a session-based transport the retry
   * closes the dead session and opens a fresh one, re-checking the serial and
   * re-verifying the PIN, before retrying that one signature.
   */
  private makeSigner(driver: VaultDriver, meta: CeremonyMeta, pin: string): VaultR1Signer {
    let released = false
    const ensureLive = () => {
      if (released) throw new VaultError('key-removed-mid-op', 'Vault session already released')
    }
    return {
      publicKey: Utils.toArray(meta.r1PublicKey, 'hex'),
      sign: async (digest: Uint8Array): Promise<number[]> => {
        ensureLive()
        // Guard before any APDU: iOS signs 32 ZERO bytes on an unrecognised
        // algorithm and Android truncates an over-long payload, so an
        // off-length digest silently signs the wrong message.
        if (digest.length !== 32) {
          throw new VaultError('template-invalid', `Digest must be 32 bytes, got ${digest.length}`)
        }
        const digestHex = Utils.toHex(Array.from(digest))
        for (;;) {
          this.throwIfCancelled()
          ensureLive()
          this.set({ phase: 'awaiting-touch' })
          try {
            const { signature } = await driver.signEcdsa(meta.slot, pin, digestHex)
            this.set({ phase: 'armed' })
            return Utils.toArray(signature, 'hex')
          } catch (e) {
            const err = e instanceof VaultError ? e : new VaultError('nfc-lost')
            if (!CeremonyController.RETRYABLE_TAP_ERRORS.has(err.code)) throw err
            this.set({ phase: 'error', error: { code: err.code } })
            this.retryWaiter = defer<void>()
            await this.retryWaiter.promise // resolves on retry(); rejects on cancel/detach
            // A relock (cancel/detach) may have released us while we waited —
            // e.g. the UI's "give up" dismissed this exact retry prompt.
            ensureLive()
            if (driver.sessionBased) {
              // Unsubscribe BEFORE our own stop() so its session-end detach
              // echo cannot be mistaken for a real one and relock a session
              // we are about to legitimately replace. openTapSession
              // resubscribes fresh for the reopened session.
              this.unsubscribeKeyEvents()
              try {
                driver.stop()
              } catch {
                /* best-effort */
              }
              await this.openTapSession(driver, meta, pin)
            }
            // loop: retry the same signature
          }
        }
      },
      release: () => {
        if (released) return
        released = true
        // Session-based transports (iOS NFC) held the scan session open across
        // every signature in this session; this is what finally dismisses the
        // sheet. Unsubscribe first so our own stop() cannot echo back as a
        // detach and re-enter this relock path.
        if (driver.sessionBased) {
          this.unsubscribeKeyEvents()
          try {
            driver.stop()
          } catch {
            /* stop is best-effort */
          }
        }
      }
    }
  }

  private arm(): void {
    const armedUntil = nowPlus(this.deps.retentionMs)
    this.set({ phase: 'armed', armedUntil, error: undefined })
    this.clearArmTimer()
    this.armTimer = setTimeout(() => {
      if (this.state.phase === 'armed') {
        this.activeSigner?.release()
        this.activeSigner = undefined
        this.set({ phase: 'idle' })
        this.onRelock?.('timeout')
      }
    }, this.deps.retentionMs)
    // Don't let a pending relock timer keep a Node/Jest event loop alive; RN
    // timers have no unref, so guard for it.
    ;(this.armTimer as { unref?: () => void }).unref?.()
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

  private resolveAll(signer: VaultR1Signer): void {
    const ws = this.waiters
    this.waiters = []
    this.rejecters = []
    ws.forEach(w => w(signer))
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

// setTimeout-free "now" so the module never trips the Date.now ban in other
// runtimes; here Date.now is fine (RN app + jest), isolated to one spot.
function nowPlus(ms: number): number {
  return Date.now() + ms
}
