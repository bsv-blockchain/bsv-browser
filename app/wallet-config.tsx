import React, { useState, useEffect, useContext, useRef, useCallback } from 'react'
import { ActivityIndicator, Alert, View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, typography } from '@/context/theme/tokens'
import { Ionicons } from '@expo/vector-icons'
import { useWallet } from '@/context/WalletContext'
import type { AppChain } from '@/context/config'
import { useBrowserMode } from '@/context/BrowserModeContext'
import { useLocalStorage } from '@/context/LocalStorageProvider'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { DEFAULT_AUTO_APPROVE_THRESHOLD, AUTO_APPROVE_STORAGE_KEY } from '@/shared/constants'

import { formatAmount, parseDisplayToSatoshis, getUnitLabel } from '@/utils/amountFormatHelpers'
import { ExchangeRateContext } from '@/context/ExchangeRateContext'
import { GroupedSection } from '@/components/ui/GroupedList'
import { ListRow } from '@/components/ui/ListRow'
import { router } from 'expo-router'
import Clipboard from '@react-native-clipboard/clipboard'
import { exportAllWalletDatabases } from '@/utils/exportDatabases'
import { importWalletDatabase } from '@/utils/importDatabases'
import { PrivateKey } from '@bsv/sdk'
import { recoverMnemonicWallet } from '@/utils/mnemonicWallet'
import { generateBackupShares, generatePrintHTML } from '@/utils/backupShares'
import * as Print from 'expo-print'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

