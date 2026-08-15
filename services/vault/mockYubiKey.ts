/**
 * Software YubiKey for development and tests.
 *
 * Implements VaultDriver against an in-memory P-256 keypair, emulating the
 * behaviours the real ceremony must survive: PIN retries and lockout, touch
 * timeouts, and key removal mid-operation. ECDH mirrors the token exactly
 * (32-byte x-coordinate), so a seal produced against the mock's public key
 * unseals through the mock — the whole vault stack runs end-to-end without
 * hardware.
 *
 * DEV/test only. Never bundled into a path a production user reaches.
 */
import { p256 } from '@noble/curves/nist.js'
import { Utils } from '@bsv/sdk'
import { VaultDriver, KeyEvent } from './driver'
import { softwareEcdh } from './sealing'
import { VaultError } from './types'

type TouchBehavior = 'instant' | 'timeout'

const DEFAULT_PIN = '123456'

export class MockYubiKey implements VaultDriver {
  private listeners = new Set<(e: KeyEvent) => void>()
  private present = false
  private serial = 'MOCK-1'
  private pin = DEFAULT_PIN
  private pinRetries = 3
  private pinVerified = false
  private touch: TouchBehavior = 'instant'
  private slotPriv: Uint8Array | null = null
  private slotPub: string | null = null

  // ---- test controls ---------------------------------------------------
  insertKey(serial = 'MOCK-1'): void {
    this.serial = serial
    this.present = true
    this.pinRetries = 3
    this.pinVerified = false
    this.emit({ type: 'attached', serial, transport: 'mock' })
  }

  removeKey(): void {
    if (!this.present) return
    const serial = this.serial
    this.present = false
    this.pinVerified = false
    this.emit({ type: 'detached', serial, transport: 'mock' })
  }

  setTouchBehavior(b: TouchBehavior): void {
    this.touch = b
  }

  setPin(pin: string): void {
    this.pin = pin
  }

  /** Simulate a slot that already holds a key (e.g. an age-plugin-yubikey
   * identity in retired slot 82), so readVaultPublicKey reports it occupied
   * before any generate. */
  occupySlot(): void {
    this.slotPriv = p256.utils.randomSecretKey()
    this.slotPub = Utils.toHex(Array.from(p256.getPublicKey(this.slotPriv, false)))
  }

  // ---- VaultDriver -----------------------------------------------------
  isSupported(): boolean {
    return true
  }

  /** The mock behaves like a persistent reader (insert/remove under test). */
  sessionBased = false

  start(): void {
    // Session-based flows (NFC) call start() to open a scan session and wait
    // for the tap to connect. Simulate that: if a key is "held", emit attached
    // now. Persistent flows never rely on this (they see the key via getKeyInfo).
    if (this.sessionBased && this.present) {
      this.emit({ type: 'attached', serial: this.serial, transport: 'mock' })
    }
  }

  stop(): void {
    // Matches the real adapter's contract (driver.ts adaptNative.stop): do NOT
    // clear listeners. App subscribers (WalletContext, and now the ceremony's
    // own mid-flight NFC retry loop) stay subscribed across a session-based
    // transport's stop/start cycles. Clearing here would silently break any
    // ceremony that calls stop() and then start() again on the SAME run (e.g.
    // reopening a fresh NFC session after a dropped tap) — its own attach
    // listener, registered once at the top of that run, would be gone.
  }

