/**
 * Per-install device identifier for the backup log.
 *
 * Opaque and locally generated — it is not a hardware id and carries no device
 * information. It exists so that two devices restoring the same wallet keep separate,
 * independently sequenced logs rather than fighting over one sequence.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { Random, Utils } from '@bsv/sdk'
import { DEVICE_ID_KEY } from './constants'

let cached: string | null = null

/** 32 lowercase hex characters, matching the server's device-id pattern. */
export async function getDeviceId (): Promise<string> {
  if (cached != null) return cached

  const existing = await AsyncStorage.getItem(DEVICE_ID_KEY)
  if (existing != null && /^[a-f0-9]{32}$/.test(existing)) {
    cached = existing
    return existing
  }

  const fresh = Utils.toHex(Random(16))
  await AsyncStorage.setItem(DEVICE_ID_KEY, fresh)
  cached = fresh
  return fresh
}

/** Test seam. */
export function resetDeviceIdCache (): void {
  cached = null
}
