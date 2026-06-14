import {
  consumePendingInitialBrowserUrl,
  externalUrlsMatch,
  resetExternalUrlRouterForTests,
  setPendingInitialBrowserUrl,
  shouldHandleExternalBrowserUrl
} from '@/utils/externalUrlRouter'
import { redirectSystemPath } from '@/app/+native-intent'

describe('external URL routing', () => {
  beforeEach(resetExternalUrlRouterForTests)

  it('consumes a native-intent URL once', () => {
    setPendingInitialBrowserUrl('https://example.com/article')
    expect(consumePendingInitialBrowserUrl()).toBe('https://example.com/article')
    expect(consumePendingInitialBrowserUrl()).toBeNull()
  })

  it('captures a cold-start default-browser URL before routing to index', () => {
    const url = 'https://example.com/from-another-app'
    expect(redirectSystemPath({ path: url, initial: true })).toBe('/')
    expect(consumePendingInitialBrowserUrl()).toBe(url)
  })

  it('does not leave a stale pending URL for a running-app delivery', () => {
    expect(redirectSystemPath({ path: 'https://example.com/live', initial: false })).toBe('/')
    expect(consumePendingInitialBrowserUrl()).toBeNull()
  })

  it('deduplicates cold-start URL delivery within the launch window', () => {
    expect(shouldHandleExternalBrowserUrl('https://example.com', 1000)).toBe(true)
    expect(shouldHandleExternalBrowserUrl('https://example.com/', 2000)).toBe(false)
    expect(shouldHandleExternalBrowserUrl('https://example.com', 4000)).toBe(true)
  })

  it('does not collapse distinct external URLs', () => {
    expect(shouldHandleExternalBrowserUrl('https://example.com/one', 1000)).toBe(true)
    expect(shouldHandleExternalBrowserUrl('https://example.com/two', 1100)).toBe(true)
  })

  it('normalizes equivalent active-tab URLs', () => {
    expect(externalUrlsMatch('https://example.com', 'https://example.com/')).toBe(true)
  })
})
