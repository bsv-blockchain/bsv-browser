/**
 * The recognised web3 TLD set — ODNCA root list.
 *
 * A build-time snapshot keeps the browser working offline; the live list is
 * refreshed from the resolver /health endpoint (tlds + retired_tlds) so new
 * TLD activations arrive without an app release. Retired TLDs still resolve;
 * they are simply closed for new registration — for the browser both sets
 * are navigable.
 */

export const SNAPSHOT_TLDS = ['web3', 'bitcoin', 'crypto', 'blockchain', 'ordnet']
export const SNAPSHOT_RETIRED_TLDS = ['bsv', 'bitcoinsv']

/**
 * Client-side guards on the refreshed list. The /health list is not yet a
 * signed document (a signed TLD registry is on the ODNCA roadmap), so the
 * browser never lets a refresh widen interception into the web2 namespace:
 * additions must match a conservative shape, common web2 TLDs are refused
 * outright, and the total set is capped. The build-time snapshot can never
 * be removed by a refresh.
 */
const WEB2_TLD_BLOCKLIST = new Set([
  'com', 'net', 'org', 'io', 'co', 'app', 'dev', 'xyz', 'info', 'me', 'tv', 'ai', 'us', 'uk', 'de',
  'nl', 'fr', 'es', 'it', 'ru', 'cn', 'jp', 'in', 'br', 'au', 'ca', 'ch', 'se', 'no', 'eu', 'gov', 'edu'
])
const TLD_SHAPE = /^[a-z0-9]{2,12}$/
const MAX_TLDS = 32

interface TldState {
  active: Set<string>
  fetchedAt: number
}

const state: TldState = {
  active: new Set([...SNAPSHOT_TLDS, ...SNAPSHOT_RETIRED_TLDS]),
  fetchedAt: 0
}

export function knownTlds (): Set<string> {
  return state.active
}

export function isKnownTld (tld: string): boolean {
  return state.active.has(String(tld || '').toLowerCase())
}

/** Refresh the TLD set from a conformant resolver. Failures keep the last good set. */
export async function refreshTlds (resolverUrl: string, refreshMs: number, fetchFn: typeof fetch = fetch): Promise<void> {
  const now = Date.now()
  if (now - state.fetchedAt < refreshMs) return
  try {
    const res = await fetchFn(`${resolverUrl}/health`, { headers: { accept: 'application/json' } })
    if (!res.ok) return
    const body = await res.json()
    const tlds = Array.isArray(body.tlds) ? body.tlds : []
    const retired = Array.isArray(body.retired_tlds) ? body.retired_tlds : []
    const additions = [...tlds, ...retired]
      .map((t: string) => String(t).toLowerCase())
      .filter((t: string) => TLD_SHAPE.test(t) && !WEB2_TLD_BLOCKLIST.has(t))
    const merged = new Set([...SNAPSHOT_TLDS, ...SNAPSHOT_RETIRED_TLDS, ...additions])
    if (merged.size > 0 && merged.size <= MAX_TLDS) {
      state.active = merged
      state.fetchedAt = now
    }
  } catch {
    // Offline or resolver unreachable — the snapshot keeps names working.
  }
}
