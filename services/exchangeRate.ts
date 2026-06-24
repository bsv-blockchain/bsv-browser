import type { BsvExchangeRate } from '@bsv/wallet-toolbox-mobile/out/src/sdk'
import AsyncStorage from '@react-native-async-storage/async-storage'

// Shared with context/ExchangeRateContext.tsx so a single cache serves both the
// fiat-display UI and the wallet-build seed. Same key + same { usdPerBsv } shape.
const CACHE_KEY = 'cached_exchange_rate'
const FALLBACK_RATE = 16.75
const REFRESH_TIMEOUT_MS = 4000

/**
 * Fire-and-forget refresh of the cached BSV/USD rate. Timeout-guarded so it can
 * NEVER hang the JS thread or the wallet build — it is never awaited by callers.
 * The result is only persisted to AsyncStorage for the next cold start.
 */
function refreshExchangeRateCache(): void {
  ;(async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS)
    try {
      const res = await fetch('https://api.whatsonchain.com/v1/bsv/main/exchangerate', {
        signal: controller.signal
      })
      const data = await res.json()
      const usdPerBsv = Number(data?.rate)
      if (Number.isFinite(usdPerBsv) && usdPerBsv > 0) {
        await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ usdPerBsv, timestamp: new Date().toISOString() }))
      }
    } catch (error) {
      console.error('Error refreshing exchange rate:', error)
    } finally {
      clearTimeout(timeout)
    }
  })()
}

/**
 * Return a BSV/USD seed rate for the wallet build WITHOUT blocking on the network.
 *
 * Previously this awaited an un-timed `fetch()` on the wallet-build critical path.
 * With the web3 wallet gate holding the UI until the build resolves, a stalled
 * cold-start network (≈60s NSURLSession timeout) could exceed the iOS launch
 * watchdog and get the whole app killed. The rate only seeds the Services rate
 * cache (refreshed periodically) and feeds fiat display — it is never read by the
 * CWI provider before page JS — so a cached/hardcoded seed is fully correct.
 *
 * Reads the shared cache (one fast AsyncStorage get), falls back to a hardcoded
 * value, and kicks off a background refresh for next time. Never hangs.
 */
export async function getExchangeRate(): Promise<BsvExchangeRate> {
  let rate = FALLBACK_RATE
  try {
    const cached = await AsyncStorage.getItem(CACHE_KEY)
    if (cached) {
      const { usdPerBsv } = JSON.parse(cached)
      if (typeof usdPerBsv === 'number' && usdPerBsv > 0) rate = usdPerBsv
    }
  } catch (error) {
    console.error('Error reading cached exchange rate:', error)
  }
  // Refresh the cache in the background — never awaited, never blocks the build.
  refreshExchangeRateCache()
  return { timestamp: new Date(), rate, base: 'USD' }
}
