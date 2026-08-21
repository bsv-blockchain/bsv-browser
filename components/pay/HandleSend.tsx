/**
 * Pay → someone with this app.
 *
 * The recipient is a handle (an identity key, reached by search, scan or deep
 * link) and delivery is asynchronous: the token is dropped in their MessageBox
 * and lands when their wallet next checks. That is exactly what the consequence
 * line under the button says, and why it says it before the send rather than
 * after.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { useTranslation } from 'react-i18next'
import { PeerPayClient } from '@bsv/message-box-client'

import QRScanner from '@/components/QRScanner'
import AmountDisplay from '@/components/wallet/AmountDisplay'
import { showToast } from '@/components/ui/Toast'
import { ConsequenceNote, PayAmountField, PayCta, PayField } from '@/components/pay/PayForm'
import PaymentSuccessOverlay from '@/components/pay/PaymentSuccessOverlay'
import ResultBanner from '@/components/pay/ResultBanner'
import RecipientField from '@/components/pay/RecipientField'
import { ConfigPanel, MessageBoxBar, useMessageBoxConfig } from '@/components/pay/MessageBoxConfig'
import { useIdentitySearch } from '@/components/pay/useIdentitySearch'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, typography, radii } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import { CONSEQUENCE_KEYS } from '@/utils/pay/rails'
import {
  NO_MESSAGE_BOX,
  cancelOutboxPayment,
  isMessageBoxNetworkError,
  retryDelivery,
  sendViaHandle
} from '@/utils/pay/rails/handle'
import { getOutboxEntries, removeOutboxEntry, type OutboxEntry } from '@/utils/peerpay/outbox'
import { haptics } from '@/hooks/useHaptics'

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
    <PayField labelKey="outgoing_payments">
      <View style={[styles.outgoingCard, { backgroundColor: colors.background, borderColor: colors.separator }]}>
        {entries.map((entry, idx) => {
          const isRetrying = retryingId === entry.id
          const isLast = idx === entries.length - 1
          // Everything in this list failed to deliver — delivered entries are
          // filtered out before render, so the accent is always the warning.
          const accentColor = colors.warning
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
                <Text style={[styles.outgoingStatusText, { color: colors.textSecondary }]} numberOfLines={2}>
                  {entry.lastError
                    ? isMessageBoxNetworkError(entry.lastError)
                      ? t('message_box_unreachable')
                      : entry.lastError
                    : t('payment_not_delivered')}
                </Text>

                {/* Action buttons — full-width row, easy tap targets */}
                <View style={[styles.outgoingButtons, { borderTopColor: colors.separator }]}>
                  <TouchableOpacity
                    onPress={() => onDismiss(entry.id)}
                    disabled={isRetrying}
                    style={[styles.outgoingDismissButton, { borderRightColor: colors.separator }]}
                  >
                    <Text style={[styles.outgoingDismissText, { color: colors.textSecondary }]}>{t('cancel')}</Text>
                  </TouchableOpacity>
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
                </View>
              </View>
            </View>
          )
        })}
      </View>
    </PayField>
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
  const { managers, adminOriginator, storage } = useWallet()
  const wallet = managers?.permissionsManager || null

  const config = useMessageBoxConfig(t)
  const { messageBoxUrl } = config
  const isConfigured = !!messageBoxUrl && messageBoxUrl !== NO_MESSAGE_BOX

  const [sendAmount, setSendAmount] = useState(initialSats && initialSats > 0 ? String(initialSats) : '')
  const [note, setNote] = useState('')
  const [notice, setNotice] = useState<{ type: 'error'; message: string } | null>(
    initialNotice ? { type: 'error', message: initialNotice } : null
  )
  const [isSending, setIsSending] = useState(false)
  const [sendResult, setSendResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  /** The success moment, held until acknowledged — same screen as every rail. */
  const [sent, setSent] = useState<{ amount: number; recipient?: string } | null>(null)
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
    // Only failed deliveries surface here: a delivered payment already had its
    // success moment, and this list exists for the retry, not as a history.
    // Delivered entries are pruned rather than merely hidden — nothing would
    // ever remove them otherwise, and the transaction itself lives in the
    // wallet's own activity, not in this delivery bookkeeping.
    const entries = await getOutboxEntries(storage)
    const delivered = entries.filter(e => e.status === 'sent')
    for (const e of delivered) await removeOutboxEntry(storage, e.id)
    setOutbox(entries.filter(e => e.status !== 'sent'))
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
        wallet: wallet as any,
        adminOriginator,
        client,
        storage,
        recipient: search.recipientKey,
        satoshis: sats,
        messageBoxUrl,
        note,
        recipientName: search.selectedIdentity?.name
      })
      await loadOutbox()
      // The overlay stages its own haptic (inside Celebration) and tone; firing
      // haptics.success() here would double the beat. Only a human-readable
      // name goes on the success screen — a raw identity key is noise there.
      setSent({
        amount: paidSats,
        recipient: search.selectedIdentity?.name
      })
      setSendAmount('')
      setNote('')
      search.clearRecipient()
    } catch (error: any) {
      // An unreachable message box is a configuration problem, not a payment
      // one — point at the fix rather than echoing the raw fetch error.
      const message =
        error instanceof RangeError
          ? t('enter_valid_amount')
          : isMessageBoxNetworkError(error)
            ? t('message_box_unreachable')
            : error?.message || t('unknown_error')
      setSendResult({ type: 'error', message })
      // The outbox entry stays 'unsent' and is offered for retry below.
      await loadOutbox()
    } finally {
      setIsSending(false)
      setTimeout(() => setSendResult(null), 5000)
    }
  }, [peerPayClient, search, sendAmount, note, storage, messageBoxUrl, loadOutbox, wallet, adminOriginator, t])

  const handleRetry = useCallback(
    async (entry: OutboxEntry) => {
      const client = peerPayClient
      if (!client || !storage) return
      setRetryingId(entry.id)
      try {
        await retryDelivery({ wallet: wallet as any, adminOriginator, client, storage, entry })
        // A retried payment that lands gets the same success moment as one
        // that worked first time — held until Done, then back to the wallet.
        setSent({ amount: entry.token.amount })
      } catch (e: any) {
        const reason = isMessageBoxNetworkError(e) ? t('message_box_unreachable') : e?.message || t('unknown_error')
        showToast(`${t('retry_failed')}: ${reason}`, { type: 'error' })
      } finally {
        setRetryingId(null)
        await loadOutbox()
      }
    },
    [peerPayClient, storage, loadOutbox, wallet, adminOriginator, t]
  )

  /**
   * Cancel a stuck payment. For a not-yet-delivered noSend entry this aborts
   * the underlying action, freeing its inputs — nothing was ever broadcast.
   */
  const handleDismiss = useCallback(
    async (id: string) => {
      if (!storage || !wallet) return
      const entry = outbox.find(e => e.id === id)
      if (!entry) return
      await cancelOutboxPayment({ wallet: wallet as any, adminOriginator, storage, entry })
      await loadOutbox()
    },
    [storage, wallet, adminOriginator, outbox, loadOutbox]
  )

  /**
   * A stuck payment blocks new sends: every attempt while the message box is
   * unreachable would mint another noSend action and another stuck entry, so
   * the only ways forward are Retry and Cancel on what is already queued.
   */
  const canSend =
    search.recipientKey.length > 0 && Number(sendAmount) > 0 && !isSending && isConfigured && outbox.length === 0

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

      <PayField labelKey="recipient">
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
      </PayField>

      <PayAmountField value={sendAmount} onChangeText={setSendAmount} />

      <PayField labelKey="note">
        <TextInput
          value={note}
          onChangeText={setNote}
          placeholder={t('note_placeholder')}
          placeholderTextColor={colors.textQuaternary}
          maxLength={280}
          style={[
            styles.noteInput,
            { backgroundColor: colors.backgroundSecondary, borderColor: colors.separator, color: colors.textPrimary }
          ]}
        />
      </PayField>

      {/* The consequence, before the button — not after. */}
      <ConsequenceNote textKey={CONSEQUENCE_KEYS.handle} />

      <PayCta onPress={handleSend} disabled={!canSend} busy={isSending} />

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
  content: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg
  },

  // Field group
  fieldGroup: {
    marginBottom: spacing.lg
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

  noteInput: {
    ...typography.body,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md
  }
})
