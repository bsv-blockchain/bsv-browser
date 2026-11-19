/**
 * Liveness — ODNCA-STD-001 level 3. A signed answer proves what the resolver
 * said; the unspent check proves the holder outpoint is still live on-chain.
 * Failure mode is honest: 'spent' refuses to render (ownership just moved),
 * 'unknown' (source unreachable) proceeds on the signed answer, whose short
 * `expires` window bounds the risk — and is surfaced to the caller.
 */

import type { Outpoint } from './types'

export type LivenessVerdict = 'live' | 'spent' | 'unknown'

export type SpentSource = (outpoint: Outpoint) => Promise<LivenessVerdict>

/** WhatsOnChain spent-status: 200 => spending tx exists, 404 => unspent. */
export const wocSpentSource: SpentSource = async (outpoint) => {
  try {
    const res = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${outpoint.txid}/${outpoint.vout}/spent`)
    if (res.status === 404) return 'live'
    if (res.ok) return 'spent'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}
