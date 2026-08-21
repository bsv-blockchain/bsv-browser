/**
 * Pay → a conventional wallet.
 *
 * The one cell whose consequence line is load-bearing: this rail has no
 * notification mechanism at all, so a user who pastes an address expecting
 * messaging-style delivery has effectively posted cash. The line says so, in
 * the same place every time — under the amount, above the button.
 *
 * Form vocabulary comes from PayForm: this file owns only what is
 * address-specific — the address input, its validation, and the send call.
 */
import React, { useCallback, useState } from 'react'
import { Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { StatusBar } from 'expo-status-bar'
import { useTranslation } from 'react-i18next'

import QRScanner from '@/components/QRScanner'
import { ConsequenceNote, PayAmountField, PayCta, PayField } from '@/components/pay/PayForm'
import PaymentSuccessOverlay from '@/components/pay/PaymentSuccessOverlay'
import { showToast } from '@/components/ui/Toast'
import { useTheme } from '@/context/theme/ThemeContext'
import { radii, spacing, typography } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import { CONSEQUENCE_KEYS, isValidBsvAddress, normalizeAddressInput } from '@/utils/pay/rails'
import { sendToAddress } from '@/utils/pay/rails/address'

export default function AddressSend({ initialAddress }: { initialAddress?: string }) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const { managers, adminOriginator } = useWallet()
  const wallet = managers?.permissionsManager || null

  const [address, setAddress] = useState(initialAddress ?? '')
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [scannerVisible, setScannerVisible] = useState(false)
  /** The success moment, held until acknowledged — same screen as every rail. */
  const [sent, setSent] = useState<{ amount: number; recipient: string } | null>(null)

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
      const { paidSatoshis } = await sendToAddress({ wallet: wallet as any, adminOriginator, address, satoshis: sats })
      setSent({ amount: paidSatoshis, recipient: address })
      setAddress('')
      setAmount('')
      setError(null)
    } catch (e: any) {
      showToast(e?.message || t('unknown_error'), { type: 'error' })
    } finally {
      setIsSending(false)
    }
  }, [wallet, adminOriginator, address, amount, t])

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
    >
      <PayField labelKey="recipient_address">
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
          <TouchableOpacity
            onPress={() => setScannerVisible(true)}
            style={styles.inputAction}
            accessibilityLabel={t('scan_qr_code')}
          >
            <Ionicons name="qr-code-outline" size={20} color={colors.accent} />
          </TouchableOpacity>
        </View>
        {error ? <Text style={[styles.fieldError, { color: colors.error }]}>{error}</Text> : null}
      </PayField>

      <PayAmountField value={amount} onChangeText={setAmount} />

      {/* Never implicit. This rail cannot notify the payee. */}
      <ConsequenceNote textKey={CONSEQUENCE_KEYS.address} />

      <PayCta onPress={handleSend} disabled={!canSend} busy={isSending} />

      <Modal
        visible={scannerVisible}
        animationType="slide"
        onRequestClose={() => setScannerVisible(false)}
        statusBarTranslucent
      >
        <StatusBar style="light" />
        <QRScanner
          multiScan
          onScan={onScan}
          onClose={() => setScannerVisible(false)}
          hintText={t('scan_bsv_address_hint')}
        />
      </Modal>

      {sent && (
        <PaymentSuccessOverlay
          direction="sent"
          amount={sent.amount}
          recipientName={sent.recipient}
          onDismiss={() => setSent(null)}
        />
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden'
  },
  input: { ...typography.body, flex: 1, paddingHorizontal: spacing.md, paddingVertical: spacing.md },
  inputAction: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  fieldError: { ...typography.caption1, marginTop: spacing.xs }
})
