import { useEffect } from 'react'
import { AppState, DeviceEventEmitter, Platform } from 'react-native'

interface Options {
  /** Called when the OS signals memory pressure (iOS UIApplicationDidReceiveMemoryWarningNotification or Android trim-memory). */
  onMemoryWarning?: () => void
  /** Called when the app moves to background/inactive — good moment to capture a thumbnail. */
  onBackground?: () => void
  /** Called when the app returns to foreground. */
  onForeground?: () => void
}

/**
 * Hook that wires three pieces of iOS hygiene:
 *   1. `AppState` change → onBackground / onForeground.
 *   2. Native `memoryWarning` event → onMemoryWarning.
 *
 * Without this, the app keeps unbounded thumbnails + WebView caches across
 * background transitions and ignores OS memory pressure — which on iPhone SE
 * (3 GB RAM) with 6+ tabs leads to OOM kills during heavy dApp use.
 */
export function useMemoryHygiene({ onMemoryWarning, onBackground, onForeground }: Options) {
  useEffect(() => {
    const appStateSub = AppState.addEventListener('change', state => {
      if (state === 'background' || state === 'inactive') {
        onBackground?.()
      } else if (state === 'active') {
        onForeground?.()
      }
    })

    // memoryWarning is emitted on both platforms via DeviceEventEmitter.
    // On iOS it surfaces RCTPlatform's bridge of UIApplicationDidReceiveMemoryWarningNotification.
    // On Android it surfaces trim-memory level >= TRIM_MEMORY_RUNNING_LOW.
    const memSub = DeviceEventEmitter.addListener('memoryWarning', () => {
      console.warn(`[Memory] ${Platform.OS} memoryWarning received`)
      onMemoryWarning?.()
    })

    return () => {
      appStateSub.remove()
      memSub.remove()
    }
  }, [onMemoryWarning, onBackground, onForeground])
}
