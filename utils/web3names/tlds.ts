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
 * Client-side guards on the refreshed list.
 *
 * This WAS a denylist of 32 web2 TLDs. A denylist of 32 against roughly 1500
 * delegated gTLDs is not a defence: a hostile /health could add `bank`, `shop`,
 * `online`, `email` or `be` and the address bar would intercept real web2
 * domains — for a regulated gTLD like .bank that is exactly the harm this file
 * says it exists to prevent, and the pollution survived a refresh.
 *
 * It is now an ALLOWLIST. A refresh can only re-state TLDs that are already in
 * the build-time snapshot; it can mark them retired, and it can drop nothing.
 * Genuinely new TLDs arrive through a release of this module — which is the
 * honest trade-off until the ODNCA root registry is a signed document that a
 * client can verify for itself (on the roadmap; see STD-004).
 *
 * The shape check and the cap stay as belt-and-braces.
 */
const TLD_SHAPE = /^[a-z0-9]{2,12}$/
const MAX_TLDS = 32

/** The only TLDs this module will ever treat as web3, regardless of what a
 *  resolver claims. Additions require a release. */
const TLD_ALLOWLIST = new Set([...SNAPSHOT_TLDS, ...SNAPSHOT_RETIRED_TLDS])

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
    // Only names already in the allowlist survive. A resolver cannot widen the
    // web3 namespace by answering /health differently — it can only confirm
    // what this build already knows.
    const confirmed = [...tlds, ...retired]
      .map((t: string) => String(t).toLowerCase())
      .filter((t: string) => TLD_SHAPE.test(t) && TLD_ALLOWLIST.has(t))
    const merged = new Set([...SNAPSHOT_TLDS, ...SNAPSHOT_RETIRED_TLDS, ...confirmed])
    if (merged.size > 0 && merged.size <= MAX_TLDS) {
      state.active = merged
      state.fetchedAt = now
    }
  } catch {
    // Offline or resolver unreachable — the snapshot keeps names working.
  }
}
