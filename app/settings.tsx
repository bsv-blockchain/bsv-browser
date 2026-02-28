import React, { useState, useEffect, useCallback, useRef } from 'react'
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, typography } from '@/context/theme/tokens'
import { Ionicons } from '@expo/vector-icons'
import { useWallet } from '@/context/WalletContext'
import { useBrowserMode } from '@/context/BrowserModeContext'
import { useLocalStorage } from '@/context/LocalStorageProvider'
import { GroupedSection } from '@/components/ui/GroupedList'
import { ListRow } from '@/components/ui/ListRow'
import { router } from 'expo-router'
import AmountDisplay from '@/components/wallet/AmountDisplay'
import { sdk } from '@bsv/wallet-toolbox-mobile'
import AsyncStorage from '@react-native-async-storage/async-storage'
import Clipboard from '@react-native-clipboard/clipboard'
import packageJson from '@/package.json'

const BALANCE_CACHE_KEY = 'cached_wallet_balance'
const BALANCE_CACHE_TIMESTAMP_KEY = 'cached_wallet_balance_timestamp'
const CACHE_DURATION = 30000

export default function SettingsScreen() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const { managers, adminOriginator, logout, selectedNetwork, switchNetwork } = useWallet()
  const { isWeb2Mode } = useBrowserMode()
  const { getMnemonic } = useLocalStorage()
  const [identityKey, setIdentityKey] = useState('')
  const [copiedKey, setCopiedKey] = useState(false)
  const [copiedMnemonic, setCopiedMnemonic] = useState(false)
  const [accountBalance, setAccountBalance] = useState<number | null>(null)
  const [balanceLoading, setBalanceLoading] = useState(false)
  const [switchingNetwork, setSwitchingNetwork] = useState(false)
  const [networkExpanded, setNetworkExpanded] = useState(false)

  // Fetch identity key
  useEffect(() => {
    managers?.permissionsManager?.getPublicKey({ identityKey: true }, adminOriginator)
      .then(r => r && setIdentityKey(r.publicKey))
  }, [managers, adminOriginator])

  const handleCopyKey = () => {
    if (!identityKey) return
    Clipboard.setString(identityKey)
    setCopiedKey(true)
    setTimeout(() => setCopiedKey(false), 2000)
  }

  const handleCopyMnemonic = async () => {
    try {
      const value = await getMnemonic()
      if (!value) return
      Clipboard.setString(value)
      setCopiedMnemonic(true)
      setTimeout(() => setCopiedMnemonic(false), 2000)
    } catch (error) {
      console.error('Error retrieving mnemonic:', error)
    }
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
    return () => { cancelled = true }
  }, [managers.permissionsManager, refreshBalance])

  const NETWORKS: { id: 'main' | 'test'; label: string; color: string }[] = [
    { id: 'main', label: 'Mainnet', color: colors.success },
    { id: 'test', label: 'Testnet', color: colors.warning },
    // Future: { id: 'teratest', label: 'Teratest', color: colors.info },
  ]

  const handleSelectNetwork = async (target: 'main' | 'test') => {
    if (target === selectedNetwork) {
      setNetworkExpanded(false)
      return
    }
    setNetworkExpanded(false)
    setSwitchingNetwork(true)
    setAccountBalance(null)
    setBalanceLoading(true)
    pendingNetworkRefreshRef.current = true
    await Promise.all([
      AsyncStorage.removeItem(BALANCE_CACHE_KEY),
      AsyncStorage.removeItem(BALANCE_CACHE_TIMESTAMP_KEY),
    ])
    try {
      await switchNetwork(target)
    } catch (e) {
      pendingNetworkRefreshRef.current = false
      console.error('Network switch failed:', e)
    } finally {
      setSwitchingNetwork(false)
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.backgroundSecondary }}>
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
        <GroupedSection header="Wallet">
          {identityKey ? (
            <ListRow
              label="Identity Key"
              icon="finger-print-outline"
              iconColor={colors.identityApproval}
              value={`${identityKey.slice(0, 8)}...${identityKey.slice(-4)}`}
              showChevron={false}
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
            />
          ) : null}
          <ListRow
            label={t('bsv_network')}
            value={switchingNetwork ? 'Switching...' : (NETWORKS.find(n => n.id === selectedNetwork)?.label ?? selectedNetwork)}
            icon="globe-outline"
            iconColor={NETWORKS.find(n => n.id === selectedNetwork)?.color ?? colors.success}
            onPress={isWeb2Mode ? undefined : () => setNetworkExpanded(e => !e)}
            showChevron={networkExpanded}
            chevronDown={networkExpanded}
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
          <ListRow
            label={t('recovery_phrase')}
            icon="key-outline"
            iconColor={colors.fill}
            onPress={handleCopyMnemonic}
            showChevron={false}
            trailing={
              <TouchableOpacity onPress={handleCopyMnemonic} style={{ padding: spacing.xs }}>
                <Ionicons
                  name={copiedMnemonic ? 'checkmark' : 'copy-outline'}
                  size={18}
                  color={copiedMnemonic ? colors.success : colors.textSecondary}
                />
              </TouchableOpacity>
            }
          />
          <ListRow
            label="Transactions"
            icon="receipt-outline"
            iconColor={colors.gold}
            onPress={() => router.push('/transactions')}
            isLast
          />
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

        {/* ── Version ── */}
        <View style={{ alignItems: 'center', paddingTop: spacing.lg }}>
          <Text style={[typography.caption2, { color: colors.textTertiary }]}>
            v{packageJson.version}
          </Text>
        </View>
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

  keyValue: {
    ...typography.body,
    fontFamily: 'monospace',
    maxWidth: 200,
  },
})
