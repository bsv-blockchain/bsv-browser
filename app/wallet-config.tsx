import React, { useState, useEffect } from 'react'
import { ActivityIndicator, Alert, View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, typography } from '@/context/theme/tokens'
import { Ionicons } from '@expo/vector-icons'
import { useWallet } from '@/context/WalletContext'
import type { AppChain } from '@/context/config'
import { useBrowserMode } from '@/context/BrowserModeContext'
import { useLocalStorage } from '@/context/LocalStorageProvider'
import { GroupedSection } from '@/components/ui/GroupedList'
import { ListRow } from '@/components/ui/ListRow'
import { router } from 'expo-router'
import Clipboard from '@react-native-clipboard/clipboard'
import { exportAllWalletDatabases } from '@/utils/exportDatabases'
import { importWalletDatabase } from '@/utils/importDatabases'
import { recoverMnemonicWallet } from '@/utils/mnemonicWallet'
import { generateBackupShares, generatePrintHTML } from '@/utils/backupShares'
import * as Print from 'expo-print'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

export default function WalletConfigScreen() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const { managers, adminOriginator, logout, selectedNetwork, switchNetwork, rebuildWallet, storage } = useWallet()
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

  // Fetch identity key (needed for print recovery shares)
  useEffect(() => {
    managers?.permissionsManager
      ?.getPublicKey({ identityKey: true }, adminOriginator)
      .then(r => r && setIdentityKey(r.publicKey))
  }, [managers, adminOriginator])

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
        const { PrivateKey } = require('@bsv/sdk')
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
            isLast
          />
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
  }
})
