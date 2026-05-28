import type { BsvExchangeRate } from '@bsv/wallet-toolbox-mobile/out/src/sdk'

/**
 * Fetch the current BSV/USD exchange rate from WhatsOnChain.
 * Returns a hardcoded fallback on failure.
 */
export async function getExchangeRate(): Promise<BsvExchangeRate> {
  try {
    const rate = await fetch('https://api.whatsonchain.com/v1/bsv/main/exchangerate')
    const data = await rate.json()
    return {
      timestamp: new Date(),
      rate: data.rate,
      base: 'USD'
    }
  } catch (error) {
    console.error('Error fetching exchange rate:', error)
    return {
      rate: 16.75,
      timestamp: new Date(),
      base: 'USD'
    }
  }
}
