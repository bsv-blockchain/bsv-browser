/**
 * Semantic haptic vocabulary (spec Part 1). Import `haptics` directly in
 * plain modules; use `useHaptics()` in components for symmetry with other
 * hooks. All calls are fire-and-forget and never throw.
 *
 * | semantic | iOS                         | Android |
 * |----------|-----------------------------|---------|
 * | tap      | selectionAsync              | no-op   |
 * | confirm  | impactAsync(Light)          | no-op   |
 * | success  | notificationAsync(Success)  | vibrate |
 * | warning  | notificationAsync(Warning)  | vibrate |
 * | error    | notificationAsync(Error)    | vibrate |
 */
import * as Haptics from 'expo-haptics'
import { Platform } from 'react-native'

const swallow = (p: Promise<void>) => { p.catch(() => {}) }
const isIOS = () => Platform.OS === 'ios'

export const haptics = {
  tap: () => { if (isIOS()) swallow(Haptics.selectionAsync()) },
  confirm: () => { if (isIOS()) swallow(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)) },
  success: () => swallow(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  warning: () => swallow(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  error: () => swallow(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
} as const

export type HapticName = keyof typeof haptics

export const useHaptics = () => haptics
