/**
 * Pay → someone with this app.
 *
 * The recipient is a handle (an identity key, reached by search, scan or deep
 * link) and delivery is asynchronous: the token is dropped in their MessageBox
 * and lands when their wallet next checks. That is exactly what the consequence
 * line under the button says, and why it says it before the send rather than
 * after.
 */
import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { StatusBar } from 'expo-status-bar'
import { useTranslation } from 'react-i18next'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { PeerPayClient } from '@bsv/message-box-client'

import QRScanner from '@/components/QRScanner'
import { AmountInput } from '@/components/wallet/AmountInput'
import AmountDisplay from '@/components/wallet/AmountDisplay'
import Celebration from '@/components/ui/Celebration'
import PressableScale from '@/components/ui/PressableScale'
import { showToast } from '@/components/ui/Toast'
import ResultBanner from '@/components/pay/ResultBanner'
import RecipientField from '@/components/pay/RecipientField'
import { ConfigPanel, MessageBoxBar, useMessageBoxConfig } from '@/components/pay/MessageBoxConfig'
import { useIdentitySearch } from '@/components/pay/useIdentitySearch'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, typography, radii } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import { ExchangeRateContext } from '@/context/ExchangeRateContext'
import { formatAmount } from '@/utils/amountFormatHelpers'
import { CONSEQUENCE_KEYS } from '@/utils/pay/rails'
import { NO_MESSAGE_BOX, retryDelivery, sendViaHandle } from '@/utils/pay/rails/handle'
import { getOutboxEntries, removeOutboxEntry, type OutboxEntry } from '@/utils/peerpay/outbox'
import { haptics } from '@/hooks/useHaptics'

const FIRST_PAYMENT_KEY = 'hasSentFirstPayment'

// ── Outgoing Section ─────────────────────────────────────────────────────────

interface OutgoingSectionProps {
  readonly entries: OutboxEntry[]
  readonly retryingId: string | null
  readonly colors: ReturnType<typeof import('@/context/theme/ThemeContext').useTheme>['colors']
  readonly t: ReturnType<typeof import('react-i18next').useTranslation>['t']
  readonly onRetry: (entry: OutboxEntry) => void
  readonly onDismiss: (id: string) => void
}

