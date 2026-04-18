import type { AppChain } from '@/context/config'
import {
  ChaintracksServiceClient,
  Services
} from '@bsv/wallet-toolbox-mobile'
import type {
  BsvExchangeRate,
  WalletServicesOptions
} from '@bsv/wallet-toolbox-mobile/out/src/sdk'

/**
 * Build the WalletServicesOptions for a given network.
 * Pure function — no React dependencies.
 */
export function createServiceOptions(
  network: AppChain,
  callbackToken: string,
  bsvExchangeRate: BsvExchangeRate
): WalletServicesOptions {
  const base = {
    chain: network,
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
      arcUrl: process.env?.EXPO_PUBLIC_ARC_URL ?? '',
      arcConfig: {
        apiKey: process.env?.EXPO_PUBLIC_ARC_API_KEY ?? '',
        callbackToken
      },
      bsvUpdateMsecs: 60 * 60 * 1000,
      fiatUpdateMsecs: 60 * 60 * 1000,
      whatsOnChainApiKey: process.env?.EXPO_PUBLIC_WOC_API_KEY ?? '',
      taalApiKey: process.env?.EXPO_PUBLIC_WOC_API_KEY ?? '',
      chaintracks: new ChaintracksServiceClient(
        network,
        process.env?.EXPO_PUBLIC_CHAINTRACKS_URL ?? 'https://chaintracks-us-1.bsvb.tech'
      )
    }
  }

  if (network === 'test') {
    return {
      ...base,
      arcUrl: process.env?.EXPO_PUBLIC_TEST_ARC_URL ?? '',
      arcConfig: {
        apiKey: process.env?.EXPO_PUBLIC_TEST_ARC_API_KEY ?? '',
        callbackToken
      },
      bsvUpdateMsecs: 60 * 60 * 1000000,
      fiatUpdateMsecs: 60 * 60 * 1000000,
      whatsOnChainApiKey: process.env?.EXPO_PUBLIC_TEST_WOC_API_KEY ?? '',
      taalApiKey: process.env?.EXPO_PUBLIC_TEST_TAAL_API_KEY ?? '',
      chaintracks: new ChaintracksServiceClient(
        network,
        process.env?.EXPO_PUBLIC_TEST_CHAINTRACKS_URL ?? 'https://chaintracks-testnet-us-1.bsvb.tech'
      )
    }
  }

  // teratest
  return {
    ...base,
    arcUrl: process.env?.EXPO_PUBLIC_TERATEST_ARC_URL ?? '',
    arcConfig: {
      apiKey: process.env?.EXPO_PUBLIC_TERATEST_ARC_API_KEY ?? '',
      callbackToken
    },
    bsvUpdateMsecs: 60 * 60 * 1000000,
    fiatUpdateMsecs: 60 * 60 * 1000000,
    whatsOnChainApiKey: process.env?.EXPO_PUBLIC_TERATEST_WOC_API_KEY ?? '',
    taalApiKey: process.env?.EXPO_PUBLIC_TERATEST_WOC_API_KEY ?? '',
    chaintracks: new ChaintracksServiceClient(
      network,
      process.env?.EXPO_PUBLIC_TERATEST_CHAINTRACKS_URL ?? 'https://arcade-ttn-us-1.bsvb.tech/chaintracks'
    )
  }
}

/**
 * Create a configured Services instance for the given network.
 */
export function createServices(
  network: AppChain,
  callbackToken: string,
  bsvExchangeRate: BsvExchangeRate
): { services: Services; serviceOptions: WalletServicesOptions } {
  const serviceOptions = createServiceOptions(network, callbackToken, bsvExchangeRate)
  const services = new Services(serviceOptions)
  return { services, serviceOptions }
}
