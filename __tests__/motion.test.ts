import { springs, durations } from '@/context/theme/motion'

describe('motion tokens', () => {
  it('defines the two approved springs', () => {
    expect(springs.snappy).toEqual({ mass: 1, stiffness: 380, damping: 36 })
    expect(springs.settle).toEqual({ mass: 1, stiffness: 280, damping: 32 })
  })
  it('caps every duration at 350ms (Quiet Precision)', () => {
    expect(durations.instant).toBe(150)
    expect(durations.quick).toBe(250)
    expect(durations.moderate).toBe(350)
    Object.values(durations).forEach(d => expect(d).toBeLessThanOrEqual(350))
  })
})
