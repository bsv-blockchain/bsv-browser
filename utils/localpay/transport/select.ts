import { Platform } from 'react-native'
import { getLocalPayTransport } from 'react-native-localpay-transport'
import { CAP_AWDL, CAP_NEARBY, type Session } from '../session'

export type TransportKind = 'awdl' | 'nearby' | 'qr'

/** True when this device can act as an AWDL peer. */
export function localSupportsAwdl(): boolean {
  if (Platform.OS !== 'ios') return false
  try {
    return getLocalPayTransport()?.isSupported() ?? false
  } catch {
    return false
  }
}

/**
 * True when this device can act as a Nearby Connections peer. The same native
 * surface as AWDL, from the Kotlin backend: isSupported() there means Google
 * Play services is present. Runtime permissions are requested at flow entry,
 * not here — a denial degrades the mint/ladder to QR at that point.
 */
export function localSupportsNearby(): boolean {
  if (Platform.OS !== 'android') return false
  try {
    return getLocalPayTransport()?.isSupported() ?? false
  } catch {
    return false
  }
}

/**
 * The rung both sides can climb to. Caps say what the PEER advertised at mint
 * time; the local check says what THIS device can do. QR is the floor every
 * pair can reach — and the automatic fallback when a chosen radio fails at
 * send time (see NearbyFlow's executeSend).
 */
export function selectTransport(session: Session): TransportKind {
  if ((session.caps & CAP_AWDL) !== 0 && localSupportsAwdl()) return 'awdl'
  if ((session.caps & CAP_NEARBY) !== 0 && localSupportsNearby()) return 'nearby'
  return 'qr'
}