export default function WalletConfigScreen() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const {
    managers,
    adminOriginator,
    logout,
    selectedNetwork,
    switchNetwork,
    rebuildWallet,
    storage,
    settings,
    updateSettings
  } = useWallet()
  const { isWeb2Mode } = useBrowserMode()
  const { getMnemonic, getRecoveredKey } = useLocalStorage()
  const insets = useSafeAreaInsets()

  const [identityKey, setIdentityKey] = useState('')
  const [isPrinting, setIsPrinting] = useState(false)
  const [copiedMnemonic, setCopiedMnemonic] = useState(false)
  const [switchingNetwork, setSwitchingNetwork] = useState(false)
  const [networkExpanded, setNetworkExpanded] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [currencyExpanded, setCurrencyExpanded] = useState(false)
  const [thresholdExpanded, setThresholdExpanded] = useState(false)
  const [thresholdSats, setThresholdSats] = useState(DEFAULT_AUTO_APPROVE_THRESHOLD)
  const [thresholdInput, setThresholdInput] = useState('')
  const { satoshisPerUSD } = useContext(ExchangeRateContext)

  const currentCurrency = settings?.currency || 'BSV'

  // Load persisted auto-approve threshold
  useEffect(() => {
    AsyncStorage.getItem(AUTO_APPROVE_STORAGE_KEY).then(v => {
      if (v !== null) setThresholdSats(Number(v) || 0)
    })
  }, [])

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleThresholdInput = useCallback((text: string) => {
    setThresholdInput(text)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      const sats = parseDisplayToSatoshis(text, currentCurrency, satoshisPerUSD)
      const clamped = Math.max(0, Math.round(sats))
      setThresholdSats(clamped)
      AsyncStorage.setItem(AUTO_APPROVE_STORAGE_KEY, String(clamped))
    }, 600)
  }, [currentCurrency, satoshisPerUSD])

  // Fetch identity key (needed for print recovery shares)
  useEffect(() => {
    managers?.permissionsManager
      ?.getPublicKey({ identityKey: true }, adminOriginator)
      .then(r => r && setIdentityKey(r.publicKey))
  }, [managers, adminOriginator])

  const handleCopyMnemonic = async () => {
    try {
      // Copy mnemonic if available, otherwise fall back to primary key hex
      const mnemonic = await getMnemonic()
      if (mnemonic) {
        Clipboard.setString(mnemonic)
      } else {
        const wif = await getRecoveredKey()
        if (!wif) return
        Clipboard.setString(PrivateKey.fromWif(wif).toHex())
      }
      setCopiedMnemonic(true)
      setTimeout(() => setCopiedMnemonic(false), 2000)
    } catch (error) {
      console.error('Error retrieving recovery key:', error)
    }
  }

  const handlePrintRecoveryShares = async () => {
    if (isPrinting) return
    setIsPrinting(true)
    try {
      let primaryKeyBytes: number[] | null = null

      // Try mnemonic-based key first
      const mnemonic = await getMnemonic()
      if (mnemonic) {
        const { primaryKey } = recoverMnemonicWallet(mnemonic)
        primaryKeyBytes = primaryKey
      } else {
        // Fall back to recovered key
        const wif = await getRecoveredKey()
        if (wif) {
          primaryKeyBytes = PrivateKey.fromWif(wif).toArray()
        }
      }

      if (!primaryKeyBytes) {
        Alert.alert('Error', 'Unable to access wallet key. Please authenticate and try again.')
        return
      }

      const shares = generateBackupShares(primaryKeyBytes)
      const html = await generatePrintHTML(shares, identityKey)
      await Print.printAsync({ html })
    } catch (error: any) {
      console.info('[WalletConfig] Print recovery shares did not complete:', error?.message)
    } finally {
      setIsPrinting(false)
    }
  }

  const handleExportData = async () => {
    if (isExporting) return
    setIsExporting(true)
    try {
      await exportAllWalletDatabases(storage)
    } catch (e) {
      console.warn('[WalletConfig] Export failed:', e)
    } finally {
      setIsExporting(false)
    }
  }

  const handleImportData = async () => {
    if (isImporting) return
    setIsImporting(true)
    try {
      const result = await importWalletDatabase(storage)
      if (result.imported) {
        Alert.alert(t('import_confirm_title'), t('import_success'))
        await rebuildWallet()
      }
    } catch (e) {
      console.warn('[WalletConfig] Import failed:', e)
    } finally {
      setIsImporting(false)
    }
  }

  const CURRENCIES: { id: string; label: string; icon: string }[] = [
    { id: 'BSV', label: 'BSV', icon: 'logo-bitcoin' },
    { id: 'USD', label: 'USD', icon: 'cash-outline' }
  ]

  const handleSelectCurrency = async (target: string) => {
    if (target === currentCurrency) {
      setCurrencyExpanded(false)
      return
    }
    setCurrencyExpanded(false)
    try {
      await updateSettings({ ...settings!, currency: target })
    } catch (e) {
      console.error('Currency switch failed:', e)
    }
  }

  const NETWORKS: { id: AppChain; label: string; color: string }[] = [
    { id: 'main', label: t('mainnet'), color: colors.success },
    { id: 'test', label: t('testnet'), color: colors.warning },
    { id: 'teratest', label: t('teratest'), color: colors.info }
  ]

  const handleSelectNetwork = async (target: AppChain) => {
    if (target === selectedNetwork) {
      setNetworkExpanded(false)
      return
    }
    setNetworkExpanded(false)
    setSwitchingNetwork(true)
    try {
      await switchNetwork(target)
    } catch (e) {
      console.error('Network switch failed:', e)
    } finally {
      setSwitchingNetwork(false)
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }}>
      {/* Header */}
      <View style={[localStyles.header, { borderBottomColor: colors.separator }]}>
        <TouchableOpacity onPress={() => router.back()} style={localStyles.headerBack}>
          <Ionicons name="chevron-back" size={24} color={colors.accent} />
        </TouchableOpacity>
        <Text style={[localStyles.headerTitle, { color: colors.textPrimary }]}>{t('settings')}</Text>
        <View style={localStyles.headerBack} />
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: spacing.lg, paddingBottom: spacing.xxxl }}>
        {/* ── Configuration ── */}
        <GroupedSection header={t('configuration')}>
          <ListRow
            label={t('bsv_network')}
            value={
              switchingNetwork
                ? t('switching')
                : (NETWORKS.find(n => n.id === selectedNetwork)?.label ?? selectedNetwork)
            }
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
                    <Text style={[localStyles.networkLabel, { color: colors.textPrimary }]}>{net.label}</Text>
                    {isActive && (
                      <Ionicons name="checkmark" size={20} color={colors.accent} style={{ marginLeft: 'auto' }} />
                    )}
                  </TouchableOpacity>
                )
              })}
            </View>
          )}
          <ListRow
            label={t('trust_network')}
            icon="shield-checkmark-outline"
            iconColor="#BF5AF2"
            onPress={() => router.push('/trust' as any)}
          />
          <ListRow
            label={t('display_currency')}
            value={CURRENCIES.find(c => c.id === currentCurrency)?.label ?? currentCurrency}
            icon="cash-outline"
            iconColor="#00C7BE"
            onPress={() => setCurrencyExpanded(e => !e)}
            showChevron={currencyExpanded}
            chevronDown={currencyExpanded}
          />
          {currencyExpanded && (
            <View style={localStyles.networkList}>
              {CURRENCIES.map(cur => {
                const isActive = cur.id === currentCurrency
                return (
                  <TouchableOpacity
                    key={cur.id}
                    style={localStyles.networkOption}
                    onPress={() => handleSelectCurrency(cur.id)}
                    activeOpacity={0.6}
                  >
                    <Ionicons
                      name={cur.icon as any}
                      size={16}
                      color={colors.textSecondary}
                      style={{ marginRight: spacing.md }}
                    />
                    <Text style={[localStyles.networkLabel, { color: colors.textPrimary }]}>{cur.label}</Text>
                    {isActive && (
                      <Ionicons name="checkmark" size={20} color={colors.accent} style={{ marginLeft: 'auto' }} />
                    )}
                  </TouchableOpacity>
                )
              })}
            </View>
          )}
          <ListRow
            label="Auto Spend Up To"
            value={thresholdSats === 0 ? 'Off'
              : currentCurrency === 'USD' && satoshisPerUSD > 0
                ? `$${(thresholdSats / satoshisPerUSD).toFixed(2)}`
                : formatAmount(thresholdSats, currentCurrency, satoshisPerUSD)}
            icon="flash-outline"
            iconColor="#FF9F0A"
            onPress={() => {
              setThresholdExpanded(e => !e)
              if (!thresholdExpanded) {
                // Pre-fill input with current value in display currency
                if (currentCurrency === 'USD' && satoshisPerUSD > 0) {
                  setThresholdInput(thresholdSats === 0 ? '0' : (thresholdSats / satoshisPerUSD).toFixed(2))
                } else {
                  setThresholdInput(String(thresholdSats))
                }
              }
            }}
            showChevron={thresholdExpanded}
            chevronDown={thresholdExpanded}
            isLast={!thresholdExpanded}
          />
          {thresholdExpanded && (
            <View style={localStyles.networkList}>
              <View style={localStyles.thresholdRow}>
                <TextInput
                  style={[localStyles.thresholdInput, { color: colors.textPrimary, borderColor: colors.separator }]}
                  value={thresholdInput}
                  onChangeText={handleThresholdInput}
                  keyboardType="numeric"
                  placeholder={`0 ${getUnitLabel(currentCurrency)}`}
                  placeholderTextColor={colors.textSecondary}
                  returnKeyType="done"
                />
                <Text style={[localStyles.thresholdUnit, { color: colors.textSecondary }]}>
                  {getUnitLabel(currentCurrency)}
                </Text>
              </View>
            </View>
          )}
        </GroupedSection>

        {/* ── Data & Security ── */}
        <GroupedSection header={t('data_and_security')}>
          <ListRow
            label={t('recovery_phrase')}
            icon="key-outline"
            iconColor="#CC8400"
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
            label={t('print_recovery_shares')}
            icon="print-outline"
            iconColor="#5856D6"
            onPress={handlePrintRecoveryShares}
            showChevron={false}
            trailing={isPrinting ? <ActivityIndicator size="small" /> : undefined}
          />
          <ListRow
            label={t('export_wallet_data')}
            icon="share-outline"
            iconColor="#32ADE6"
            onPress={handleExportData}
            showChevron={false}
            trailing={isExporting ? <ActivityIndicator size="small" /> : undefined}
          />
          <ListRow
            label={t('import_wallet_data')}
            icon="download-outline"
            iconColor="#30D158"
            onPress={handleImportData}
            showChevron={false}
            trailing={isImporting ? <ActivityIndicator size="small" /> : undefined}
          />
          <ListRow
            label="Debugging"
            icon="terminal-outline"
            iconColor="#8E8E93"
            onPress={() => router.push('/logs' as any)}
            isLast
          />
        </GroupedSection>

        {/* ── Account ── */}
        <GroupedSection>
          <ListRow
            label={t('delete_wallet')}
            icon="trash-outline"
            iconColor={colors.error}
            onPress={() =>
              Alert.alert(t('delete_wallet_warning_title'), t('delete_wallet_warning_body'), [
                { text: t('cancel'), style: 'cancel' },
                { text: t('delete_wallet_confirm'), style: 'destructive', onPress: logout }
              ])
            }
            destructive
            showChevron={false}
            isLast
          />
        </GroupedSection>
      </ScrollView>
    </View>
  )
}

const localStyles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  headerBack: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center'
  },
  headerTitle: {
    ...typography.headline,
    fontWeight: '600'
  },
  networkList: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm
  },
  networkOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm
  },
  networkDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: spacing.md
  },
  networkLabel: {
    ...typography.body
  },
  thresholdRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm
  },
  thresholdInput: {
    flex: 1,
    ...typography.body,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  thresholdUnit: {
    ...typography.body,
    marginLeft: spacing.sm
  }
})
