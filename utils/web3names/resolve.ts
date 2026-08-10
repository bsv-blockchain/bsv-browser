/**
 * Resolution transport — one GET to a conformant resolver (ODNCA-STD-001 §3).
 * The endpoint is configuration, not trust: every answer is verified locally
 * (verify.ts) and anchored on-chain (commitProof.ts / the outpoint check).
 */

import type { ResolveResult } from './types'

export async function resolveName (resolverUrl: string, address: string, fetchFn: typeof fetch = fetch): Promise<ResolveResult> {
  const res = await fetchFn(`${resolverUrl}/resolve/${encodeURIComponent(address)}`, {
    headers: { accept: 'application/json' }
  })
  let body: any
  try {
    body = await res.json()
  } catch {
    return { ok: false, error: `bad_gateway_${res.status}`, message: 'resolver returned a non-JSON reply' }
  }
  if (body && body.ok === true) return body
  return { ok: false, error: (body && (body.error || body.code)) || `http_${res.status}`, message: body && body.message }
}
