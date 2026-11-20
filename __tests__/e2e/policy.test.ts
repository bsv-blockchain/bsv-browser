import {
  E2E_ARC_URL,
  E2E_FIXTURE_ORIGIN,
  e2eDeepLinkTarget,
  e2eProfilesJson,
  e2eStatusTestId,
  forceTestnetProfiles
} from '@/utils/e2e/policy'
import { installE2EStorageShim, type StorageLike } from '@/utils/e2e/storageShim'

describe('e2e policy', () => {
  it('locks a missing or mainnet profile blob to testnet', () => {
    expect(JSON.parse(e2eProfilesJson()).profiles[0].network).toBe('test')
    expect(JSON.parse(forceTestnetProfiles(null)).profiles[0].network).toBe('test')
    const rewritten = JSON.parse(
      forceTestnetProfiles(JSON.stringify({ active: 0, profiles: [{ index: 0, network: 'main', identityKey: 'abc' }] }))
    )
    expect(rewritten.profiles[0].network).toBe('test')
    expect(rewritten.profiles[0].identityKey).toBe('abc')
    expect(JSON.parse(forceTestnetProfiles('not-json')).profiles[0].network).toBe('test')
  })

  it('builds a stable Maestro test id', () => {
    expect(e2eStatusTestId('page:home')).toBe('e2e-status-page-home')
    expect(e2eStatusTestId('payment:failed')).toBe('e2e-status-payment-failed')
  })

  it('accepts only the loopback fixture as an e2e deep link', () => {
    const encoded = `bsv-browser://e2e?url=${encodeURIComponent(`${E2E_FIXTURE_ORIGIN}/deeplink`)}`
    expect(e2eDeepLinkTarget(encoded)).toBe(`${E2E_FIXTURE_ORIGIN}/deeplink`)
    expect(e2eDeepLinkTarget('bsv-browser://e2e?url=https://example.com/')).toBeNull()
    expect(e2eDeepLinkTarget('bsv-browser://e2e?url=http://10.0.2.2:8787/')).toBeNull()
    expect(e2eDeepLinkTarget('bsv-browser://pair?topic=abc')).toBeNull()
    expect(e2eDeepLinkTarget('https://example.com')).toBeNull()
  })

  it('forces testnet profiles and the mock arcade URL through storage', async () => {
    const disk = new Map<string, string>()
    const storage: StorageLike = {
      getItem: async key => disk.get(key) ?? null,
      setItem: async (key, value) => {
        disk.set(key, value)
      }
    }
    installE2EStorageShim(storage)

    await storage.setItem(
      'wallet_profiles_v1',
      JSON.stringify({ active: 0, profiles: [{ index: 0, network: 'main' }] })
    )
    expect(JSON.parse((await storage.getItem('wallet_profiles_v1')) || '').profiles[0].network).toBe('test')

    await storage.setItem('arc_custom_url_main', 'https://arc.example')
    expect(await storage.getItem('arc_custom_url_main')).toBe(E2E_ARC_URL)
    expect(disk.get('arc_custom_url_main')).toBe(E2E_ARC_URL)

    await storage.setItem('homepageUrl', 'https://example.com')
    expect(await storage.getItem('homepageUrl')).toBe('https://example.com')
  })
})
