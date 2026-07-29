import { createServiceOptions, installOfflineChainTracker, chaintracksUrlFor } from '@/services/walletServiceConfig'
import { Services } from '@bsv/wallet-toolbox-mobile'

const exchangeRate = () => ({ timestamp: new Date(), base: 'USD' as const, rate: 1 })

// Pins the Critical fix: Services.getChainTracker() does NOT delegate to
// options.chaintracks.isValidRootForHeight — it wraps options.chaintracks in
// ChaintracksChainTracker, whose own isValidRootForHeight calls
// findHeaderForHeight with a 6x/250ms retry loop and throws on persistent
// failure (out/src/services/chaintracker/ChaintracksChainTracker.js:21-56).
// Passing an offline-first client as options.chaintracks alone therefore
// never reaches its store-first lookup. installOfflineChainTracker is the
// actual seam; this test is what would have caught the original bug.
describe('installOfflineChainTracker', () => {
  it('makes services.getChainTracker() resolve to the injected tracker', async () => {
    // Stands in for OfflineFirstChaintracks — the point here is the seam
    // (does getChainTracker() actually return what we hand it), not the
    // wrapper's own store-first logic, which offlineChaintracks.test.ts covers.
    const fakeTracker = {
      isValidRootForHeight: jest.fn().mockResolvedValue(true),
      currentHeight: jest.fn().mockResolvedValue(0)
    }

    const options = createServiceOptions('test', 'callback-token', exchangeRate())
    const services = new Services(options)

    installOfflineChainTracker(services, fakeTracker as any)

    const tracker = await services.getChainTracker()
    expect(tracker).toBe(fakeTracker)
  })

  it('without the override, getChainTracker() wraps chaintracks rather than returning it directly', async () => {
    const options = createServiceOptions('test', 'callback-token', exchangeRate())
    const services = new Services(options)

    const tracker = await services.getChainTracker()

    // Sanity check of the seam this fix closes: the untouched default is some
    // other object (ChaintracksChainTracker) wrapping options.chaintracks, not
    // options.chaintracks itself and not anything with the shape we inject.
    expect(tracker).not.toBe(options.chaintracks)
  })
})

describe('chaintracksUrlFor', () => {
  it('returns the right default URL per network, with no env override set', () => {
    expect(chaintracksUrlFor('main')).toBe('https://arcade-v2-us-1.bsvblockchain.tech/chaintracks/v1')
    expect(chaintracksUrlFor('test')).toBe('https://arcade-v2-testnet-us-1.bsvblockchain.tech/chaintracks/v1')
    expect(chaintracksUrlFor('teratest')).toBe('https://arcade-v2-ttn-us-1.bsvblockchain.tech/chaintracks/v1')
  })
})
