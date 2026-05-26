/**
 * Safari-inspired design tokens for the BSV Browser.
 *
 * Colors follow iOS Human Interface Guidelines.
 * Typography uses the iOS type scale (system font).
 * Spacing uses a 4pt base grid.
 *
 * INVARIANT — contrast pairs MUST stay readable:
 *   - `accent` ↔ `textOnAccent` (button bg vs button text)
 *   - `background` ↔ `textPrimary`
 *   - `backgroundSecondary` / `backgroundTertiary` ↔ `textPrimary`
 *
 * Never set `textOnAccent` and `accent` to the same brightness (white on white,
 * black on black). The light theme inverts colours from the dark theme — that
 * means BOTH theme objects must be updated when changing either field. A
 * runtime contrast check in `assertThemeContrast.ts` warns in dev if this
 * invariant breaks.
 */

/* -------------------------------- Spacing -------------------------------- */

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const

/* --------------------------------- Radii --------------------------------- */

export const radii = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  pill: 999,
} as const

/* ------------------------------- Typography ------------------------------ */

export const typography = {
  largeTitle: { fontSize: 34, fontWeight: '700' as const, lineHeight: 41 },
  title1: { fontSize: 28, fontWeight: '700' as const, lineHeight: 34 },
  title2: { fontSize: 22, fontWeight: '700' as const, lineHeight: 28 },
  title3: { fontSize: 20, fontWeight: '600' as const, lineHeight: 25 },
  headline: { fontSize: 17, fontWeight: '600' as const, lineHeight: 22 },
  body: { fontSize: 17, fontWeight: '400' as const, lineHeight: 22 },
  callout: { fontSize: 16, fontWeight: '400' as const, lineHeight: 21 },
  subhead: { fontSize: 15, fontWeight: '400' as const, lineHeight: 20 },
  footnote: { fontSize: 13, fontWeight: '400' as const, lineHeight: 18 },
  caption1: { fontSize: 12, fontWeight: '400' as const, lineHeight: 16 },
  caption2: { fontSize: 11, fontWeight: '400' as const, lineHeight: 13 },
} as const

/* --------------------------------- Colors -------------------------------- */

export const lightColors = {
  // Accent — `textOnAccent` MUST stay readable against this. Both fields invert
  // in `darkColors` below; never let them collapse to the same brightness.
  accent: 'black',
  accentSecondary: '#222222',

  // Backgrounds
  background: '#FFFFFF',
  backgroundSecondary: '#F2F2F7',
  backgroundTertiary: '#FFFFFF',
  backgroundElevated: '#FFFFFF',

  // Translucent chrome (for toolbars, sheets)
  chromeBackground: 'rgba(249, 249, 249, 0.94)',
  chromeBackgroundBlur: 'rgba(255, 255, 255, 0.72)',
  sheetBackground: 'rgba(242, 242, 247, 0.97)',

  // Text
  textPrimary: '#000000',
  textSecondary: 'rgba(60, 60, 67, 0.6)',
  textTertiary: 'rgba(60, 60, 67, 0.3)',
  textQuaternary: 'rgba(60, 60, 67, 0.18)',
  textOnAccent: '#FFFFFF',

  // Separators
  separator: 'rgba(60, 60, 67, 0.29)',
  separatorOpaque: '#C6C6C8',

  // Fills
  fill: 'rgba(120, 120, 128, 0.2)',
  fillSecondary: 'rgba(120, 120, 128, 0.16)',
  fillTertiary: 'rgba(118, 118, 128, 0.12)',

  // Status
  success: '#34C759',
  error: '#FF3B30',
  warning: '#FF9500',
  info: '#007AFF',

  // Permission approval
  permissionProtocol: '#34C759',
  permissionBasket: '#34C759',
  permissionIdentity: '#007AFF',
  permissionSpending: '#FF9500',
} as const

export const darkColors = {
  // Accent — inverted from light theme, so the contrasting text colour also
  // inverts. Without this pairing, `<Text color={colors.textOnAccent}>` on a
  // `colors.accent` button is white-on-white in dark mode.
  accent: 'white',
  accentSecondary: '#e8e8e8',

  // Backgrounds
  background: '#000000',
  backgroundSecondary: '#1C1C1E',
  backgroundTertiary: '#2C2C2E',
  backgroundElevated: '#1C1C1E',

  // Translucent chrome
  chromeBackground: 'rgba(29, 29, 31, 0.94)',
  chromeBackgroundBlur: 'rgba(29, 29, 31, 0.72)',
  sheetBackground: 'rgba(28, 28, 30, 0.97)',

  // Text
  textPrimary: '#FFFFFF',
  textSecondary: 'rgba(235, 235, 245, 0.6)',
  textTertiary: 'rgba(235, 235, 245, 0.3)',
  textQuaternary: 'rgba(235, 235, 245, 0.18)',
  // textOnAccent contrasts with the white accent — must stay dark in dark mode.
  textOnAccent: '#000000',

  // Separators
  separator: 'rgba(84, 84, 88, 0.6)',
  separatorOpaque: '#38383A',

  // Fills
  fill: 'rgba(120, 120, 128, 0.36)',
  fillSecondary: 'rgba(120, 120, 128, 0.32)',
  fillTertiary: 'rgba(118, 118, 128, 0.24)',

  // Status
  success: '#30D158',
  error: '#FF453A',
  warning: '#FF9F0A',
  info: '#0A84FF',

  // Permission approval
  permissionProtocol: '#1fae4378',
  permissionBasket: '#1fae4378',
  permissionIdentity: '#24588dff',
  permissionSpending: '#FF9F0A',
} as const

/* ------------------------------ Hit Targets ------------------------------ */

export const hitTargets = {
  minimum: 44, // iOS HIG minimum touch target
} as const
