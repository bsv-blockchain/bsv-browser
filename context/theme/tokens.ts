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

/**
 * Corner radii. The scale is softer than iOS's: `md` is the glyph-tile radius,
 * `lg` the card/button radius, `xl` the radius a bottom sheet meets the screen
 * edge with. Rounder corners are the loudest single cue that a surface is a
 * distinct object rather than a region of the page.
 */
export const radii = {
  sm: 8,
  md: 12,
  lg: 14,
  xl: 24,
  pill: 999,
} as const

/* ------------------------------- Typography ------------------------------ */

/**
 * The iOS type scale, which is very close to a 1.25 (major third) ratio anchored
 * on `body` at 17pt: 13 · 17 · 22 · 28 · 34 — each step ≈ the previous × 1.25.
 *
 * `display` continues that ratio one step past `largeTitle` (34 × 1.25 ≈ 42,
 * rounded to 44 to sit on the 4pt grid). It is for a single focal figure on a
 * screen that has one — an amount being handed to another person — and nothing
 * else. Two `display` elements on one view means the view has no focal point.
 */
export const typography = {
  display: { fontSize: 44, fontWeight: '700' as const, lineHeight: 52, letterSpacing: -0.5 },
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

  // Backgrounds — the cool neutral ramp. Canvas is a step under the cards that
  // sit on it; without that step, a white card on a white page has to be drawn
  // with a border to exist at all.
  background: '#FFFFFF',
  backgroundSecondary: '#F5F6F9',
  backgroundTertiary: '#FFFFFF',
  backgroundElevated: '#FFFFFF',

  // Translucent chrome (for toolbars, sheets)
  chromeBackground: 'rgba(251, 252, 253, 0.94)',
  chromeBackgroundBlur: 'rgba(255, 255, 255, 0.72)',
  sheetBackground: 'rgba(244, 245, 248, 0.97)',

  // Text — one ink, stepped down by alpha. Pure black on white is harsher than
  // anything else in this system, so the darkest text is a near-black.
  textPrimary: '#15181E',
  textSecondary: 'rgba(21, 24, 30, 0.55)',
  textTertiary: 'rgba(21, 24, 30, 0.38)',
  textQuaternary: 'rgba(21, 24, 30, 0.2)',
  textOnAccent: '#FFFFFF',

  // Separators
  separator: 'rgba(21, 24, 30, 0.12)',
  separatorOpaque: '#E2E5EB',

  // Fills
  fill: 'rgba(21, 24, 30, 0.09)',
  fillSecondary: 'rgba(21, 24, 30, 0.07)',
  fillTertiary: 'rgba(21, 24, 30, 0.05)',

  // Status
  success: '#1E9E62',
  error: '#FF3B30',
  warning: '#FF9500',
  info: '#007AFF',

  // Money surfaces — a cool, slightly-blue neutral ramp used by the wallet and
  // pay screens. Deliberately NOT the iOS grays above: the canvas is a shallow
  // gradient the raised cards sit on, so it has to be a touch darker than the
  // cards themselves or the cards stop reading as raised at all.
  canvasTop: '#EAECF1',
  canvasBase: '#F5F6F9',
  surfaceRaised: '#FFFFFF',
  surfaceRaisedBorder: '#E2E5EB',
  surfaceRaisedPressed: '#F0F2F6',
  // Sunken = an inset well (row glyph tiles), the opposite of raised.
  surfaceSunken: 'rgba(21, 24, 30, 0.045)',
  surfaceSunkenBorder: 'rgba(21, 24, 30, 0.06)',
  // The surface a list row is lifted onto while it is open. In light that means
  // white against the gray canvas; in dark, a hair of light added to the canvas.
  surfaceRowExpanded: '#FFFFFF',
  // Hairline is quieter than `separator`: it divides rows that already share a
  // surface, where a full-strength rule would look like a fence.
  hairline: 'rgba(21, 24, 30, 0.06)',
  // Status green at two weights: the dot/glyph reads at small size, the amount
  // has to survive being set in 14.5pt semibold next to plain body text.
  successStrong: '#1E9E62',
  successAmount: '#178A5C',

  // Bottom sheets. A drawer is lit from its own top edge, so it gets its own
  // two-stop ramp rather than reusing the canvas — the sheet has to separate
  // from whatever is behind it even when that is the same colour.
  sheetTop: '#FBFCFD',
  sheetBase: '#F4F5F8',
  // Scrim over the page behind a sheet. Lighter in light mode: the page is
  // already bright, so it needs less dimming to fall behind the drawer.
  scrim: 'rgba(24, 28, 36, 0.38)',

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

  // Backgrounds — the same ramp inverted: canvas is the darkest thing on
  // screen and surfaces are lifted out of it, never painted onto it.
  background: '#0C0E12',
  backgroundSecondary: '#10141B',
  backgroundTertiary: '#1D222B',
  backgroundElevated: '#171B22',

  // Translucent chrome
  chromeBackground: 'rgba(18, 22, 29, 0.94)',
  chromeBackgroundBlur: 'rgba(18, 22, 29, 0.72)',
  sheetBackground: 'rgba(14, 17, 22, 0.97)',

  // Text — a cool near-white rather than pure white, which glares against a
  // blue-black canvas at body size.
  textPrimary: '#F2F4F8',
  textSecondary: 'rgba(235, 240, 248, 0.55)',
  textTertiary: 'rgba(235, 240, 248, 0.38)',
  textQuaternary: 'rgba(235, 240, 248, 0.2)',
  // textOnAccent contrasts with the white accent — must stay dark in dark mode.
  textOnAccent: '#0C0E12',

  // Separators
  separator: 'rgba(255, 255, 255, 0.11)',
  separatorOpaque: '#232833',

  // Fills
  fill: 'rgba(255, 255, 255, 0.1)',
  fillSecondary: 'rgba(255, 255, 255, 0.08)',
  fillTertiary: 'rgba(255, 255, 255, 0.06)',

  // Status
  success: '#34C77B',
  error: '#FF453A',
  warning: '#FF9F0A',
  info: '#0A84FF',

  // Money surfaces — see the light theme for the reasoning. In dark the ramp
  // runs the other way: the canvas is the darkest thing on screen and raised
  // cards are lifted OUT of it, so `surfaceRaised` is lighter, not whiter.
  canvasTop: '#10141B',
  canvasBase: '#0C0E12',
  surfaceRaised: '#171B22',
  surfaceRaisedBorder: 'rgba(255, 255, 255, 0.08)',
  surfaceRaisedPressed: '#1D222B',
  surfaceSunken: 'rgba(255, 255, 255, 0.05)',
  surfaceSunkenBorder: 'rgba(255, 255, 255, 0.07)',
  surfaceRowExpanded: 'rgba(255, 255, 255, 0.035)',
  hairline: 'rgba(255, 255, 255, 0.06)',
  successStrong: '#34C77B',
  successAmount: '#4BD592',

  // Bottom sheets — see the light theme. Sits a step above the canvas so the
  // drawer reads as lifted off the dimmed page behind it.
  sheetTop: '#12161D',
  sheetBase: '#0E1116',
  scrim: 'rgba(10, 12, 16, 0.62)',

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
