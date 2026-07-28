/**
 * Motion tokens — "Quiet Precision" (see docs/superpowers/specs/2026-06-11-delightful-hig-polish-design.md).
 *
 * Rules:
 *  - All animation runs on the UI thread via Reanimated. Never drive animation
 *    from setState/JS timers on interaction paths.
 *  - Nothing animates longer than `durations.moderate` (350ms).
 *  - Respect reduced motion: gate springs/translations behind
 *    `useReducedMotion()` from react-native-reanimated — collapse to opacity
 *    fades or instant changes.
 *
 * LiquidGlass / UIVisualEffectView guardrails (hard-won — do not regress):
 *  - NEVER animate an ancestor's opacity fractionally above LiquidGlass or
 *    BlurView content; the effect view freezes at a stale frame.
 *  - A stuck UIVisualEffectView is cured by remounting via a changed `key`.
 */

import { Easing } from 'react-native-reanimated'
import type { WithSpringConfig } from 'react-native-reanimated'

/**
 * Easing curves for `withTiming`.
 *
 * There is exactly one, and it decelerates. UI motion in this app models
 * something arriving and coming to rest, so it must start at full speed and
 * settle — an ease-IN reads as the interface hesitating before it obeys, and is
 * never correct for a response to a tap. Where a curve is not expressive enough
 * on its own, reach for `springs` instead of inventing a second curve.
 */
export const easings = {
  /** cubic-bezier(0.23, 1, 0.32, 1) — a long, soft deceleration. */
  out: Easing.bezier(0.23, 1, 0.32, 1),
} as const

export const springs = {
  /** Buttons, small elements, alert cards. Custom-tuned — NOT Reanimated's built-in presets. */
  snappy: { mass: 1, stiffness: 380, damping: 36 } satisfies WithSpringConfig,
  /** Larger surfaces: sheets, popovers, dropdowns. */
  settle: { mass: 1, stiffness: 280, damping: 32 } satisfies WithSpringConfig,
} as const

/** All values in milliseconds. */
export const durations = {
  /** Crossfades, press feedback. */
  instant: 150,
  /** Small movements, toasts. */
  quick: 250,
  /** Largest allowed — full-surface transitions. */
  moderate: 350,
} as const
