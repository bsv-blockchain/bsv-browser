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
    /* discovery is driven by insertKey/removeKey in the mock */
  }

  stop(): void {
    this.listeners.clear()
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

  // ---- internals -------------------------------------------------------
  private requirePresent(): void {
    if (!this.present) throw new VaultError('no-key', 'No YubiKey present')
  }

  private emit(e: KeyEvent): void {
    this.listeners.forEach(cb => cb(e))
  }
}