function OutgoingSection({ entries, retryingId, colors, t, onRetry, onDismiss }: OutgoingSectionProps) {
  if (entries.length === 0) return null

  return (
    <>
      <Text style={[styles.fieldLabel, { color: colors.textSecondary, marginBottom: spacing.sm }]}>
        {t('outgoing_payments')}
      </Text>
      <View style={[styles.outgoingCard, { backgroundColor: colors.background, borderColor: colors.separator }]}>
        {entries.map((entry, idx) => {
          const isSent = entry.status === 'sent'
          const isRetrying = retryingId === entry.id
          const isLast = idx === entries.length - 1
          const accentColor = isSent ? colors.success : colors.warning
          const truncated = `${entry.recipient.slice(0, 8)}…${entry.recipient.slice(-4)}`
          return (
            <View
              key={entry.id}
              style={[
                styles.outgoingRow,
                { borderLeftColor: accentColor },
                !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }
              ]}
            >
              {/* Top row: recipient key + amount */}
              <View style={styles.outgoingInfo}>
                <View style={styles.outgoingTopRow}>
                  <Text style={[styles.outgoingRecipient, { color: colors.textPrimary }]} numberOfLines={1}>
                    {truncated}
                  </Text>
                  <Text style={[styles.outgoingAmount, { color: accentColor }]}>
                    <AmountDisplay>{entry.token.amount}</AmountDisplay>
                  </Text>
                </View>

                {/* Status / error text */}
                <Text
                  style={[styles.outgoingStatusText, { color: isSent ? colors.success : colors.textSecondary }]}
                  numberOfLines={2}
                >
                  {isSent ? t('payment_delivered') : (entry.lastError ?? t('payment_not_delivered'))}
                </Text>

                {/* Action buttons — full-width row, easy tap targets */}
                <View style={[styles.outgoingButtons, { borderTopColor: colors.separator }]}>
                  <TouchableOpacity
                    onPress={() => onDismiss(entry.id)}
                    disabled={isRetrying}
                    style={[
                      styles.outgoingDismissButton,
                      isSent && { flex: 1 },
                      !isSent && { borderRightColor: colors.separator }
                    ]}
                  >
                    <Text style={[styles.outgoingDismissText, { color: colors.textSecondary }]}>{t('dismiss')}</Text>
                  </TouchableOpacity>
                  {!isSent && (
                    <TouchableOpacity
                      onPress={() => onRetry(entry)}
                      disabled={isRetrying}
                      style={styles.outgoingRetryButton}
                    >
                      {isRetrying ? (
                        <ActivityIndicator size="small" color={colors.accent} />
                      ) : (
                        <Text style={[styles.outgoingRetryText, { color: colors.accent }]}>{t('retry')}</Text>
                      )}
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            </View>
          )
        })}
      </View>
    </>
  )
}

export interface HandleSendProps {
  /** Prefilled recipient from a deep link or a scan (identity key hex). */
  initialIdentityKey?: string
  /** Prefilled amount in satoshis from a peerpay link. */
  initialSats?: number
  /** Error text from a malformed peerpay link, shown as a banner. */
  initialNotice?: string | null
}

export default function HandleSend({ initialIdentityKey, initialSats, initialNotice }: HandleSendProps) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const { managers, adminOriginator, settings, storage } = useWallet()
  const wallet = managers?.permissionsManager || null
  const { satoshisPerUSD } = useContext(ExchangeRateContext)
  const currency = settings?.currency || 'BSV'

  const config = useMessageBoxConfig(t)
  const { messageBoxUrl } = config
  const isConfigured = !!messageBoxUrl && messageBoxUrl !== NO_MESSAGE_BOX

  const [sendAmount, setSendAmount] = useState(initialSats && initialSats > 0 ? String(initialSats) : '')
  const [notice, setNotice] = useState<{ type: 'error'; message: string } | null>(
    initialNotice ? { type: 'error', message: initialNotice } : null
  )
  const [isSending, setIsSending] = useState(false)
  const [sendResult, setSendResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [celebrating, setCelebrating] = useState(false)
  const [celebrationMessage, setCelebrationMessage] = useState('')
  const [outbox, setOutbox] = useState<OutboxEntry[]>([])
  const [retryingId, setRetryingId] = useState<string | null>(null)

  const search = useIdentitySearch(
    wallet as any,
    adminOriginator,
    initialIdentityKey,
    sats => setSendAmount(String(sats)),
    message => setNotice({ type: 'error', message })
  )

  const peerPayClient = useMemo<PeerPayClient | null>(() => {
    if (!isConfigured || !messageBoxUrl || !wallet) return null
    try {
      return new PeerPayClient({
        messageBoxHost: messageBoxUrl,
        walletClient: wallet as any,
        originator: adminOriginator
      })
    } catch {
      return null
    }
    // Intentionally no eager init: the library anoints lazily on first use, and
    // anointing needs a funded wallet — an init() on mount would fail silently
    // with no balance, latch initialized=true, and prevent any later retry.
  }, [isConfigured, messageBoxUrl, wallet, adminOriginator])

  const loadOutbox = useCallback(async () => {
    if (!storage) return
    setOutbox(await getOutboxEntries(storage))
  }, [storage])

  useEffect(() => {
    void loadOutbox()
  }, [loadOutbox])

  const handleSend = useCallback(async () => {
    const client = peerPayClient
    if (!client || !search.recipientKey || !storage) return
    const sats = Math.round(Number(sendAmount))
    if (!Number.isFinite(sats) || sats <= 0) {
      setSendResult({ type: 'error', message: t('enter_valid_amount') })
      setTimeout(() => setSendResult(null), 5000)
      return
    }
    haptics.confirm()
    setIsSending(true)
    try {
      const { satoshis: paidSats } = await sendViaHandle({
        client,
        storage,
        recipient: search.recipientKey,
        satoshis: sats,
        messageBoxUrl
      })
      await loadOutbox()
      const amount = formatAmount(paidSats, currency, satoshisPerUSD)
      const isFirst = !(await AsyncStorage.getItem(FIRST_PAYMENT_KEY))
      if (isFirst) {
        await AsyncStorage.setItem(FIRST_PAYMENT_KEY, '1')
        setCelebrationMessage(`${t('paid')} ${amount}`)
        setCelebrating(true)
      } else {
        haptics.success()
        setSendResult({ type: 'success', message: `${t('paid')} ${amount}` })
      }
      setSendAmount('')
      search.clearRecipient()
    } catch (error: any) {
      const message = error instanceof RangeError ? t('enter_valid_amount') : error?.message || t('unknown_error')
      setSendResult({ type: 'error', message })
      // The outbox entry stays 'unsent' and is offered for retry below.
      await loadOutbox()
    } finally {
      setIsSending(false)
      setTimeout(() => setSendResult(null), 5000)
    }
  }, [peerPayClient, search, sendAmount, storage, messageBoxUrl, loadOutbox, currency, satoshisPerUSD, t])

  const handleRetry = useCallback(
    async (entry: OutboxEntry) => {
      const client = peerPayClient
      if (!client || !storage) return
      setRetryingId(entry.id)
      try {
        await retryDelivery({ client, storage, entry })
        showToast(t('payment_delivered'), { type: 'success' })
      } catch (e: any) {
        showToast(`${t('retry_failed')}: ${e?.message || t('unknown_error')}`, { type: 'error' })
      } finally {
        setRetryingId(null)
        await loadOutbox()
      }
    },
    [peerPayClient, storage, loadOutbox, t]
  )

  const handleDismiss = useCallback(
    async (id: string) => {
      if (!storage) return
      await removeOutboxEntry(storage, id)
      await loadOutbox()
    },
    [storage, loadOutbox]
  )

  const canSend = search.recipientKey.length > 0 && Number(sendAmount) > 0 && !isSending && isConfigured

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {/* Config lives behind the same gear the old screen used, not on the main path. */}
      <MessageBoxBar
        url={config.messageBoxUrl}
        open={config.showConfig}
        onToggle={() =>
          // A no-server sentinel keeps the panel pinned open: there is nothing to
          // collapse back to, and closing it would hide the only way to fix it.
          config.setShowConfig(v => (config.messageBoxUrl === NO_MESSAGE_BOX ? true : !v))
        }
        colors={colors}
        t={t}
      />
      {config.showConfig && (
        <ConfigPanel
          urlInput={config.urlInput}
          isSaving={config.isSaving}
          colors={colors}
          t={t}
          onChangeUrl={config.setUrlInput}
          onSave={() => {
            void config.handleSave(config.urlInput)
          }}
          onReset={config.handleReset}
          onNone={config.handleNone}
        />
      )}
      {notice && <ResultBanner result={notice} onDismiss={() => setNotice(null)} colors={colors} />}

      <View style={styles.fieldGroup}>
        <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{t('recipient')}</Text>
        <RecipientField
          selectedIdentity={search.selectedIdentity}
          searchQuery={search.searchQuery}
          recipientKey={search.recipientKey}
          isSearching={search.isSearching}
          searchResults={search.searchResults}
          colors={colors}
          t={t}
          onSearchChange={search.handleSearchChange}
          onSelectIdentity={search.handleSelectIdentity}
          onClear={search.clearRecipient}
          onOpenScanner={search.openScanner}
        />
      </View>

      <View style={styles.fieldGroup}>
        <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{t('amount')}</Text>
        <AmountInput value={sendAmount} onChangeText={setSendAmount} />
      </View>

      {/* The consequence, before the button — not after. */}
      <Text style={[styles.consequence, { color: colors.textSecondary }]}>{t(CONSEQUENCE_KEYS.handle)}</Text>

      <PressableScale
        onPress={handleSend}
        disabled={!canSend}
        style={[styles.cta, { backgroundColor: canSend ? colors.accent : colors.fill, opacity: canSend ? 1 : 0.5 }]}
        accessibilityRole="button"
        accessibilityLabel={t('pay')}
        accessibilityState={{ disabled: !canSend }}
      >
        {isSending ? (
          <ActivityIndicator size="small" color={canSend ? colors.background : colors.textSecondary} />
        ) : (
          <>
            <Ionicons name="arrow-up" size={20} color={canSend ? colors.textOnAccent : colors.textTertiary} />
            <Text style={[styles.ctaText, { color: canSend ? colors.textOnAccent : colors.textTertiary }]}>
              {t('pay')}
            </Text>
          </>
        )}
      </PressableScale>

      {sendResult && <ResultBanner result={sendResult} onDismiss={() => setSendResult(null)} colors={colors} />}

      {/* Outgoing: unsent tokens offered for manual retry, exactly as before. */}
      {outbox.length > 0 && (
        <OutgoingSection
          entries={outbox}
          retryingId={retryingId}
          colors={colors}
          t={t}
          onRetry={handleRetry}
          onDismiss={handleDismiss}
        />
      )}

      <Modal
        visible={search.scannerVisible}
        animationType="slide"
        onRequestClose={() => search.setScannerVisible(false)}
        statusBarTranslucent
      >
        <StatusBar style="light" />
        <QRScanner
          multiScan
          onScan={search.handleQRScanned}
          onClose={() => search.setScannerVisible(false)}
          hintText={t('scan_identity_key_hint')}
        />
      </Modal>

      {celebrating && (
        <View style={styles.celebrationOverlay} pointerEvents="none">
          <Celebration
            onDone={() => {
              setCelebrating(false)
              setSendResult({ type: 'success', message: celebrationMessage })
            }}
          />
        </View>
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg
  },

  // Field group
  fieldGroup: {
    marginBottom: spacing.lg
  },
  fieldLabel: {
    ...typography.footnote,
    fontWeight: '500',
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.5
  },

  // Consequence line + call to action
  consequence: {
    ...typography.footnote,
    marginBottom: spacing.md
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md + 2,
    borderRadius: radii.md
  },
  ctaText: {
    ...typography.subhead,
    fontWeight: '600'
  },

  // Outgoing section
  outgoingCard: {
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    marginBottom: spacing.lg
  },
  outgoingRow: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderLeftWidth: 3
  },
  outgoingInfo: {
    gap: 6
  },
  outgoingTopRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.md
  },
  outgoingRecipient: {
    ...typography.footnote,
    fontWeight: '500',
    fontFamily: 'monospace',
    flex: 1
  },
  outgoingAmount: {
    ...typography.subhead,
    fontWeight: '700',
    flexShrink: 0
  },
  outgoingStatusText: {
    ...typography.caption1,
    marginBottom: spacing.sm
  },
  outgoingButtons: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    marginHorizontal: -spacing.lg,
    marginBottom: -spacing.md
  },
  outgoingDismissButton: {
    flex: 1,
    paddingVertical: 13,
    alignItems: 'center',
    borderRightWidth: StyleSheet.hairlineWidth
  },
  outgoingRetryButton: {
    flex: 1,
    paddingVertical: 13,
    alignItems: 'center'
  },
  outgoingRetryText: {
    ...typography.subhead,
    fontWeight: '600'
  },
  outgoingDismissText: {
    ...typography.subhead
  },

  // First-payment celebration overlay
  celebrationOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100
  }
})
