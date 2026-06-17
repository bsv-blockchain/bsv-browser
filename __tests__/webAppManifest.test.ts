import {
  resolveManifestStartUrl,
  shouldRedirectToManifestStartUrl,
  type WebAppManifest
} from '@/hooks/useWebAppManifest'

describe('web app manifest start URL handling', () => {
  const weatherManifest: WebAppManifest = {
    start_url: '/.?from=launch:homescreen'
  }

  it('canonicalizes dot-segment start URLs', () => {
    expect(resolveManifestStartUrl(weatherManifest, 'https://weather.com/')).toBe(
      'https://weather.com/?from=launch:homescreen'
    )
  })

  it('redirects to a different start URL once', () => {
    expect(shouldRedirectToManifestStartUrl(weatherManifest, 'https://weather.com/')).toBe(true)
    expect(shouldRedirectToManifestStartUrl(weatherManifest, 'https://weather.com/?from=launch:homescreen')).toBe(false)
  })

  it('does not redirect non-root pages or dot start URLs', () => {
    expect(shouldRedirectToManifestStartUrl(weatherManifest, 'https://weather.com/weather/today')).toBe(false)
    expect(shouldRedirectToManifestStartUrl({ start_url: '.' }, 'https://example.com/')).toBe(false)
  })

  it('does not redirect a hash/deep-link route (preserves the fragment)', () => {
    // Regression: pathname is '/' for a hash route, so the old guard let it
    // redirect and strip the fragment (teragun.com/#leaderboard -> /).
    expect(shouldRedirectToManifestStartUrl(weatherManifest, 'https://weather.com/#leaderboard')).toBe(false)
    expect(shouldRedirectToManifestStartUrl(weatherManifest, 'https://weather.com/?tab=videos')).toBe(false)
  })
})
