/**
 * Ceremony controller — UI-free state machine for the insert → PIN → touch
 * flow that unseals the vault key. Consumed by a React context that renders
 * the ceremony sheet; kept free of React and native imports so it is fully
 * unit-testable against the mock driver.
 *
 * Concurrency: one ceremony at a time. Concurrent request() calls (e.g. a
 * multi-input withdrawal) share the same in-flight ceremony and all resolve
 * from a single touch. The controller never retains the key — the
 * PrivilegedKeyManager does, with its own obfuscated retention window; the
 * 'armed' phase here is only a UI signal with a countdown.
 *
 * SECURITY: never log the resolved key, the PIN, or the ECDH secret.
 */
import { PrivateKey } from '@bsv/sdk'
import { VaultDriver } from './driver'
import { unsealVaultKey } from './sealing'
import { SealedBlob, VaultError, VaultErrorCode } from './types'

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

interface CeremonyStoreView {
  isEnrolled(): Promise<boolean>
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

export class CeremonyController {
  state: CeremonyState = { phase: 'idle' }

  onRelock?: (why: 'timeout' | 'detached' | 'manual') => void
  onArmed?: (key: PrivateKey) => void

  private subscribers = new Set<(s: CeremonyState) => void>()
  private waiters: ((key: PrivateKey) => void)[] = []
  private rejecters: ((e: unknown) => void)[] = []
  private running = false
  private reason = ''

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

