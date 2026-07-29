import { isOnlineState } from '@/utils/net/online'

describe('isOnlineState', () => {
  it('is online when connected and reachability is unknown', () => {
    expect(isOnlineState({ isConnected: true, isInternetReachable: null })).toBe(true)
  })

  it('is online when connected and reachable', () => {
    expect(isOnlineState({ isConnected: true, isInternetReachable: true })).toBe(true)
  })

  it('is offline when connected but explicitly unreachable', () => {
    expect(isOnlineState({ isConnected: true, isInternetReachable: false })).toBe(false)
  })

  it('is offline when not connected', () => {
    expect(isOnlineState({ isConnected: false, isInternetReachable: true })).toBe(false)
  })

  it('is offline when connectivity is unknown', () => {
    expect(isOnlineState({ isConnected: null, isInternetReachable: null })).toBe(false)
  })
})
