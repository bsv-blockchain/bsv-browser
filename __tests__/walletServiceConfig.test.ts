import {
  createServiceOptions,
  createServices,
  installOfflineChainTracker,
  chaintracksUrlFor
} from '@/services/walletServiceConfig'
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

// The seam above is only live if something calls it. Until createServices did it
// itself, the single call in context/WalletContext.tsx was the whole guarantee —
// delete that one line and the Critical comes back with no test failing, because
// the wrapper is still injected at options.chaintracks and still never consulted.
// These pin the two halves together: hand createServices an override and the
// Services it returns must already treat it as the chain tracker.
describe('createServices', () => {
  const fakeTracker = () => ({
    isValidRootForHeight: jest.fn().mockResolvedValue(true),
    currentHeight: jest.fn().mockResolvedValue(0)
  })

  it('installs a chaintracks override as the chain tracker, not merely as the client behind it', async () => {
    const override = fakeTracker()
    const { services } = createServices(
      'test',
      'callback-token',
      exchangeRate(),
      undefined,
      undefined,
      override as never
    )

    await expect(services.getChainTracker()).resolves.toBe(override)
  })

  it('still passes the override to the service options, which header sync and misses read', async () => {
    const override = fakeTracker()
    const { serviceOptions } = createServices(
      'test',
      'callback-token',
      exchangeRate(),
      undefined,
      undefined,
      override as never
    )

    expect(serviceOptions.chaintracks).toBe(override)
  })

  it('leaves the toolbox default in place when there is no override', async () => {
    const { services, serviceOptions } = createServices('test', 'callback-token', exchangeRate())

    const tracker = await services.getChainTracker()
    expect(tracker).not.toBe(serviceOptions.chaintracks)
  })
})

describe('chaintracksUrlFor', () => {
  it('returns the right default URL per network, with no env override set', () => {
    expect(chaintracksUrlFor('main')).toBe('https://arcade-v2-us-1.bsvblockchain.tech/chaintracks/v1')
    expect(chaintracksUrlFor('test')).toBe('https://arcade-v2-testnet-us-1.bsvblockchain.tech/chaintracks/v1')
    expect(chaintracksUrlFor('teratest')).toBe('https://arcade-v2-ttn-us-1.bsvblockchain.tech/chaintracks/v1')
  })
})
