/**
 * Pure rules for the end-to-end build. No React Native imports, so Jest can
 * load this file without a device. Nothing here runs unless the caller has
 * already checked EXPO_PUBLIC_E2E.
 *
 * The fixture origin is loopback on purpose. Android reaches it through
 * `adb reverse`; iOS Simulator shares the host network. It is never a public
 * host, and the deep-link hook refuses every other origin.
 */

export const E2E_FIXTURE_ORIGIN = 'http://127.0.0.1:8787'
export const E2E_ARC_URL = `${E2E_FIXTURE_ORIGIN}/arc`
export const E2E_CHAIN = 'test' as const

/** Broadcast mock. Any chain's Arcade posts land here and are refused. */
export const E2E_ARC_KEYS = [
  'arc_custom_url_main',
  'arc_custom_url_test',
  'arc_custom_url_teratest',
  'arc_custom_url_scaletest'
] as const

export const E2E_PROFILES_KEY = 'wallet_profiles_v1'

export function isE2EBuild(): boolean {
  return process.env.EXPO_PUBLIC_E2E === '1'
}

/** Profile 0 on testnet. Cold starts of an e2e build always read this. */
export function e2eProfilesJson(): string {
  return JSON.stringify({ active: 0, profiles: [{ index: 0, network: E2E_CHAIN }] })
}

/**
 * Rewrite a stored profile blob so every profile's network is testnet.
 * Unreadable input becomes the default testnet profile rather than mainnet.
 */
export function forceTestnetProfiles(raw: string | null): string {
  if (!raw) return e2eProfilesJson()
  try {
    const parsed = JSON.parse(raw) as { active?: unknown; profiles?: unknown }
    if (!parsed || !Array.isArray(parsed.profiles) || parsed.profiles.length === 0) {
      return e2eProfilesJson()
    }
    const profiles = parsed.profiles.map(entry => {
      if (!entry || typeof entry !== 'object') return entry
      return { ...(entry as Record<string, unknown>), network: E2E_CHAIN }
    })
    const active = typeof parsed.active === 'number' ? parsed.active : 0
    return JSON.stringify({ ...parsed, active, profiles })
  } catch {
    return e2eProfilesJson()
  }
}

export function isArcStorageKey(key: string): boolean {
  return (E2E_ARC_KEYS as readonly string[]).includes(key)
}

/** Maestro waits on `e2e-status-<this>`. Colons and slashes become hyphens. */
export function e2eStatusTestId(status: string): string {
  const slug = status
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `e2e-status-${slug || 'unknown'}`
}

/**
 * `bsv-browser://e2e?url=<encoded fixture url>` is an e2e-only deep link.
 * It exists so Maestro can open a page without fighting the Android http
 * intent resolver. Production builds never call this. The target must be
 * the loopback fixture origin; anything else is ignored.
 */
export function e2eDeepLinkTarget(url: string): string | null {
  if (!/^bsv-browser:\/\/e2e(\?|$)/i.test(url)) return null
  let parsed: URL
  try {
    parsed = new URL(url.replace(/^bsv-browser:\/\/e2e/i, 'http://e2e.local/'))
  } catch {
    return null
  }
  const target = parsed.searchParams.get('url')
  if (!target) return null
  let destination: URL
  try {
    destination = new URL(target)
  } catch {
    return null
  }
  if (destination.origin !== E2E_FIXTURE_ORIGIN) return null
  if (destination.protocol !== 'http:') return null
  if (destination.username || destination.password) return null
  return destination.toString()
}
