/**
 * `useOnline` is mounted by /pay (app/pay.tsx). A `NetInfo.fetch()` that rejects
 * must not become an unhandled rejection there: under this repo's Jest setup a
 * real `getOnline()` rejection is enough to take the process down (Task 11 found
 * that the hard way), which is the same shape of failure a device hits at mount.
 * The optimistic initial `true` plus `subscribeOnline`'s updates are a perfectly
 * good answer without it.
 */
jest.mock('@/utils/net/online', () => ({
  getOnline: jest.fn(),
  subscribeOnline: jest.fn(() => () => {})
}))

import { act, renderHook } from '@testing-library/react-native'
import { getOnline } from '@/utils/net/online'
import { useOnline } from '@/hooks/useOnline'

const probe = getOnline as jest.Mock

/** Two turns: one for the promise, one for Node to declare a rejection unhandled. */
const settle = async () => {
  await act(async () => {
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
  })
}

describe('useOnline', () => {
  it('leaves no unhandled rejection when the connectivity probe fails', async () => {
    const unhandled: unknown[] = []
    const listener = (e: unknown) => unhandled.push(e)
    process.on('unhandledRejection', listener)
    try {
      probe.mockRejectedValue(new Error('NetInfo native module unavailable'))
      const { result } = renderHook(() => useOnline())
      await settle()

      expect(unhandled).toEqual([])
      // Still optimistic: a first render that wrongly says offline hides the
      // online rails from a user who has signal, which is the worse mistake.
      expect(result.current).toBe(true)
    } finally {
      process.off('unhandledRejection', listener)
    }
  })

  it('adopts what the probe resolves to', async () => {
    probe.mockResolvedValue(false)
    const { result } = renderHook(() => useOnline())
    await settle()
    expect(result.current).toBe(false)
  })
})
