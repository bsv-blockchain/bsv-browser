import { ReactNode, createContext, useEffect, useState } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'

const CACHE_KEY = 'cached_exchange_rate'
const HARDCODED_USD_PER_BSV = 16
const SATS_PER_BSV = 100_000_000

interface ExchangeRateState {
  satoshisPerUSD: number
}

const defaultState: ExchangeRateState = {
  satoshisPerUSD: SATS_PER_BSV / HARDCODED_USD_PER_BSV
}

// Create the exchange rate context and provider to use in the amount component
export const ExchangeRateContext = createContext<ExchangeRateState>(defaultState)

export const ExchangeRateContextProvider: React.FC<{
  children: ReactNode
}> = ({ children }) => {
  const [state, setState] = useState<ExchangeRateState>(defaultState)

  useEffect(() => {
    const init = async () => {
      // Tier 2: Try loading cached rate from AsyncStorage
      try {
        const cached = await AsyncStorage.getItem(CACHE_KEY)
        if (cached) {
          const { usdPerBsv } = JSON.parse(cached)
          if (typeof usdPerBsv === 'number' && usdPerBsv > 0) {
            setState({ satoshisPerUSD: SATS_PER_BSV / usdPerBsv })
          }
        }
      } catch (error) {
        console.error('Error loading cached exchange rate:', error)
      }

      // Tier 1: Attempt live fetch from WhatsonChain
      try {
        const response = await fetch('https://api.whatsonchain.com/v1/bsv/main/exchangerate')
        const data = await response.json()
        const usdPerBsv = data?.rate
        if (typeof usdPerBsv === 'number' && usdPerBsv > 0) {
          setState({ satoshisPerUSD: SATS_PER_BSV / usdPerBsv })
          // Cache the successful result
          await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ usdPerBsv, timestamp: new Date().toISOString() }))
        }
      } catch (error) {
        console.error('Error fetching exchange rate from WhatsonChain:', error)
        // Tier 2/3 already loaded above -- state remains as cached or hardcoded default
      }
    }

    init()
  }, [])

  return <ExchangeRateContext.Provider value={state}>{children}</ExchangeRateContext.Provider>
}
