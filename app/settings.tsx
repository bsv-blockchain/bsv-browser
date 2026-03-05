import React, { useState, useEffect, useCallback, useRef } from 'react'
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, typography } from '@/context/theme/tokens'
import { Ionicons } from '@expo/vector-icons'
import { useWallet } from '@/context/WalletContext'
import { useBrowserMode } from '@/context/BrowserModeContext'
import { GroupedSection } from '@/components/ui/GroupedList'
import { ListRow } from '@/components/ui/ListRow'
import { router } from 'expo-router'
import AmountDisplay from '@/components/wallet/AmountDisplay'
import { sdk } from '@bsv/wallet-toolbox-mobile'
import AsyncStorage from '@react-native-async-storage/async-storage'
import Clipboard from '@react-native-clipboard/clipboard'

const BALANCE_CACHE_KEY = 'cached_wallet_balance'
const BALANCE_CACHE_TIMESTAMP_KEY = 'cached_wallet_balance_timestamp'
const CACHE_DURATION = 30000

export default function SettingsScreen() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const { managers, adminOriginator, selectedNetwork } = useWallet()
  const { isWeb2Mode } = useBrowserMode()
  const [identityKey, setIdentityKey] = useState('')
  const [copiedKey, setCopiedKey] = useState(false)
  const [accountBalance, setAccountBalance] = useState<number | null>(null)
  const [balanceLoading, setBalanceLoading] = useState(false)

  // Fetch identity key
  useEffect(() => {
    managers?.permissionsManager
      ?.getPublicKey({ identityKey: true }, adminOriginator)
      .then(r => r && setIdentityKey(r.publicKey))
  }, [managers, adminOriginator])

  const handleCopyKey = () => {
    if (!identityKey) return
    Clipboard.setString(identityKey)
    setCopiedKey(true)
    setTimeout(() => setCopiedKey(false), 2000)
  }

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
        AsyncStorage.setItem(BALANCE_CACHE_KEY, String(total)),
        AsyncStorage.setItem(BALANCE_CACHE_TIMESTAMP_KEY, String(Date.now()))
      ])
    } catch (e) {
      console.error('Error refreshing balance:', e)
      setBalanceLoading(false)
    }
  }, [managers, adminOriginator])

  // Ref set to true when a network switch is in progress so the effect below
  // skips the cache and fetches fresh once the rebuilt wallet is available.
  const pendingNetworkRefreshRef = useRef(false)

  useEffect(() => {
    if (!managers.permissionsManager) return

    if (pendingNetworkRefreshRef.current) {
      pendingNetworkRefreshRef.current = false
      setBalanceLoading(true)
      const t = setTimeout(refreshBalance, 300)
      return () => clearTimeout(t)
    }

    // Normal mount/manager-change path: consult cache first
    let cancelled = false
    ;(async () => {
      const [cached, ts] = await Promise.all([
        AsyncStorage.getItem(BALANCE_CACHE_KEY),
        AsyncStorage.getItem(BALANCE_CACHE_TIMESTAMP_KEY)
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
  }, [managers.permissionsManager, refreshBalance])

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
          <ListRow
            label={t('payments')}
            icon="people-outline"
            iconColor={colors.success}
            onPress={() => router.push('/payments' as any)}
          />
          <ListRow
            label={t('legacy_bridge')}
            icon="qr-code-outline"
            iconColor="#FF9500"
            onPress={() => router.push('/legacy-payments' as any)}
          />
          {identityKey ? (
            <ListRow
              label={t('identity_key')}
              icon="finger-print-outline"
              iconColor="#5856D6"
              value={`${identityKey.slice(0, 8)}...${identityKey.slice(-4)}`}
              showChevron={false}
              onPress={handleCopyKey}
              trailing={
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Text style={[localStyles.keyValue, { color: colors.textSecondary }]}>
                    {`${identityKey.slice(0, 8)}...${identityKey.slice(-4)}`}
                  </Text>
                  <TouchableOpacity onPress={handleCopyKey} style={{ padding: spacing.xs, marginLeft: spacing.xs }}>
                    <Ionicons
                      name={copiedKey ? 'checkmark' : 'copy-outline'}
                      size={18}
                      color={copiedKey ? colors.success : colors.textSecondary}
                    />
                  </TouchableOpacity>
                </View>
              }
              isLast
            />
          ) : null}
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
  },
  keyValue: {
    ...typography.body,
    fontFamily: 'monospace',
    maxWidth: 200
  }
})
