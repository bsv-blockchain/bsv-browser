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

export const springs = {
  /** Buttons, small elements, alert cards. */
  snappy: { mass: 1, stiffness: 380, damping: 36 },
  /** Larger surfaces: sheets, popovers, dropdowns. */
  settle: { mass: 1, stiffness: 280, damping: 32 },
} as const

export const durations = {
  /** Crossfades, press feedback. */
  instant: 150,
  /** Small movements, toasts. */
  quick: 250,
  /** Largest allowed — full-surface transitions. */
  moderate: 350,
} as const
