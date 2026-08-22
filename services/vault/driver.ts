/**
 * The single hardware surface the rest of the vault talks to.
 *
 * `VaultDriver` is deliberately declared here structurally (not imported from
 * the native package) so the entire TS layer — ceremony, service, tests —
 * compiles and runs without the `react-native-yubikey` native module resolving.
 * The real driver is a thin adapter over that module's JSON-string API; the
 * mock is a software implementation with test controls.
 *
 * Selection order: real native module > injected mock (DEV) > null. Null means
 * "no YubiKey capability on this device", and every caller treats it as such —
 * the vault UI hides, exactly like localpay's getLocalPayTransport() null path.
 */
import { Platform } from 'react-native'
import { vaultErrorFromNative } from './types'

export interface KeyEvent {
  type: 'attached' | 'detached'
  serial?: string
  transport: 'usb' | 'nfc' | 'mock'
}

export interface VaultDriver {
  isSupported(): boolean
  /** True when the transport is a modal per-ceremony session (iOS NFC: start()
   * shows the scan sheet, stop() dismisses it) rather than a persistent reader
   * (Android USB, mock). Session-based drivers are started only when a ceremony
   * begins — never at launch — and stopped when it arms or fails. */
  sessionBased: boolean
  start(): void
  stop(): void
  onKeyEvent(cb: (e: KeyEvent) => void): () => void
  getKeyInfo(): Promise<{ serial: string; firmwareVersion: string; pinRetries: number }>
  verifyPin(pin: string): Promise<{ ok: boolean; retriesLeft: number }>
  changePin(oldPin: string, newPin: string): Promise<{ ok: boolean; retriesLeft: number }>
  generateVaultKey(slot: number): Promise<{ publicKey: string }>
  readVaultPublicKey(slot: number): Promise<{ publicKey: string } | null>
  /** On-token ECDH (PIV KeyAgreement): derive the shared secret between the
   * slot's P-256 key and a peer (ephemeral) public key. Returns the 32-byte
   * x-coordinate as hex — the touch-gated step that unwraps a sealed vault
   * key (see sealing.ts's seal/unseal pair). TOUCH-gated, PIN-gated. */
  ecdh(slot: number, pin: string, peerPublicKey: string): Promise<{ secret: string }>
  /** Sign a pre-computed 32-byte digest (64 hex chars) with the slot's P-256
   * key. Returns a DER signature as hex. TOUCH-gated, PIN-gated. */
  signEcdsa(slot: number, pin: string, digest: string): Promise<{ signature: string }>
}

/** Shape of the native Nitro module (JSON-string API). Kept local so a missing
 * package never breaks the type-check. */
interface NativeYubiKeyPiv {
  isSupported(): boolean
  startDiscovery(): void
  stopDiscovery(): void
  setKeyListener(listener: (eventType: string, serial: string, transport: string) => void): void
  clearKeyListener(): void
  getKeyInfo(): Promise<string>
  verifyPin(pin: string): Promise<string>
  changePin(oldPin: string, newPin: string): Promise<string>
  generateVaultKey(slot: number, touchPolicy: string, pinPolicy: string): Promise<string>
  readVaultPublicKey(slot: number): Promise<string>
  ecdh(slot: number, pin: string, peerPublicKey: string): Promise<string>
  signEcdsa(slot: number, pin: string, digest: string): Promise<string>
}

let injectedMock: VaultDriver | null = null
let nativeCache: VaultDriver | null | undefined

/** DEV/test seam: force the mock (or clear it). */
export function setMockDriver(driver: VaultDriver | null): void {
  injectedMock = driver
}

/** Normalize a native key event into the driver's vocabulary.
 *
 * The native modules emit `connected` / `removed` (iOS YubiKit + Android
 * yubikit-android naming); the driver — and the mock, ceremony, and tests —
 * speak `attached` / `detached`. Only an explicit connect is an attach; an
 * explicit disconnect is a detach; anything unrecognized is treated as a
 * detach (fail-safe: a stray event relocks rather than silently keeping the
 * PKM armed). Getting this wrong makes insert read as detach and aborts the
 * in-flight ceremony as `key-removed-mid-op`. */
export function mapNativeKeyEvent(eventType: string, serial: string, transport: string): KeyEvent {
  const attached = eventType === 'attached' || eventType === 'connected'
  return {
    type: attached ? 'attached' : 'detached',
    serial: serial || undefined,
    transport: (transport as KeyEvent['transport']) || 'usb'
  }
}

/** Wrap the native module's JSON-string surface as a VaultDriver. */
function adaptNative(native: NativeYubiKeyPiv): VaultDriver {
  const parse = async <T>(p: Promise<string>): Promise<T> => {
    try {
      return JSON.parse(await p) as T
    } catch (e) {
      throw vaultErrorFromNative(e)
    }
  }
  const listeners = new Set<(e: KeyEvent) => void>()
  return {
    isSupported: () => native.isSupported(),
    // iOS = NFC (a modal per-tap session); Android = persistent USB reader.
    sessionBased: Platform.OS === 'ios',
    start: () => {
      // (Re)install the native listener each start; it forwards into the
      // persistent JS `listeners` set so app subscribers survive stop/start
      // cycles (a session-based transport starts and stops per ceremony).
      native.setKeyListener((eventType, serial, transport) => {
        const e = mapNativeKeyEvent(eventType, serial, transport)
        listeners.forEach(cb => cb(e))
      })
      native.startDiscovery()
    },
    stop: () => {
      native.stopDiscovery()
      native.clearKeyListener()
      // NOTE: do NOT clear `listeners` — app subscribers (WalletContext) stay
      // subscribed across ceremony sessions.
    },
    onKeyEvent: cb => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    getKeyInfo: () => parse(native.getKeyInfo()),
    verifyPin: pin => parse(native.verifyPin(pin)),
    changePin: (o, n) => parse(native.changePin(o, n)),
    // 'always' (not 'cached'): the YubiKey is now an ECDH unwrap oracle — one
    // on-token ECDH per ceremony recovers the vault key, then every R1-K1
    // input signs in software from that recovered key, so there's no longer
    // a per-input touch to spare. A single per-op touch is affordable and is
    // the stronger policy (no cached-touch window an attacker with a stolen,
    // still-inserted key could ride). Existing enrolled keys keep whatever
    // policy they were generated under — this only affects new enrollments.
    generateVaultKey: slot => parse(native.generateVaultKey(slot, 'always', 'once')),
    readVaultPublicKey: async slot => {
      const r = await parse<{ publicKey: string | null }>(native.readVaultPublicKey(slot))
      return r.publicKey ? { publicKey: r.publicKey } : null
    },
    ecdh: (slot, pin, peer) => parse(native.ecdh(slot, pin, peer)),
    signEcdsa: (slot, pin, digest) => parse(native.signEcdsa(slot, pin, digest))
  }
}

function loadNative(): VaultDriver | null {
  if (nativeCache !== undefined) return nativeCache
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-yubikey') as { getYubiKeyPiv?: () => NativeYubiKeyPiv | null }
    const native = mod.getYubiKeyPiv?.() ?? null
    nativeCache = native ? adaptNative(native) : null
  } catch {
    nativeCache = null
  }
  return nativeCache
}

/** The active driver: native if present, else an injected mock, else null. */
export function getVaultDriver(): VaultDriver | null {
  const native = loadNative()
  if (native) return native
  return injectedMock
}
