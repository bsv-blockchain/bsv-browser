import React, { useState, useEffect, useCallback } from 'react'
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Modal, Pressable } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, typography, radii } from '@/context/theme/tokens'
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
import QRCode from 'react-native-qrcode-svg'

const CACHE_DURATION = 30000

export default function SettingsScreen() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const { managers, adminOriginator, selectedNetwork } = useWallet()

  const balanceCacheKey = `cached_wallet_balance_${selectedNetwork}`
  const balanceCacheTimestampKey = `cached_wallet_balance_ts_${selectedNetwork}`
  const { isWeb2Mode } = useBrowserMode()
  const [identityKey, setIdentityKey] = useState('')
  const [copiedKey, setCopiedKey] = useState(false)
  const [showQr, setShowQr] = useState(false)
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
              showChevron={false}
              onPress={handleCopyKey}
              trailing={
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <TouchableOpacity onPress={handleCopyKey} style={{ padding: spacing.xs, marginLeft: spacing.xs }}>
                    <Ionicons
                      name={copiedKey ? 'checkmark' : 'copy-outline'}
                      size={18}
                      color={copiedKey ? colors.success : colors.textSecondary}
                    />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => setShowQr(true)}
                    style={{ padding: spacing.xs, marginLeft: spacing.xs }}
                    accessibilityLabel={t('identity_key')}
                  >
                    <Ionicons name="qr-code-outline" size={18} color={colors.textSecondary} />
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

      {/* ── Identity Key QR popover ── */}
      <Modal visible={showQr} transparent animationType="fade" onRequestClose={() => setShowQr(false)}>
        <Pressable style={localStyles.qrBackdrop} onPress={() => setShowQr(false)}>
          <Pressable style={[localStyles.qrPopover, { backgroundColor: colors.backgroundElevated }]} onPress={() => {}}>
            <View style={localStyles.qrPopoverHeader}>
              <Text style={[localStyles.qrPopoverTitle, { color: colors.textPrimary }]}>{t('identity_key')}</Text>
              <TouchableOpacity
                onPress={() => setShowQr(false)}
                style={localStyles.qrCloseBtn}
                accessibilityLabel={t('go_back')}
              >
                <Ionicons name="close" size={20} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
            <View style={localStyles.qrCard}>
              <QRCode value={identityKey} size={260} color="#000" backgroundColor="#fff" />
            </View>
            <Text
              style={[localStyles.qrKeyLabel, { color: colors.textSecondary }]}
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {identityKey}
            </Text>
          </Pressable>
        </Pressable>
      </Modal>
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

  /* ── QR popover ── */
  qrBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xxxl
  },
  qrPopover: {
    width: '100%',
    maxWidth: 360,
    borderRadius: radii.xl,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 12
  },
  qrPopoverHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: spacing.lg,
    paddingBottom: spacing.md
  },
  qrPopoverTitle: {
    ...typography.headline,
    fontWeight: '600'
  },
  qrCloseBtn: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center'
  },
  qrCard: {
    alignItems: 'center',
    marginVertical: spacing.md,
    padding: spacing.lg,
    borderRadius: radii.lg,
    backgroundColor: '#fff',
    alignSelf: 'center',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 4
  },
  qrKeyLabel: {
    ...typography.caption1,
    fontFamily: 'monospace',
    textAlign: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.xs
  }
})
