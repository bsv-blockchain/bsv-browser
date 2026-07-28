import { Platform } from 'react-native'
import { getLocalPayTransport } from 'react-native-localpay-transport'
import { CAP_AWDL, type Session } from '../session'

/** True when this device can act as an AWDL peer. */
export function localSupportsAwdl(): boolean {
  if (Platform.OS !== 'ios') return false
  try {
    return getLocalPayTransport()?.isSupported() ?? false
  } catch {
    return false
  }
}

export function selectTransport(session: Session): 'awdl' | 'qr' {
  const peerSupports = (session.caps & CAP_AWDL) !== 0
  return peerSupports && localSupportsAwdl() ? 'awdl' : 'qr'
}
