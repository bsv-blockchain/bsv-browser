import React, { useCallback, useEffect } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { useTheme } from '@/context/theme/ThemeContext'
import { useWallet } from '@/context/WalletContext'
import { sdk } from '@bsv/wallet-toolbox-mobile'
import AmountDisplay from './AmountDisplay'
import AppLogo from './AppLogo'
import AsyncStorage from '@react-native-async-storage/async-storage'

const BALANCE_CACHE_KEY = 'cached_wallet_balance'
const BALANCE_CACHE_TIMESTAMP_KEY = 'cached_wallet_balance_timestamp'
const CACHE_DURATION = 30000 // 30 seconds

export default function Balance() {
  const { colors } = useTheme()
  const { managers, adminOriginator } = useWallet()
  const [accountBalance, setAccountBalance] = React.useState<number | null>(null)
  const [balanceLoading, setBalanceLoading] = React.useState(false)

  // Load cached balance immediately on mount
  useEffect(() => {
    let mounted = true

    const loadCachedBalance = async () => {
      try {
        const [cachedBalance, cachedTimestamp] = await Promise.all([
          AsyncStorage.getItem(BALANCE_CACHE_KEY),
          AsyncStorage.getItem(BALANCE_CACHE_TIMESTAMP_KEY)
        ])

        if (mounted && cachedBalance !== null) {
          const balance = Number(cachedBalance)
          const timestamp = Number(cachedTimestamp)
          const isRecent = timestamp && Date.now() - timestamp < CACHE_DURATION

          setAccountBalance(balance)

          // If cache is old, fetch fresh data
          if (!isRecent) {
            refreshBalance()
          }
        } else if (mounted) {
          // No cache, fetch fresh data
          refreshBalance()
        }
      } catch (error) {
        console.error('Error loading cached balance:', error)
        if (mounted) refreshBalance()
      }
    }

    loadCachedBalance()
    return () => {
      mounted = false
    }
  }, [refreshBalance])

  const refreshBalance = useCallback(async () => {
    try {
      if (!managers?.permissionsManager) {
        return
      }

      // Only show loading if we don't have cached data
      if (accountBalance === null) {
        setBalanceLoading(true)
      }

      // Fetch the first page
      const { totalOutputs } = await managers?.permissionsManager?.listOutputs(
        { basket: sdk.specOpWalletBalance },
        adminOriginator
      )

      const total = totalOutputs ?? 0
      setAccountBalance(total)

      // Cache the new balance
      await Promise.all([
        AsyncStorage.setItem(BALANCE_CACHE_KEY, String(total)),
        AsyncStorage.setItem(BALANCE_CACHE_TIMESTAMP_KEY, String(Date.now()))
      ])

      setBalanceLoading(false)
    } catch (e) {
      console.error('Error refreshing balance:', e)
      setBalanceLoading(false)
    }
  }, [managers, adminOriginator, accountBalance])
  return (
    <View style={[componentStyles.container, { backgroundColor: colors.paperBackground }]}>
      <Text style={[componentStyles.sectionTitle, { color: colors.textPrimary }]}>you have</Text>
      {accountBalance === null && balanceLoading ? (
        <View style={componentStyles.loadingContainer}>
          <AppLogo size={50} rotate />
        </View>
      ) : (
        <Text onPress={refreshBalance} style={[componentStyles.balance, { color: colors.textPrimary }]}>
          <AmountDisplay abbreviate>{accountBalance ?? 0}</AmountDisplay>
          <Text style={[componentStyles.cacheIndicator, { color: colors.textSecondary }]}></Text>
        </Text>
      )}
    </View>
  )
}

const componentStyles = StyleSheet.create({
  container: {
    padding: 16,
    borderRadius: 12
  },
  loadingContainer: {
    alignItems: 'center',
    justifyContent: 'center'
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 16,
    textAlign: 'center'
  },
  balance: {
    fontSize: 30,
    fontWeight: 'bold',
    textAlign: 'center'
  },
  cacheIndicator: {
    fontSize: 16,
    fontWeight: 'normal'
  }
})