  /** Ask for the privileged key. Concurrent calls share one ceremony. */
  request(reason: string): Promise<PrivateKey> {
    return new Promise<PrivateKey>((resolve, reject) => {
      this.waiters.push(resolve)
      this.rejecters.push(reject)
      if (this.running) {
        // join the in-flight ceremony; keep the first reason shown
        return
      }
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

  cancel(): void {
    this.cancelled = true
    this.pinWaiter?.reject(new VaultError('user-cancelled'))
    this.retryWaiter?.reject(new VaultError('user-cancelled'))
    this.attachWaiter?.reject(new VaultError('user-cancelled'))
    if (this.running) {
      this.failAll(new VaultError('user-cancelled'))
      this.set({ phase: 'idle' })
      this.running = false
    }
  }

  /** A key detached. Aborts an in-flight ceremony; relocks an armed window. */
  notifyKeyDetached(): void {
    if (this.state.phase === 'armed') {
      this.clearArmTimer()
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

  private async run(): Promise<void> {
    const driver = this.deps.getDriver()
    if (!driver) {
      this.failAll(new VaultError('driver-unavailable'))
      this.running = false
      return
    }
    // Own driver-event subscription for the ceremony's lifetime: a key
    // connecting (an NFC tap / a USB plug) resolves waiting-for-key; a key
    // dropping mid-flow aborts. Self-contained so it works whether or not
    // WalletContext also watches for persistent relock.
    const off = driver.onKeyEvent(e => {
      if (e.type === 'attached') this.notifyKeyAttached()
      else if (this.running) this.notifyKeyDetached()
    })
    try {
      const seal = await this.deps.store.getSeal()
      if (!seal) throw new VaultError('not-enrolled')

      // NFC (session-based) collects the PIN BEFORE the tap and runs every token
      // op in that one tap (the scan sheet covers the app, so no PIN entry
      // mid-tap). A persistent USB reader can interleave PIN entry and token ops.
      const key = driver.sessionBased
        ? await this.unsealViaTap(driver, seal)
        : await this.unsealViaReader(driver, seal)
      this.throwIfCancelled()

      this.arm()
      this.resolveAll(key)
      this.onArmed?.(key)
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
      // Unsubscribe BEFORE stopping so the session-end detach can't relock the
      // key we just armed.
      off()
      // Session-based transports (iOS NFC) hold a modal scan session open for
      // the whole ceremony; close it now (dismisses the sheet) whether we armed,
      // errored, or were cancelled. Persistent readers (Android USB) are left
      // running — WalletContext owns their lifecycle for relock-on-unplug.
      if (driver.sessionBased) {
        try {
          driver.stop()
        } catch {
          /* stop is best-effort */
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

  /** Persistent reader (Android USB): the key is present (or gets plugged), so
   * PIN entry and token ops interleave — verify during collection, retry on a
   * wrong PIN without any re-tap. */
  private async unsealViaReader(driver: VaultDriver, seal: SealedBlob): Promise<PrivateKey> {
    this.set({ phase: 'connecting' })
    let info = await this.safeKeyInfo(driver)
    if (!info) {
      this.set({ phase: 'waiting-for-key' })
      // Hold the promise locally: notifyKeyAttached clears this.attachWaiter, and
      // start() can resolve it synchronously (e.g. the mock).
      const waiter = (this.attachWaiter = defer<void>())
      driver.start()
      await waiter.promise
      this.throwIfCancelled()
      this.set({ phase: 'connecting' })
      info = await this.safeKeyInfo(driver)
    }
    if (!info) throw new VaultError('no-key')
    if (info.serial !== seal.yubiSerial) {
      throw new VaultError('serial-mismatch', `Expected key ${seal.yubiSerial}`)
    }
    const pin = await this.collectPin(driver)
    return this.unsealWithTouch(driver, seal, pin)
  }

  /** NFC tap (iOS): PIN first in-app (the sheet is modal), then one tap does
   * serial check → verify PIN → ECDH. A wrong PIN aborts (surfaced as an error);
   * the user retries the whole ceremony, since we cannot re-prompt under the
   * open sheet. */
  private async unsealViaTap(driver: VaultDriver, seal: SealedBlob): Promise<PrivateKey> {
    const pin = await this.collectPinValue()
    this.set({ phase: 'waiting-for-key' })
    const waiter = (this.attachWaiter = defer<void>())
    driver.start()
    await waiter.promise
    this.throwIfCancelled()
    this.set({ phase: 'connecting' })
    const info = await driver.getKeyInfo()
    if (info.serial !== seal.yubiSerial) {
      throw new VaultError('serial-mismatch', `Expected key ${seal.yubiSerial}`)
    }
    const res = await driver.verifyPin(pin)
    if (!res.ok) throw new VaultError('pin-invalid', 'Wrong PIN', res.retriesLeft)
    this.set({ phase: 'awaiting-touch' })
    const { secret } = await driver.ecdh(seal.slot, pin, seal.ePub)
    this.set({ phase: 'unsealing' })
    return new PrivateKey(unsealVaultKey(seal, secret))
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

  private async unsealWithTouch(driver: VaultDriver, seal: SealedBlob, pin: string): Promise<PrivateKey> {
    for (;;) {
      this.throwIfCancelled()
      this.set({ phase: 'awaiting-touch' })
      try {
        const { secret } = await driver.ecdh(seal.slot, pin, seal.ePub)
        this.set({ phase: 'unsealing' })
        const v = unsealVaultKey(seal, secret)
        return new PrivateKey(v)
      } catch (e) {
        const err = e instanceof VaultError ? e : new VaultError('touch-timeout')
        if (err.code === 'touch-timeout') {
          this.set({ phase: 'error', error: { code: 'touch-timeout' } })
          this.retryWaiter = defer<void>()
          await this.retryWaiter.promise // resolves on retry(); rejects on cancel/detach
          continue
        }
        throw err
      }
    }
  }

  private arm(): void {
    const armedUntil = nowPlus(this.deps.retentionMs)
    this.set({ phase: 'armed', armedUntil, error: undefined })
    this.clearArmTimer()
    this.armTimer = setTimeout(() => {
      if (this.state.phase === 'armed') {
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

  private resolveAll(key: PrivateKey): void {
    const ws = this.waiters
    this.waiters = []
    this.rejecters = []
    ws.forEach(w => w(key))
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
