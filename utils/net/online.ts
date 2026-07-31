/**
 * The single definition of "online" for the whole app.
 *
 * `isInternetReachable` is tri-state: NetInfo reports `null` while it has not
 * finished probing. Treating `null` as offline would make every cold start look
 * offline for a beat, so only an explicit `false` counts against us — which is
 * the same rule the three call sites this replaces already used.
 */
import NetInfo from '@react-native-community/netinfo'

export interface OnlineState {
  isConnected: boolean | null
  isInternetReachable: boolean | null
}

export function isOnlineState(state: OnlineState): boolean {
  return state.isConnected === true && state.isInternetReachable !== false
}

export async function getOnline(): Promise<boolean> {
  return isOnlineState(await NetInfo.fetch())
}

/** Returns the unsubscribe function. */
export function subscribeOnline(cb: (online: boolean) => void): () => void {
  return NetInfo.addEventListener(state => cb(isOnlineState(state)))
}
