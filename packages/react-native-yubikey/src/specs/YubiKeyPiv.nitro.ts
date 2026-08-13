import type { HybridObject } from 'react-native-nitro-modules'

export interface YubiKeyPiv extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  isSupported(): boolean
  startDiscovery(): void
  stopDiscovery(): void
  setKeyListener(listener: (eventType: string, serial: string, transport: string) => void): void
  clearKeyListener(): void
  getKeyInfo(): Promise<string>       // JSON {serial, firmwareVersion, pinRetries}
  verifyPin(pin: string): Promise<string>            // JSON {ok, retriesLeft}
  changePin(oldPin: string, newPin: string): Promise<string>
  generateVaultKey(slot: number, touchPolicy: string, pinPolicy: string): Promise<string>  // JSON {publicKey} 65B SEC1 hex uncompressed
  readVaultPublicKey(slot: number): Promise<string>  // JSON {publicKey|null}
  ecdh(slot: number, pin: string, peerPublicKey: string): Promise<string>  // JSON {secret} 32B hex x-coord; TOUCH-gated
}