  onKeyEvent(cb: (e: KeyEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  async getKeyInfo(): Promise<{ serial: string; firmwareVersion: string; pinRetries: number }> {
    this.requirePresent()
    return { serial: this.serial, firmwareVersion: '5.7.1', pinRetries: this.pinRetries }
  }

  async verifyPin(pin: string): Promise<{ ok: boolean; retriesLeft: number }> {
    this.requirePresent()
    if (this.pinRetries <= 0) throw new VaultError('pin-locked', 'PIN is blocked')
    if (pin === this.pin) {
      this.pinRetries = 3
      this.pinVerified = true
      return { ok: true, retriesLeft: 3 }
    }
    this.pinRetries -= 1
    this.pinVerified = false
    return { ok: false, retriesLeft: this.pinRetries }
  }

  async changePin(oldPin: string, newPin: string): Promise<{ ok: boolean; retriesLeft: number }> {
    this.requirePresent()
    if (this.pinRetries <= 0) throw new VaultError('pin-locked', 'PIN is blocked')
    if (oldPin !== this.pin) {
      this.pinRetries -= 1
      throw new VaultError('pin-invalid', 'Wrong PIN', this.pinRetries)
    }
    this.pin = newPin
    this.pinRetries = 3
    return { ok: true, retriesLeft: 3 }
  }

  async generateVaultKey(_slot: number): Promise<{ publicKey: string }> {
    this.requirePresent()
    this.slotPriv = p256.utils.randomSecretKey()
    this.slotPub = Utils.toHex(Array.from(p256.getPublicKey(this.slotPriv, false)))
    return { publicKey: this.slotPub }
  }

  async readVaultPublicKey(_slot: number): Promise<{ publicKey: string } | null> {
    this.requirePresent()
    return this.slotPub ? { publicKey: this.slotPub } : null
  }

  async ecdh(_slot: number, pin: string, peerPublicKey: string): Promise<{ secret: string }> {
    this.requirePresent()
    // pinPolicy=once: a prior verifyPin in this "session" satisfies it; if a PIN
    // is supplied here and not yet verified, verify it inline.
    if (!this.pinVerified) {
      if (!pin) throw new VaultError('pin-required', 'PIN required before ECDH')
      await this.verifyPin(pin)
    }
    if (!this.slotPriv) throw new VaultError('no-key', 'No key in slot')
    if (this.touch === 'timeout') throw new VaultError('touch-timeout', 'Touch not detected')
    const secret = softwareEcdh(Utils.toHex(Array.from(this.slotPriv)), peerPublicKey)
    return { secret }
  }

  /** Software stand-in for the card's GENERAL AUTHENTICATE.
   *
   * Emits DER, exactly like both real platforms, so a DER-parsing bug cannot
   * hide behind the mock. Enforces the same 32-byte digest rule the native
   * modules do — on iOS an unrecognised algorithm constant silently signs 32
   * ZERO bytes, and on Android an over-long payload is silently truncated, so
   * this check is load-bearing, not decorative.
   *
   * `lowS: false` is passed explicitly: @noble/curves defaults P-256 signing
   * to low-S normalisation, but real YubiKey PIV hardware does not normalise
   * — roughly half of real signatures are high-S. A mock that only ever
   * emitted low-S signatures could not catch downstream code that mishandles
   * a non-canonical signature; that failure would first appear against real
   * hardware, exactly the scenario this mock exists to prevent.
   */
  async signEcdsa(_slot: number, pin: string, digest: string): Promise<{ signature: string }> {
    this.requirePresent()
    if (!this.pinVerified) {
      if (!pin) throw new VaultError('pin-required', 'PIN required before signing')
      const res = await this.verifyPin(pin)
      if (!res.ok) throw new VaultError('pin-invalid', 'Wrong PIN', res.retriesLeft)
    }
    if (!this.slotPriv) throw new VaultError('no-key', 'No key in slot')

    const bytes = Utils.toArray(digest, 'hex')
    if (bytes.length !== 32) {
      throw new VaultError('template-invalid', `Digest must be 32 bytes, got ${bytes.length}`)
    }
    if (this.touch === 'timeout') throw new VaultError('touch-timeout', 'Touch not detected')

    const raw = p256.sign(Uint8Array.from(bytes), this.slotPriv, { prehash: false, lowS: false })
    const der = p256.Signature.fromBytes(raw).toBytes('der')
    return { signature: Utils.toHex(Array.from(der)) }
  }

  // ---- internals -------------------------------------------------------
  private requirePresent(): void {
    if (!this.present) throw new VaultError('no-key', 'No YubiKey present')
  }

  private emit(e: KeyEvent): void {
    this.listeners.forEach(cb => cb(e))
  }
}
