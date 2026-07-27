import type { HybridObject } from 'react-native-nitro-modules'

export interface LocalPayTransport extends HybridObject<{ ios: 'swift' }> {
  /** True when AWDL peer-to-peer networking is usable on this device. */
  isSupported(): boolean
  startListening(
    instanceName: string,
    pskBase64: string,
    onFrame: (frameBase64: string) => void,
    onError: (message: string) => void
  ): Promise<void>
  stopListening(): Promise<void>
  sendFrame(
    instanceName: string,
    pskBase64: string,
    frameBase64: string,
    timeoutMs: number
  ): Promise<string>
}
