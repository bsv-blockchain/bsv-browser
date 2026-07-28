import React, { useState, useEffect, useCallback } from 'react'
import { View, Text, ScrollView, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, typography } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import { useBrowserMode } from '@/context/BrowserModeContext'
import { GroupedSection } from '@/components/ui/GroupedList'
import { ListRow } from '@/components/ui/ListRow'
import { router } from 'expo-router'
import AmountDisplay from '@/components/wallet/AmountDisplay'
import { sdk } from '@bsv/wallet-toolbox-mobile'
import AsyncStorage from '@react-native-async-storage/async-storage'

const CACHE_DURATION = 30000

export default function SettingsScreen() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const { managers, adminOriginator, selectedNetwork } = useWallet()

  const balanceCacheKey = `cached_wallet_balance_${selectedNetwork}`
  const balanceCacheTimestampKey = `cached_wallet_balance_ts_${selectedNetwork}`
  const { isWeb2Mode } = useBrowserMode()
  const [accountBalance, setAccountBalance] = useState<number | null>(null)
  const [balanceLoading, setBalanceLoading] = useState(false)

  // Fetch wallet balance — keep last known value visible during network switch
  const refreshBalance = useCallback(async () => {
    if (!managers.permissionsManager) return
    try {
      const { totalOutputs } = await managers.permissionsManager.listOutputs(
        { basket: sdk.specOpWalletBalance },
        adminOriginator
      )
      const total = totalOutputs ?? 0
      setAccountBalance(total)
      setBalanceLoading(false)
      await Promise.all([
        AsyncStorage.setItem(balanceCacheKey, String(total)),
        AsyncStorage.setItem(balanceCacheTimestampKey, String(Date.now()))
      ])
    } catch (e) {
      console.error('Error refreshing balance:', e)
      setBalanceLoading(false)
    }
  }, [managers, adminOriginator, balanceCacheKey, balanceCacheTimestampKey])

  useEffect(() => {
    if (!managers.permissionsManager) {
      setAccountBalance(null)
      return
    }

    let cancelled = false
    ;(async () => {
      const [cached, ts] = await Promise.all([
        AsyncStorage.getItem(balanceCacheKey),
        AsyncStorage.getItem(balanceCacheTimestampKey)
      ])
      if (cancelled) return
      if (cached !== null) {
        setAccountBalance(Number(cached))
        if (!ts || Date.now() - Number(ts) > CACHE_DURATION) {
          setBalanceLoading(true)
          refreshBalance()
        }
      } else {
        setBalanceLoading(true)
        refreshBalance()
      }
    })()
    return () => {
      cancelled = true
    }
  }, [managers.permissionsManager, refreshBalance, balanceCacheKey, balanceCacheTimestampKey])

  return (
    <View style={{ backgroundColor: colors.backgroundSecondary }}>
      <ScrollView contentContainerStyle={{ paddingBottom: spacing.xxxl }}>
        {/* ── Balance ── */}
        {!isWeb2Mode && (
          <View style={localStyles.balanceContainer}>
            <Text style={[localStyles.balanceLabel, { color: colors.textSecondary }]}>{t('you_have')}</Text>
            <Text
              onPress={refreshBalance}
              style={[localStyles.balanceAmount, { color: colors.textPrimary, opacity: balanceLoading ? 0.4 : 1 }]}
            >
              {accountBalance !== null ? <AmountDisplay abbreviate>{accountBalance}</AmountDisplay> : '...'}
            </Text>
          </View>
        )}

        {/* ── Activity ── */}
        <GroupedSection header={t('activity')}>
          <ListRow
            label={t('transactions')}
            icon="receipt-outline"
            iconColor="#32ADE6"
            onPress={() => router.push('/transactions')}
          />
          {/* One row for every money path. Direction and counterparty are chosen
              inside /pay, where the transport is inferred rather than picked —
              which is why four rows (and the identity-key QR, now Get paid →
              handle) collapse into this one. */}
          <ListRow
            label={t('pay')}
            icon="swap-horizontal-outline"
            iconColor={colors.success}
            onPress={() => router.push('/pay')}
            isLast
          />
        </GroupedSection>

        {/* ── Settings drill-down ── */}
        <GroupedSection>
          <ListRow
            label={t('settings')}
            icon="settings-outline"
            iconColor="#636366"
            onPress={() => router.push('/wallet-config')}
            isLast
          />
        </GroupedSection>
      </ScrollView>
    </View>
  )
}

const localStyles = StyleSheet.create({
  /* ── Balance ── */
  balanceContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 100,
    paddingHorizontal: spacing.lg
  },
  balanceLabel: {
    ...typography.subhead,
    marginBottom: spacing.xs
  },
  balanceAmount: {
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: 0.4,
    minHeight: 42,
    lineHeight: 42
  }
})
