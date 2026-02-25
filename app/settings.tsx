import React, { useState, useEffect, useCallback } from 'react'
import { View, Text, TouchableOpacity, ScrollView, Alert, StyleSheet } from 'react-native'
import CustomSafeArea from '@/components/CustomSafeArea'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { Ionicons } from '@expo/vector-icons'
import { useWallet } from '@/context/WalletContext'
import { useBrowserMode } from '@/context/BrowserModeContext'
import { useLocalStorage } from '@/context/LocalStorageProvider'
import { GroupedSection } from '@/components/ui/GroupedList'
import { ListRow } from '@/components/ui/ListRow'
import AmountDisplay from '@/components/AmountDisplay'
import { sdk } from '@bsv/wallet-toolbox-mobile'
import AsyncStorage from '@react-native-async-storage/async-storage'

const BALANCE_CACHE_KEY = 'cached_wallet_balance'
const BALANCE_CACHE_TIMESTAMP_KEY = 'cached_wallet_balance_timestamp'
const CACHE_DURATION = 30000

export default function SettingsScreen() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const { managers, adminOriginator, updateSettings, settings, logout, selectedNetwork, switchNetwork } = useWallet()
  const { isWeb2Mode } = useBrowserMode()
  const { getMnemonic } = useLocalStorage()
  const [showMnemonic, setShowMnemonic] = useState(false)
  const [mnemonic, setMnemonic] = useState<string | null>(null)
  const [accountBalance, setAccountBalance] = useState<number | null>(null)
  const [balanceLoading, setBalanceLoading] = useState(false)
  const [switchingNetwork, setSwitchingNetwork] = useState(false)
  const [networkExpanded, setNetworkExpanded] = useState(false)

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

  // Load cached balance on mount, refresh when managers change (e.g. after network switch)
  useEffect(() => {
    let mounted = true
    ;(async () => {
      const [cached, ts] = await Promise.all([
        AsyncStorage.getItem(BALANCE_CACHE_KEY),
        AsyncStorage.getItem(BALANCE_CACHE_TIMESTAMP_KEY)
      ])
      if (!mounted) return
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
    return () => { mounted = false }
  }, [managers.permissionsManager]) // eslint-disable-line react-hooks/exhaustive-deps

  const NETWORKS: { id: 'main' | 'test'; label: string; color: string }[] = [
    { id: 'main', label: 'Mainnet', color: colors.success },
    { id: 'test', label: 'Testnet', color: colors.warning },
    // Future: { id: 'teratest', label: 'Teratest', color: colors.info },
  ]

  const handleSelectNetwork = (target: 'main' | 'test') => {
    if (target === selectedNetwork) {
      setNetworkExpanded(false)
      return
    }
    const label = NETWORKS.find(n => n.id === target)?.label ?? target
    Alert.alert(
      'Switch Network',
      `Switch to ${label}? Your wallet will be rebuilt with a separate database.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: `Switch to ${label}`,
          onPress: async () => {
            setNetworkExpanded(false)
            setSwitchingNetwork(true)
            try {
              await switchNetwork(target)
            } catch (e) {
              console.error('Network switch failed:', e)
              Alert.alert('Error', 'Failed to switch network. Please try again.')
            } finally {
              setSwitchingNetwork(false)
            }
          }
        }
      ]
    )
  }

  // Handle showing mnemonic with confirmation
  const handleShowMnemonic = async () => {
    Alert.alert(
      t('show_recovery_phrase'),
      t('recovery_phrase_warning'),
      [
        {
          text: t('cancel'),
          style: 'cancel'
        },
        {
          text: t('show'),
          style: 'destructive',
          onPress: async () => {
            try {
              const mnemonicValue = await getMnemonic()
              if (mnemonicValue) {
                setMnemonic(mnemonicValue)
                setShowMnemonic(true)
              } else {
                Alert.alert(t('error'), t('no_recovery_phrase_found'))
              }
            } catch (error) {
              console.error('Error retrieving mnemonic:', error)
              Alert.alert(t('error'), t('failed_to_retrieve_recovery_phrase'))
            }
          }
        }
      ]
    )
  }

  // Handle hiding mnemonic
  const handleHideMnemonic = () => {
    setShowMnemonic(false)
    setMnemonic(null)
  }

  return (
    <CustomSafeArea style={{ flex: 1, backgroundColor: colors.backgroundSecondary }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: spacing.xl, paddingBottom: spacing.xxxl }}
      >
        {/* ── Balance ── */}
        {!isWeb2Mode && (
          <View style={localStyles.balanceContainer}>
            <Text style={[localStyles.balanceLabel, { color: colors.textSecondary }]}>
              you have
            </Text>
            <Text
              onPress={refreshBalance}
              style={[
                localStyles.balanceAmount,
                { color: colors.textPrimary, opacity: balanceLoading ? 0.4 : 1 }
              ]}
            >
              {accountBalance !== null ? (
                <AmountDisplay abbreviate>{accountBalance}</AmountDisplay>
              ) : '...'}
            </Text>
          </View>
        )}

        {/* ── Wallet ── */}
        <GroupedSection header="Wallet" footer="Each network uses its own separate on-device database.">
          <ListRow
            label={t('bsv_network')}
            value={switchingNetwork ? 'Switching...' : (NETWORKS.find(n => n.id === selectedNetwork)?.label ?? selectedNetwork)}
            icon="server-outline"
            iconColor={NETWORKS.find(n => n.id === selectedNetwork)?.color ?? colors.success}
            onPress={isWeb2Mode ? undefined : () => setNetworkExpanded(e => !e)}
            showChevron={!isWeb2Mode}
          />
          {networkExpanded && !isWeb2Mode && (
            <View style={localStyles.networkList}>
              {NETWORKS.map(net => {
                const isActive = net.id === selectedNetwork
                return (
                  <TouchableOpacity
                    key={net.id}
                    style={localStyles.networkOption}
                    onPress={() => handleSelectNetwork(net.id)}
                    activeOpacity={0.6}
                  >
                    <View style={[localStyles.networkDot, { backgroundColor: net.color }]} />
                    <Text style={[localStyles.networkLabel, { color: colors.textPrimary }]}>
                      {net.label}
                    </Text>
                    {isActive && (
                      <Ionicons name="checkmark" size={20} color={colors.accent} style={{ marginLeft: 'auto' }} />
                    )}
                  </TouchableOpacity>
                )
              })}
            </View>
          )}
          {!showMnemonic ? (
            <ListRow
              label={t('recovery_phrase')}
              icon="key-outline"
              iconColor={colors.accentSecondary}
              onPress={handleShowMnemonic}
              isLast
            />
          ) : (
            <View style={localStyles.mnemonicSection}>
              {/* Mnemonic Display */}
              <View
                style={[
                  localStyles.mnemonicBox,
                  {
                    backgroundColor: colors.fillTertiary,
                    borderColor: colors.accentSecondary,
                  }
                ]}
              >
                <Text
                  style={[
                    localStyles.mnemonicText,
                    { color: colors.textPrimary }
                  ]}
                  selectable
                >
                  {mnemonic}
                </Text>
              </View>

              {/* Warning Message */}
              <View
                style={[
                  localStyles.warningBox,
                  { backgroundColor: colors.error + '10' }
                ]}
              >
                <Ionicons
                  name="warning-outline"
                  size={18}
                  color={colors.error}
                  style={{ marginRight: spacing.sm }}
                />
                <Text style={[localStyles.warningText, { color: colors.textSecondary }]}>
                  {t('recovery_phrase_security_warning')}
                </Text>
              </View>

              {/* Hide Button */}
              <TouchableOpacity
                style={[
                  localStyles.hideButton,
                  { backgroundColor: colors.fillTertiary }
                ]}
                onPress={handleHideMnemonic}
              >
                <Ionicons
                  name="eye-off-outline"
                  size={18}
                  color={colors.textPrimary}
                  style={{ marginRight: spacing.sm }}
                />
                <Text style={[localStyles.hideButtonText, { color: colors.textPrimary }]}>
                  {t('hide_recovery_phrase')}
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </GroupedSection>

        {/* ── Account ── */}
        <GroupedSection>
          <ListRow
            label={t('logout')}
            icon="log-out-outline"
            iconColor={colors.error}
            onPress={logout}
            destructive
            showChevron={false}
            isLast
          />
        </GroupedSection>
      </ScrollView>
    </CustomSafeArea>
  )
}

const localStyles = StyleSheet.create({
  /* ── Balance ── */
  balanceContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 100,
    paddingHorizontal: spacing.lg,
  },
  balanceLabel: {
    ...typography.subhead,
    marginBottom: spacing.xs,
  },
  balanceAmount: {
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: 0.4,
    minHeight: 42,
    lineHeight: 42,
  },

  /* ── Network picker ── */
  networkList: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  networkOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
  },
  networkDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: spacing.md,
  },
  networkLabel: {
    ...typography.body,
  },

  /* ── Mnemonic reveal ── */
  mnemonicSection: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
  },
  mnemonicBox: {
    padding: spacing.lg,
    borderRadius: radii.sm,
    borderWidth: 1.5,
    marginBottom: spacing.md,
  },
  mnemonicText: {
    ...typography.callout,
    fontFamily: 'monospace',
    lineHeight: 22,
    textAlign: 'center',
  },
  warningBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: spacing.md,
    borderRadius: radii.sm,
    marginBottom: spacing.md,
  },
  warningText: {
    ...typography.footnote,
    flex: 1,
  },
  hideButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    borderRadius: radii.sm,
  },
  hideButtonText: {
    ...typography.subhead,
    fontWeight: '500',
  },
})
