import type { HybridObject } from 'react-native-nitro-modules'

export interface LocalPayTransport extends HybridObject<{ ios: 'swift' }> {
  /** True when AWDL peer-to-peer networking is usable on this device. */
  isSupported(): boolean
}
