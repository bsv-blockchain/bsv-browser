/**
 * Pay → a conventional wallet.
 *
 * The one cell whose consequence line is load-bearing: this rail has no
 * notification mechanism at all, so a user who pastes an address expecting
 * messaging-style delivery has effectively posted cash. The line says so, in
 * the same place every time — under the amount, above the button.
 */
import React, { useCallback, useContext, useState } from 'react'
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { StatusBar } from 'expo-status-bar'
import { useTranslation } from 'react-i18next'

import QRScanner from '@/components/QRScanner'
import { AmountInput } from '@/components/wallet/AmountInput'
import PressableScale from '@/components/ui/PressableScale'
import { showToast } from '@/components/ui/Toast'
import { useTheme } from '@/context/theme/ThemeContext'
import { radii, spacing, typography } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import { ExchangeRateContext } from '@/context/ExchangeRateContext'
import { formatAmount } from '@/utils/amountFormatHelpers'
import { CONSEQUENCE_KEYS, isValidBsvAddress, normalizeAddressInput } from '@/utils/pay/rails'
import { sendToAddress } from '@/utils/pay/rails/address'

export default function AddressSend({ initialAddress }: { initialAddress?: string }) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const { managers, adminOriginator, settings } = useWallet()
  const wallet = managers?.permissionsManager || null
  const { satoshisPerUSD } = useContext(ExchangeRateContext)
  const currency = settings?.currency || 'BSV'

  const [address, setAddress] = useState(initialAddress ?? '')
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [scannerVisible, setScannerVisible] = useState(false)

  const onChangeAddress = useCallback(
    (text: string) => {
      setAddress(text)
      setError(text.length === 0 || isValidBsvAddress(text) ? null : t('invalid_bsv_address'))
    },
    [t]
  )

  const onScan = useCallback((data: string) => {
    const raw = normalizeAddressInput(data)
    if (!isValidBsvAddress(raw)) return // QRScanner auto-retries
    setAddress(raw)
    setError(null)
    setScannerVisible(false)
  }, [])

  const canSend = !!address && !!amount && !error && !isSending && Number(amount) > 0

  const handleSend = useCallback(async () => {
    if (!wallet) return
    const sats = Math.round(Number(amount))
    setIsSending(true)
    try {
      await sendToAddress({ wallet: wallet as any, adminOriginator, address, satoshis: sats })
      showToast(`${t('paid')} ${formatAmount(sats, currency, satoshisPerUSD)}`, { type: 'success' })
      setAddress('')
      setAmount('')
      setError(null)
    } catch (e: any) {
      showToast(e?.message || t('unknown_error'), { type: 'error' })
    } finally {
      setIsSending(false)
    }
  }, [wallet, adminOriginator, address, amount, currency, satoshisPerUSD, t])

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
      <View style={styles.fieldGroup}>
        <Text style={[styles.fieldLabel, { color: colors.textTertiary }]}>{t('recipient_address').toUpperCase()}</Text>
        <View
          style={[
            styles.inputRow,
            { backgroundColor: colors.backgroundSecondary, borderColor: error ? colors.error : colors.separator }
          ]}
        >
          <TextInput
            value={address}
            onChangeText={onChangeAddress}
            placeholder={t('enter_bsv_address')}
            placeholderTextColor={colors.textQuaternary}
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.input, { color: colors.textPrimary }]}
          />
          <TouchableOpacity onPress={() => setScannerVisible(true)} style={styles.inputAction} accessibilityLabel={t('scan_qr_code')}>
            <Ionicons name="qr-code-outline" size={20} color={colors.accent} />
          </TouchableOpacity>
        </View>
        {error ? <Text style={[styles.fieldError, { color: colors.error }]}>{error}</Text> : null}
      </View>

      <View style={styles.fieldGroup}>
        <Text style={[styles.fieldLabel, { color: colors.textTertiary }]}>{t('amount').toUpperCase()}</Text>
        <AmountInput value={amount} onChangeText={setAmount} />
      </View>

      {/* Never implicit. This rail cannot notify the payee. */}
      <View style={[styles.consequence, { backgroundColor: colors.fillTertiary, borderColor: colors.separator }]}>
        <Ionicons name="information-circle-outline" size={16} color={colors.textSecondary} />
        <Text style={[styles.consequenceText, { color: colors.textSecondary }]}>{t(CONSEQUENCE_KEYS.address)}</Text>
      </View>

      <PressableScale
        onPress={handleSend}
        disabled={!canSend}
        haptic="confirm"
        style={[styles.cta, { backgroundColor: canSend ? colors.accent : colors.fill }]}
        accessibilityRole="button"
        accessibilityLabel={t('pay')}
        accessibilityState={{ disabled: !canSend }}
      >
        {isSending ? (
          <ActivityIndicator size="small" color={canSend ? colors.background : colors.textTertiary} />
        ) : (
          <>
            <Ionicons name="arrow-up" size={20} color={canSend ? colors.textOnAccent : colors.textTertiary} />
            <Text style={[styles.ctaText, { color: canSend ? colors.textOnAccent : colors.textTertiary }]}>
              {t('pay')}
            </Text>
          </>
        )}
      </PressableScale>

      <Modal visible={scannerVisible} animationType="slide" onRequestClose={() => setScannerVisible(false)} statusBarTranslucent>
        <StatusBar style="light" />
        <QRScanner multiScan onScan={onScan} onClose={() => setScannerVisible(false)} hintText={t('scan_bsv_address_hint')} />
      </Modal>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  fieldGroup: { marginBottom: spacing.xl },
  fieldLabel: { ...typography.caption2, fontWeight: '600', letterSpacing: 0.8, marginBottom: spacing.sm },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden'
  },
  input: { ...typography.body, flex: 1, paddingHorizontal: spacing.md, paddingVertical: spacing.md },
  inputAction: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  fieldError: { ...typography.caption1, marginTop: spacing.xs },
  consequence: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.lg
  },
  consequenceText: { ...typography.footnote, flex: 1 },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md + 2,
    borderRadius: radii.md
  },
  ctaText: { ...typography.subhead, fontWeight: '600' }
})
