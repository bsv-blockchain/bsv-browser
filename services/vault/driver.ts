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
import { vaultErrorFromNative } from './types'

export interface KeyEvent {
  type: 'attached' | 'detached'
  serial?: string
  transport: 'usb' | 'nfc' | 'mock'
}

export interface VaultDriver {
  isSupported(): boolean
  start(): void
  stop(): void
  onKeyEvent(cb: (e: KeyEvent) => void): () => void
  getKeyInfo(): Promise<{ serial: string; firmwareVersion: string; pinRetries: number }>
  verifyPin(pin: string): Promise<{ ok: boolean; retriesLeft: number }>
  changePin(oldPin: string, newPin: string): Promise<{ ok: boolean; retriesLeft: number }>
  generateVaultKey(slot: number): Promise<{ publicKey: string }>
  readVaultPublicKey(slot: number): Promise<{ publicKey: string } | null>
  ecdh(slot: number, pin: string, peerPublicKey: string): Promise<{ secret: string }>
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
}

let injectedMock: VaultDriver | null = null
let nativeCache: VaultDriver | null | undefined

/** DEV/test seam: force the mock (or clear it). */
export function setMockDriver(driver: VaultDriver | null): void {
  injectedMock = driver
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
    start: () => {
      native.setKeyListener((eventType, serial, transport) => {
        const e: KeyEvent = {
          type: eventType === 'attached' ? 'attached' : 'detached',
          serial: serial || undefined,
          transport: (transport as KeyEvent['transport']) || 'usb'
        }
        listeners.forEach(cb => cb(e))
      })
      native.startDiscovery()
    },
    stop: () => {
      native.stopDiscovery()
      native.clearKeyListener()
      listeners.clear()
    },
    onKeyEvent: cb => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    getKeyInfo: () => parse(native.getKeyInfo()),
    verifyPin: pin => parse(native.verifyPin(pin)),
    changePin: (o, n) => parse(native.changePin(o, n)),
    generateVaultKey: slot => parse(native.generateVaultKey(slot, 'always', 'once')),
    readVaultPublicKey: async slot => {
      const r = await parse<{ publicKey: string | null }>(native.readVaultPublicKey(slot))
      return r.publicKey ? { publicKey: r.publicKey } : null
    },
    ecdh: (slot, pin, peer) => parse(native.ecdh(slot, pin, peer))
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
