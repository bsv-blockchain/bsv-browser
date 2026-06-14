import { normalizeUrlForHistory } from '@/utils/generalHelpers'

describe('normalizeUrlForHistory', () => {
  it('canonicalizes equivalent root paths', () => {
    expect(normalizeUrlForHistory('https://weather.com/.?from=launch:homescreen')).toBe(
      'https://weather.com/?from=launch:homescreen'
    )
  })

  it('canonicalizes an origin without a trailing slash', () => {
    expect(normalizeUrlForHistory('https://example.com')).toBe('https://example.com/')
  })

  it('removes transient challenge parameters while preserving other parameters', () => {
    expect(normalizeUrlForHistory('https://example.com/?keep=1&__cf_chl_tk=temporary')).toBe(
      'https://example.com/?keep=1'
    )
  })
})
