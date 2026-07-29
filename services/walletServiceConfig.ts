import type { AppChain } from '@/context/config'
import { toWalletChain } from '@/context/config'
import {
  ChaintracksServiceClient,
  Services
} from '@bsv/wallet-toolbox-mobile'
import type {
  BsvExchangeRate,
  WalletServicesOptions
} from '@bsv/wallet-toolbox-mobile/out/src/sdk'
import type { ChaintracksClientApi } from '@bsv/wallet-toolbox-mobile/out/src/services/chaintracker/chaintracks/Api/ChaintracksClientApi'
import type { ChainTracker } from '@bsv/sdk'

/**
 * The chaintracks URL for a network — the one place this table is defined.
 * `createServiceOptions` below and `WalletContext` (which needs the same URL
 * to build the remote client it wraps in `OfflineFirstChaintracks`) both call
 * this, rather than each keeping their own copy that could drift.
 */
export function chaintracksUrlFor(network: AppChain): string {
  if (network === 'main') {
    return process.env?.EXPO_PUBLIC_CHAINTRACKS_URL ?? 'https://arcade-v2-us-1.bsvblockchain.tech/chaintracks/v1'
  }
  if (network === 'test') {
    return (
      process.env?.EXPO_PUBLIC_TEST_CHAINTRACKS_URL ??
      'https://arcade-v2-testnet-us-1.bsvblockchain.tech/chaintracks/v1'
    )
  }
  return (
    process.env?.EXPO_PUBLIC_TERATEST_CHAINTRACKS_URL ?? 'https://arcade-v2-ttn-us-1.bsvblockchain.tech/chaintracks/v1'
  )
}

/**
 * Points `services.getChainTracker()` at `tracker` directly, instead of the
 * `ChaintracksChainTracker` that `Services.getChainTracker()` would otherwise
 * construct around `options.chaintracks`
 * (out/src/services/Services.js:149-154). That default's own
 * `isValidRootForHeight` (out/src/services/chaintracker/ChaintracksChainTracker.js:21-56)
 * does NOT call the chaintracks client's `isValidRootForHeight` — it calls
 * `findHeaderForHeight` with its own 6x/250ms retry loop and throws on
 * persistent failure. So passing an offline-first client as
 * `options.chaintracks` alone (what `createServiceOptions`'s
 * `chaintracksOverride` does) never reaches the client's store-first lookup:
 * offline verification burns ~1.5s retrying then throws instead of consulting
 * the local window. This is the seam that actually makes it live — `tracker`
 * already implements `isValidRootForHeight` + `currentHeight`, which is
 * everything the `ChainTracker` interface, and therefore `Beef.verify`, uses.
 *
 * Deliberately does NOT touch `findHeaderForHeight`: WalletContext's own
 * merkle-path service consumes a real header object from it
 * (`r.header = { ...header, height }`), so that must stay pure delegation to
 * the remote client, not a root-only synthetic header.
 */
export function installOfflineChainTracker(services: Services, tracker: ChainTracker): void {
  services.getChainTracker = async () => tracker
}

/**
 * Build the WalletServicesOptions for a given network.
 * Pure function — no React dependencies.
 */
export function createServiceOptions(
  network: AppChain,
  callbackToken: string,
  bsvExchangeRate: BsvExchangeRate,
  arcUrlOverride?: string,
  arcApiKeyOverride?: string,
  /**
   * Substitute for the plain remote chaintracks client. WalletContext passes an
   * OfflineFirstChaintracks wrapping the default, which is what makes BEEF
   * verification work with no network.
   */
  chaintracksOverride?: ChaintracksClientApi
): WalletServicesOptions {
  const walletChain = toWalletChain(network)
  const base = {
    chain: walletChain,
    bsvExchangeRate,
    fiatExchangeRates: {
      timestamp: new Date(),
      base: 'USD' as const,
      rates: { USD: 1 }
    }
  }

  if (network === 'main') {
    return {
      ...base,
      arcUrl: arcUrlOverride ?? process.env?.EXPO_PUBLIC_ARC_URL ?? 'https://arcade-v2-us-1.bsvblockchain.tech',
      arcConfig: {
        apiKey: arcApiKeyOverride ?? process.env?.EXPO_PUBLIC_ARC_API_KEY ?? '',
        callbackToken
      },
      bsvUpdateMsecs: 60 * 60 * 1000,
      fiatUpdateMsecs: 60 * 60 * 1000,
      whatsOnChainApiKey: process.env?.EXPO_PUBLIC_WOC_API_KEY ?? '',
      taalApiKey: process.env?.EXPO_PUBLIC_WOC_API_KEY ?? '',
      chaintracks: chaintracksOverride ?? new ChaintracksServiceClient(walletChain, chaintracksUrlFor(network))
    }
  }

  if (network === 'test') {
    return {
      ...base,
      arcUrl: arcUrlOverride ?? process.env?.EXPO_PUBLIC_TEST_ARC_URL ?? 'https://arcade-v2-testnet-us-1.bsvblockchain.tech',
      arcConfig: {
        apiKey: arcApiKeyOverride ?? process.env?.EXPO_PUBLIC_TEST_ARC_API_KEY ?? '',
        callbackToken
      },
      bsvUpdateMsecs: 60 * 60 * 1000000,
      fiatUpdateMsecs: 60 * 60 * 1000000,
      whatsOnChainApiKey: process.env?.EXPO_PUBLIC_TEST_WOC_API_KEY ?? '',
      taalApiKey: process.env?.EXPO_PUBLIC_TEST_TAAL_API_KEY ?? '',
      chaintracks: chaintracksOverride ?? new ChaintracksServiceClient(walletChain, chaintracksUrlFor(network))
    }
  }

  // teratest
  return {
    ...base,
    arcUrl: arcUrlOverride ?? process.env?.EXPO_PUBLIC_TERATEST_ARC_URL ?? 'https://arcade-v2-ttn-us-1.bsvblockchain.tech',
    arcConfig: {
      apiKey: arcApiKeyOverride ?? process.env?.EXPO_PUBLIC_TERATEST_ARC_API_KEY ?? '',
      callbackToken
    },
    bsvUpdateMsecs: 60 * 60 * 1000000,
    fiatUpdateMsecs: 60 * 60 * 1000000,
    whatsOnChainApiKey: process.env?.EXPO_PUBLIC_TERATEST_WOC_API_KEY ?? '',
    taalApiKey: process.env?.EXPO_PUBLIC_TERATEST_WOC_API_KEY ?? '',
    chaintracks: chaintracksOverride ?? new ChaintracksServiceClient(walletChain, chaintracksUrlFor(network))
  }
}

/**
 * Create a configured Services instance for the given network.
 */
export function createServices(
  network: AppChain,
  callbackToken: string,
  bsvExchangeRate: BsvExchangeRate,
  arcUrlOverride?: string,
  arcApiKeyOverride?: string,
  chaintracksOverride?: ChaintracksClientApi
): { services: Services; serviceOptions: WalletServicesOptions } {
  const serviceOptions = createServiceOptions(
    network,
    callbackToken,
    bsvExchangeRate,
    arcUrlOverride,
    arcApiKeyOverride,
    chaintracksOverride
  )
  const services = new Services(serviceOptions)
  return { services, serviceOptions }
}
