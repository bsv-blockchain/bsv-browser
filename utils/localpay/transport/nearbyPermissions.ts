/**
 * The runtime grants Nearby Connections needs, by API level. Requested lazily
 * — on entering the nearby flow — never at app start: a user who only ever
 * pays over QR should never see a Bluetooth prompt. A denial is a soft
 * degrade to QR, not an error.
 */
import { PermissionsAndroid, Platform } from 'react-native'

export async function requestNearbyPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return false
  const api = typeof Platform.Version === 'number' ? Platform.Version : parseInt(String(Platform.Version), 10)
  const wanted: string[] =
    api >= 33
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES
        ]
      : api >= 31
        ? [
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
          ]
        : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION]
  try {
    const results = await PermissionsAndroid.requestMultiple(wanted as never)
    return wanted.every(p => results[p as keyof typeof results] === PermissionsAndroid.RESULTS.GRANTED)
  } catch {
    return false
  }
}
