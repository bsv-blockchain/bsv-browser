/**
 * Gate for the /pay proof-collection nudge.
 *
 * Frame size tracks unproven ancestry: a payer whose Monitor hasn't collected
 * proofs recently ships a ballooned AtomicBEEF and lands on a slower rung —
 * or past 64 KiB, fails outright. Navigating to /pay is the strongest signal
 * a frame build is imminent, so we run one CheckForProofs pass there, at most
 * once per interval, deferred so screen mount never blocks on it. The 2-hour
 * background trigger (WalletContext) is unchanged; this only pulls it earlier.
 */
export const PROOF_NUDGE_MIN_INTERVAL_MS = 10 * 60 * 1000

let lastGrantedMs = -Infinity

export function takeProofNudge(nowMs: number): boolean {
  if (nowMs - lastGrantedMs < PROOF_NUDGE_MIN_INTERVAL_MS) return false
  lastGrantedMs = nowMs
  return true
}

export function resetProofNudgeForTests(): void {
  lastGrantedMs = -Infinity
}
