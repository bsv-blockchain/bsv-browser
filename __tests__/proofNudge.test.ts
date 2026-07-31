import { takeProofNudge, resetProofNudgeForTests, PROOF_NUDGE_MIN_INTERVAL_MS } from '@/utils/pay/proofNudge'

describe('takeProofNudge', () => {
  beforeEach(resetProofNudgeForTests)

  it('grants the first nudge', () => {
    expect(takeProofNudge(1_000_000)).toBe(true)
  })

  it('refuses a second nudge inside the interval', () => {
    takeProofNudge(1_000_000)
    expect(takeProofNudge(1_000_000 + PROOF_NUDGE_MIN_INTERVAL_MS - 1)).toBe(false)
  })

  it('grants again after the interval', () => {
    takeProofNudge(1_000_000)
    expect(takeProofNudge(1_000_000 + PROOF_NUDGE_MIN_INTERVAL_MS)).toBe(true)
  })

  it('a refused attempt does not push the window forward', () => {
    takeProofNudge(1_000_000)
    takeProofNudge(1_000_000 + 1) // refused
    expect(takeProofNudge(1_000_000 + PROOF_NUDGE_MIN_INTERVAL_MS)).toBe(true)
  })
})
