import type { HybridObject } from 'react-native-nitro-modules'

export interface YubiKeyPiv extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  isSupported(): boolean
  startDiscovery(): void
  stopDiscovery(): void
  setKeyListener(listener: (eventType: string, serial: string, transport: string) => void): void
  clearKeyListener(): void
  getKeyInfo(): Promise<string> // JSON {serial, firmwareVersion, pinRetries}
  verifyPin(pin: string): Promise<string> // JSON {ok, retriesLeft}
  changePin(oldPin: string, newPin: string): Promise<string>
  generateVaultKey(slot: number, touchPolicy: string, pinPolicy: string): Promise<string> // JSON {publicKey} 65B SEC1 hex uncompressed
  readVaultPublicKey(slot: number): Promise<string> // JSON {publicKey|null}
  /** On-token ECDH (PIV KeyAgreement) between the slot's P-256 private key and
   * `peerPublicKey` (65-byte SEC1 uncompressed hex, 0x04 || X || Y).
   *
   * Resolves JSON {secret} — the 32-byte x-coordinate of the shared point as
   * hex, exactly what the card returns (NO KDF applied on either side; the
   * vault's sealing layer owns that). TOUCH-gated, PIN-gated. */
  ecdh(slot: number, pin: string, peerPublicKey: string): Promise<string>
  /** Sign a pre-computed 32-byte digest with the slot's P-256 key.
   *
   * `digest` is 64 hex chars, passed to the card UNCHANGED — no hashing on
   * either side. Resolves JSON {signature} as DER hex. TOUCH-gated. */
  signEcdsa(slot: number, pin: string, digest: string): Promise<string>
}
