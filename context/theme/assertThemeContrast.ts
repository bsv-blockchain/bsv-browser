/**
 * Dev-only contrast assertion for theme tokens.
 *
 * Runs once at app start (via ThemeProvider) and warns if any of the known
 * foreground/background pairs would be unreadable. Catches mistakes like
 * setting `darkColors.accent = 'white'` while leaving
 * `darkColors.textOnAccent = '#FFFFFF'` — the exact bug that produced an
 * invisible "Apply" button on the ARC Endpoint panel.
 *
 * No-ops in production builds. The check is O(pairs) and runs once per theme
 * mode toggle, so the cost is irrelevant even in dev.
 */

import type { ThemeColors } from './ThemeContext'

/** Pairs that must keep enough contrast for body-sized text. */
const REQUIRED_PAIRS: Array<{ fg: keyof ThemeColors; bg: keyof ThemeColors; label: string }> = [
  { fg: 'textOnAccent', bg: 'accent', label: 'button text on accent' },
  { fg: 'textPrimary', bg: 'background', label: 'primary text on background' },
  { fg: 'textPrimary', bg: 'backgroundSecondary', label: 'primary text on backgroundSecondary' },
  { fg: 'textPrimary', bg: 'backgroundTertiary', label: 'primary text on backgroundTertiary' },
  { fg: 'textPrimary', bg: 'backgroundElevated', label: 'primary text on backgroundElevated' }
]

/** WCAG AA threshold for normal-weight body text. */
const MIN_CONTRAST = 4.5

/** Parse a CSS-ish color literal into linear sRGB [0..1]. Returns null if unparseable. */
function toRgb(input: string): [number, number, number] | null {
  if (!input) return null
  const s = input.trim().toLowerCase()
  if (s === 'transparent') return null

  // Named colors we use in the token file.
  const named: Record<string, [number, number, number]> = {
    white: [255, 255, 255],
    black: [0, 0, 0]
  }
  if (named[s]) return named[s]

  // #rrggbb or #rgb
  if (s.startsWith('#')) {
    const h = s.slice(1)
    if (h.length === 3) {
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)]
    }
    if (h.length === 6 || h.length === 8) {
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
    }
  }

  // rgba(r, g, b, a) or rgb(r, g, b) — we treat translucent fg/bg as best-effort
  // (compose against the bg's own RGB if alpha < 1, but only if both have alpha).
  const m = s.match(/^rgba?\(([^)]+)\)$/)
  if (m) {
    const parts = m[1].split(',').map(p => parseFloat(p.trim()))
    if (parts.length >= 3) return [parts[0], parts[1], parts[2]]
  }

  return null
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number) => {
    const cs = c / 255
    return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

/** Validate a single theme palette. Returns a list of violations. */
export function findContrastViolations(colors: ThemeColors): string[] {
  const violations: string[] = []
  for (const pair of REQUIRED_PAIRS) {
    const fg = toRgb(colors[pair.fg] as string)
    const bg = toRgb(colors[pair.bg] as string)
    if (!fg || !bg) continue
    const ratio = contrastRatio(fg, bg)
    if (ratio < MIN_CONTRAST) {
      violations.push(
        `theme contrast: ${pair.label} — ${colors[pair.fg]} on ${colors[pair.bg]} = ${ratio.toFixed(2)}:1 (need ${MIN_CONTRAST}:1)`
      )
    }
  }
  return violations
}

/**
 * Call once when the active theme palette changes. In production this is a
 * no-op (Metro folds `__DEV__` to false and dead-code-eliminates the body).
 */
export function assertThemeContrast(colors: ThemeColors, mode: 'light' | 'dark'): void {
  if (!__DEV__) return
  const violations = findContrastViolations(colors)
  if (violations.length === 0) return
  // eslint-disable-next-line no-console
  console.warn(
    `[theme] contrast invariant violated in ${mode} mode:\n  ${violations.join('\n  ')}\n` +
      `Fix the offending tokens in context/theme/tokens.ts so the pair contrasts ≥ ${MIN_CONTRAST}:1.`
  )
}
