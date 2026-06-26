import * as Device from 'expo-device'
import { Platform } from 'react-native'

/**
 * Coarse device performance tier — used to degrade chrome effects + tab caps
 * on low-RAM hardware (iPhone SE 1/2/3, base iPad, older Pixel) where the
 * combination of liquid glass + Reanimated 4 + live WebView contends for the
 * main thread.
 *
 * The mapping is intentionally conservative — we lean toward "low" if the
 * RAM read is uncertain, so SE-class devices stay smooth at the cost of
 * a slightly less fancy chrome on borderline mid-range models.
 */
export type DeviceTier = 'low' | 'mid' | 'high'

let cachedTier: DeviceTier | null = null

/** Read once and cache — device tier doesn't change at runtime. */
export function getDeviceTier(): DeviceTier {
  if (cachedTier) return cachedTier

  // Device.totalMemory is bytes on iOS+Android. expo-device returns null on
  // simulators/emulators occasionally; treat null as "mid" (warm pool default 2)
  // so dev work isn't degraded.
  const memBytes = Device.totalMemory
  if (typeof memBytes === 'number' && memBytes > 0) {
    const gb = memBytes / 1024 / 1024 / 1024
    if (gb < 3.5) cachedTier = 'low'
    else if (gb < 5.5) cachedTier = 'mid'
    else cachedTier = 'high'
  } else {
    cachedTier = 'mid'
  }

  // iPad gets a small bump — extra screen real estate but the same SoC as the
  // matching iPhone (e.g. iPad mini 6 vs iPhone 12). Allow chrome glass at mid.
  if (Platform.OS === 'ios' && Device.deviceType === Device.DeviceType.TABLET && cachedTier === 'mid') {
    cachedTier = 'mid'
  }

  return cachedTier
}

/** Tab cap by tier — keeps SE-class within OOM-safe memory. */
export function maxTabsForTier(tier: DeviceTier = getDeviceTier()): number {
  switch (tier) {
    case 'low':
      return 4
    case 'mid':
      return 8
    case 'high':
      return 12
  }
}

/**
 * How many WebViews to keep mounted for instant tab switching.
 * iOS keeps one WebContent process per mounted page — four warm tabs on
 * SE-class hardware caused multi-GB footprints and process termination.
 * Flagship devices can afford 2–3 without the same pressure.
 */
export function warmPoolSizeForTier(tier: DeviceTier = getDeviceTier()): number {
  if (Platform.OS !== 'ios') return Math.min(2, maxTabsForTier(tier))
  switch (tier) {
    case 'low':
      return 1
    case 'mid':
      return 2
    case 'high':
      return 3
  }
}

/** Should we render liquid glass + heavy blur? Disabled on low tier. */
export function shouldUseLiquidGlass(tier: DeviceTier = getDeviceTier()): boolean {
  return tier !== 'low'
}

/** Thumbnail capture quality — lowered on low tier to skip the rasterization spike. */
export function thumbnailQualityForTier(tier: DeviceTier = getDeviceTier()): number {
  switch (tier) {
    case 'low':
      return 0.35
    case 'mid':
      return 0.5
    case 'high':
      return 0.7
  }
}
