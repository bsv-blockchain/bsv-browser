/**
 * Get paid → someone with this app.
 *
 * Your handle in three forms, because the counterparty's situation decides
 * which one works: a QR to scan across a table, a copyable key to paste, and a
 * peerpay: link to send through any messaging app. All three carry the same
 * identity key — the link is the one the app can route itself, via
 * +native-intent, straight back into Pay → handle.
 *
 * Below it: the inbox. Incoming PeerPay payments are not automatic — accepting
 * one internalizes it — so the list, the per-payment note and Accept all are
 * carried over from the old Payments screen unchanged.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  AppState,
  Image,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native'
import { useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import Clipboard from '@react-native-clipboard/clipboard'
import QRCode from 'react-native-qrcode-svg'
import { useTranslation } from 'react-i18next'
import { PeerPayClient, type IncomingPayment } from '@bsv/message-box-client'
import type { DisplayableIdentity } from '@bsv/sdk'

import AmountDisplay from '@/components/wallet/AmountDisplay'
import ResultBanner from '@/components/pay/ResultBanner'
import { ConfigPanel, MessageBoxBar, useMessageBoxConfig } from '@/components/pay/MessageBoxConfig'
import { showToast } from '@/components/ui/Toast'
import { useTheme } from '@/context/theme/ThemeContext'
import { radii, spacing, typography } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import { makeIdentityClient, resolveIdentity } from '@/utils/identity/resolveIdentity'
import { NO_MESSAGE_BOX, acceptWithRetry, internalizeIncoming, peerPayLinkFor } from '@/utils/pay/rails/handle'

/**
 * How often the inbox is re-read while this screen is in front.
 *
 * Five seconds is the "it just appeared" threshold without making the poll the
 * app's most frequent network call: it is one MessageBox list read, and it stops
 * entirely on blur, on background and during an accept.
 */
const INBOX_POLL_MS = 5000

// ── Incoming Section ─────────────────────────────────────────────────────────
//
// IncomingPaymentsSection and PaymentRow are app/payments.tsx:418-526 and
// :754-858, carried over unchanged apart from one drop: the section's own
// acceptResult banner (and the onDismissResult it needed), because the cell
// below renders the banner itself.

interface IncomingPaymentsSectionProps {
  readonly isConfigured: boolean
  readonly loadingPayments: boolean
  readonly payments: IncomingPayment[]
  readonly senderIdentities: Record<string, DisplayableIdentity | null>
  readonly acceptingId: string | null
  readonly acceptingAll: boolean
  readonly editingNoteId: string | null
  readonly paymentNotes: Record<string, string>
  readonly colors: ReturnType<typeof import('@/context/theme/ThemeContext').useTheme>['colors']
  readonly t: ReturnType<typeof import('react-i18next').useTranslation>['t']
  readonly onRefresh: () => void
  readonly onAccept: (p: IncomingPayment) => void
  readonly onAcceptAll: () => void
  readonly onEditNote: (id: string) => void
  readonly onChangeNote: (id: string, text: string) => void
  readonly onSubmitNote: () => void
}

function IncomingPaymentsSection({
  isConfigured,
  loadingPayments,
  payments,
  senderIdentities,
  acceptingId,
  acceptingAll,
  editingNoteId,
  paymentNotes,
  colors,
  t,
  onRefresh,
  onAccept,
  onAcceptAll,
  onEditNote,
  onChangeNote,
  onSubmitNote
}: IncomingPaymentsSectionProps) {
  if (!isConfigured) return null
  return (
    <>
      <View style={styles.incomingSectionHeader}>
        <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>{t('incoming_payments')}</Text>
        <View style={styles.headerActions}>
          {payments.length > 0 && (
            <TouchableOpacity
              onPress={onAcceptAll}
              disabled={acceptingAll || loadingPayments}
              style={[styles.acceptAllButton, { opacity: acceptingAll || loadingPayments ? 0.5 : 1 }]}
            >
              {acceptingAll ? (
                <ActivityIndicator size="small" color={colors.accent} />
              ) : (
                <Text style={[styles.acceptAllButtonText, { color: colors.accent }]}>{t('accept_all')}</Text>
              )}
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={onRefresh} disabled={loadingPayments || acceptingAll}>
            <Ionicons
              name="refresh"
              size={22}
              color={loadingPayments || acceptingAll ? colors.textQuaternary : colors.accent}
            />
          </TouchableOpacity>
        </View>
      </View>

      {loadingPayments && payments.length === 0 && (
        <View style={styles.centeredSmall}>
          <ActivityIndicator size="small" color={colors.accent} />
        </View>
      )}
      {!loadingPayments && payments.length === 0 && (
        <View style={styles.centeredSmall}>
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>{t('no_pending_payments')}</Text>
        </View>
      )}
      {payments.length > 0 && (
        <View
          style={[styles.paymentsList, { backgroundColor: colors.backgroundSecondary, borderColor: colors.separator }]}
        >
          {payments.map((payment, idx) => {
            const id = String(payment.messageId)
            return (
              <PaymentRow
                key={id}
                payment={payment}
                identity={senderIdentities[payment.sender ?? '']}
                isLast={idx === payments.length - 1}
                isAccepting={acceptingId === id}
                isEditingNote={editingNoteId === id}
                note={paymentNotes[id] ?? ''}
                onAccept={() => onAccept(payment)}
                onEditNote={() => onEditNote(id)}
                onChangeNote={text => onChangeNote(id, text)}
                onSubmitNote={onSubmitNote}
                colors={colors}
                t={t}
              />
            )
          })}
        </View>
      )}
    </>
  )
}

interface PaymentRowProps {
  readonly payment: IncomingPayment
  readonly identity: DisplayableIdentity | null | undefined
  readonly isLast: boolean
  readonly isAccepting: boolean
  readonly isEditingNote: boolean
  readonly note: string
  readonly onAccept: () => void
  readonly onEditNote: () => void
  readonly onChangeNote: (text: string) => void
  readonly onSubmitNote: () => void
  readonly colors: ReturnType<typeof import('@/context/theme/ThemeContext').useTheme>['colors']
  readonly t: ReturnType<typeof import('react-i18next').useTranslation>['t']
}

function PaymentRow({
  payment,
  identity,
  isLast,
  isAccepting,
  isEditingNote,
  note,
  onAccept,
  onEditNote,
  onChangeNote,
  onSubmitNote,
  colors,
  t
}: PaymentRowProps) {
  const senderKey = payment.sender ?? ''
  return (
    <View
      style={[
        styles.paymentRow,
        !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }
      ]}
    >
      {/* Avatar */}
      {identity?.avatarURL ? (
        <Image source={{ uri: identity.avatarURL }} style={styles.paymentAvatar} />
      ) : (
        <View style={[styles.paymentAvatarPlaceholder, { backgroundColor: colors.accent + 'CC' }]}>
          <Ionicons name="person" size={24} color={colors.background} />
        </View>
      )}

      {/* Center: identity + note */}
      <View style={styles.paymentInfo}>
        <Text style={[styles.paymentSenderName, { color: colors.textPrimary }]} numberOfLines={1}>
          {identity?.name ?? t('unknown')}
        </Text>
        <Text style={[styles.paymentSender, { color: colors.textSecondary }]} numberOfLines={1}>
          {identity?.abbreviatedKey ?? `${senderKey.slice(0, 16)}…`}
        </Text>

        {isEditingNote ? (
          <TextInput
            value={note}
            onChangeText={onChangeNote}
            placeholder={t('payment_note_placeholder')}
            placeholderTextColor={colors.textTertiary}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={onSubmitNote}
            style={[styles.noteInput, { color: colors.textPrimary, borderBottomColor: colors.accent }]}
          />
        ) : (
          <TouchableOpacity
            onPress={onEditNote}
            style={styles.noteTapTarget}
            hitSlop={{ top: 4, bottom: 4, left: 0, right: 8 }}
          >
            <Ionicons
              name="pencil"
              size={11}
              color={note ? colors.accent : colors.textQuaternary}
              style={{ marginRight: 4, marginTop: 1 }}
            />
            <Text style={[styles.noteText, { color: note ? colors.accent : colors.textQuaternary }]} numberOfLines={1}>
              {note || t('payment_note_placeholder')}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Right: amount + accept */}
      <View style={styles.paymentActions}>
        <Text style={[styles.paymentAmount, { color: colors.success }]}>
          <AmountDisplay>{payment.token.amount}</AmountDisplay>
        </Text>
        <TouchableOpacity
          onPress={onAccept}
          disabled={isAccepting}
          style={[styles.acceptButton, { backgroundColor: colors.accent }]}
        >
          {isAccepting ? (
            <ActivityIndicator size="small" color={colors.background} />
          ) : (
            <Text style={[styles.acceptButtonText, { color: colors.background }]}>{t('accept')}</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  )
}

export default function HandleReceive() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const { managers, adminOriginator } = useWallet()
  const wallet = managers?.permissionsManager || null

  const [identityKey, setIdentityKey] = useState('')
  const [copied, setCopied] = useState(false)
  const config = useMessageBoxConfig(t)
  const { messageBoxUrl } = config
  const isConfigured = !!messageBoxUrl && messageBoxUrl !== NO_MESSAGE_BOX

  const [payments, setPayments] = useState<IncomingPayment[]>([])
  const [loading, setLoading] = useState(false)
  const [acceptingId, setAcceptingId] = useState<string | null>(null)
  const [acceptingAll, setAcceptingAll] = useState(false)
  const [senderIdentities, setSenderIdentities] = useState<Record<string, DisplayableIdentity | null>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [result, setResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  /** One inbox read at a time — see fetchPayments. */
  const fetchingRef = useRef(false)
  /** An accept is running; it refreshes the list itself, so the poll stands off. */
  const acceptingRef = useRef(false)
  /**
   * Whether this screen is the one on top. Pushing another route leaves this
   * component mounted, so mount alone is not "the user is looking at it".
   */
  const focusedRef = useRef(true)
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true
      return () => {
        focusedRef.current = false
      }
    }, [])
  )

  useEffect(() => {
    wallet?.getPublicKey({ identityKey: true }, adminOriginator).then(r => r && setIdentityKey(r.publicKey))
  }, [wallet, adminOriginator])

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
  }, [isConfigured, messageBoxUrl, wallet, adminOriginator])

  const link = identityKey ? peerPayLinkFor(identityKey) : ''

  const handleCopy = useCallback(() => {
    if (!identityKey) return
    Clipboard.setString(identityKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [identityKey])

  const handleShare = useCallback(() => {
    if (!link) return
    // Share.share rejects when the sheet is dismissed on some platforms; a
    // dismissed share sheet is not an error worth a toast.
    void Share.share({ message: link }).catch(() => {})
  }, [link])

  const fetchPayments = useCallback(
    async (options: { silent?: boolean } = {}) => {
      const client = peerPayClient
      if (!client || !messageBoxUrl || messageBoxUrl === NO_MESSAGE_BOX) return
      // One read at a time. The poll, the refresh button and every accept all
      // reach this, and two overlapping reads can land out of order — the older
      // response winning would resurrect a row that was just internalized.
      if (fetchingRef.current) return
      fetchingRef.current = true
      if (!options.silent) setLoading(true)
      try {
        const list = await client.listIncomingPayments(messageBoxUrl)
        setPayments(list)
        const idClient = makeIdentityClient(wallet as any, adminOriginator)
        if (idClient) {
          const senders = [...new Set(list.map(p => p.sender).filter(Boolean))] as string[]
          const entries = await Promise.all(senders.map(s => resolveIdentity(idClient, s)))
          setSenderIdentities(Object.fromEntries(entries))
        }
      } catch (error: any) {
        // A silent read is a poll the user did not ask for, so it fails quietly:
        // at one read every few seconds, a dead network would otherwise raise a
        // toast per tick. Only a read the user triggered reports failure.
        if (!options.silent) {
          showToast(`${t('connection_failed')}: ${error?.message || t('unknown_error')}`, { type: 'error' })
        }
      } finally {
        fetchingRef.current = false
        if (!options.silent) setLoading(false)
      }
    },
    [peerPayClient, messageBoxUrl, wallet, adminOriginator, t]
  )

  useEffect(() => {
    void fetchPayments()
  }, [fetchPayments])

  // Read through a ref so the poll below depends only on the client, and is
  // never torn down and restarted by an unrelated re-render.
  const fetchRef = useRef(fetchPayments)
  useEffect(() => {
    fetchRef.current = fetchPayments
  }, [fetchPayments])

  // ── Poll the inbox ──
  //
  // A payment arrives whenever the sender's wallet delivers it and MessageBox has
  // no push channel here, so "it appears on its own" means polling — but only
  // while someone is actually looking at this screen. Three gates, each for its
  // own reason: unmount and blur stop it because a poll nobody can see spends
  // battery to update a screen that is not on; a backgrounded app stops it for
  // the same reason and because iOS will suspend the timer anyway; and an accept
  // in flight stops it because that path refreshes the list itself.
  useEffect(() => {
    if (!peerPayClient) return
    let cancelled = false

    const tick = () => {
      if (cancelled || !focusedRef.current) return
      if (AppState.currentState !== 'active') return
      if (acceptingRef.current) return
      void fetchRef.current({ silent: true })
    }

    const interval = setInterval(tick, INBOX_POLL_MS)
    // Returning to the app should show what arrived while it was away, rather
    // than waiting out the rest of an interval.
    const appSubscription = AppState.addEventListener('change', next => {
      if (next === 'active') tick()
    })

    return () => {
      cancelled = true
      clearInterval(interval)
      appSubscription.remove()
    }
  }, [peerPayClient])

  const internalize = useCallback(
    async (payment: IncomingPayment, description: string) => {
      const client = peerPayClient
      if (!client || !wallet) throw new Error(t('wallet_not_ready'))
      await internalizeIncoming(wallet as any, client, adminOriginator, payment, description)
    },
    [peerPayClient, wallet, adminOriginator, t]
  )

  const handleAccept = useCallback(
    async (payment: IncomingPayment) => {
      const client = peerPayClient
      if (!client) return
      const id = String(payment.messageId)
      const description = notes[id]?.trim() || 'Identity Payment'
      setAcceptingId(id)
      setEditingNoteId(null)
      acceptingRef.current = true
      try {
        await acceptWithRetry(client, messageBoxUrl, payment, description, internalize)
        setResult({ type: 'success', message: t('local_pay_added') })
        await fetchPayments()
      } catch (e: any) {
        setResult({ type: 'error', message: e?.message || t('unknown_error') })
      } finally {
        // Released only after the refresh above has resolved, so the next poll
        // reads a list that already reflects this accept.
        acceptingRef.current = false
        setAcceptingId(null)
        setTimeout(() => setResult(null), 5000)
      }
    },
    [peerPayClient, notes, messageBoxUrl, internalize, fetchPayments, t]
  )

  const handleAcceptAll = useCallback(async () => {
    const client = peerPayClient
    if (!client || payments.length === 0) return
    setAcceptingAll(true)
    setEditingNoteId(null)
    acceptingRef.current = true
    let successCount = 0
    let lastError: string | null = null
    for (const payment of payments) {
      const id = String(payment.messageId)
      const description = notes[id]?.trim() || 'Identity Payment'
      try {
        await acceptWithRetry(client, messageBoxUrl, payment, description, internalize)
        successCount++
      } catch (e: any) {
        lastError = e?.message || t('unknown_error')
      }
    }
    if (successCount > 0) {
      setResult({
        type: lastError ? 'error' : 'success',
        message: lastError
          ? `${t('local_pay_added_multiple', { count: successCount })} (${lastError})`
          : t('local_pay_added_multiple', { count: successCount })
      })
      await fetchPayments()
    } else if (lastError) {
      setResult({ type: 'error', message: lastError })
    }
    acceptingRef.current = false
    setAcceptingAll(false)
    setTimeout(() => setResult(null), 5000)
  }, [peerPayClient, payments, notes, messageBoxUrl, internalize, fetchPayments, t])

  return (
    // Scrolls, because a 240pt QR plus the inbox overflows a small screen and a
    // note being edited puts the keyboard over the row that owns it.
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      {/* The way into the message-box settings, and the active host. Without it a
          user who saved a broken host has no route back to reset or clear it. */}
      <MessageBoxBar
        url={config.messageBoxUrl}
        open={config.showConfig}
        onToggle={() => config.setShowConfig(v => (config.messageBoxUrl === NO_MESSAGE_BOX ? true : !v))}
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

      {/* Your handle. The QR is the focal element — it is the thing physically
          held up to another device. */}
      <View style={styles.qrHero}>
        {identityKey ? (
          <View style={styles.qrPlate}>
            <QRCode value={identityKey} size={240} color="#000" backgroundColor="#fff" />
          </View>
        ) : (
          <ActivityIndicator size="large" color={colors.textSecondary} />
        )}
      </View>

      <Text style={[styles.keyText, { color: colors.textSecondary }]} numberOfLines={1} ellipsizeMode="middle">
        {identityKey}
      </Text>

      <View style={styles.actionRow}>
        <TouchableOpacity onPress={handleCopy} style={[styles.action, { backgroundColor: colors.fillTertiary }]}>
          <Ionicons
            name={copied ? 'checkmark' : 'copy-outline'}
            size={18}
            color={copied ? colors.success : colors.textSecondary}
          />
          <Text style={[styles.actionText, { color: copied ? colors.success : colors.textSecondary }]}>
            {copied ? t('copied') : t('pay_copy')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={handleShare}
          disabled={!link}
          style={[styles.action, { backgroundColor: colors.fillTertiary, opacity: link ? 1 : 0.5 }]}
        >
          <Ionicons name="share-outline" size={18} color={colors.textSecondary} />
          <Text style={[styles.actionText, { color: colors.textSecondary }]}>{t('pay_share_link')}</Text>
        </TouchableOpacity>
      </View>

      {/* The inbox. Accepting is what internalizes, so this stays explicit. */}
      <IncomingPaymentsSection
        isConfigured={isConfigured}
        loadingPayments={loading}
        payments={payments}
        senderIdentities={senderIdentities}
        acceptingId={acceptingId}
        acceptingAll={acceptingAll}
        editingNoteId={editingNoteId}
        paymentNotes={notes}
        colors={colors}
        t={t}
        onRefresh={fetchPayments}
        onAccept={handleAccept}
        onAcceptAll={handleAcceptAll}
        onEditNote={setEditingNoteId}
        onChangeNote={(id, text) => setNotes(prev => ({ ...prev, [id]: text }))}
        onSubmitNote={() => setEditingNoteId(null)}
      />
      {result && <ResultBanner result={result} onDismiss={() => setResult(null)} colors={colors} />}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg
  },

  // Your handle
  qrHero: {
    alignItems: 'center',
    marginBottom: spacing.lg
  },
  qrPlate: {
    padding: spacing.lg,
    borderRadius: radii.xl,
    backgroundColor: '#fff'
  },
  keyText: {
    ...typography.caption1,
    fontFamily: 'monospace',
    textAlign: 'center',
    marginBottom: spacing.md
  },
  actionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.xl
  },
  action: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.md
  },
  actionText: {
    ...typography.subhead,
    fontWeight: '500'
  },

  // Section
  sectionTitle: {
    ...typography.title3,
    marginBottom: spacing.md
  },

  // Incoming payments
  incomingSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  acceptAllButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.sm
  },
  acceptAllButtonText: {
    ...typography.subhead,
    fontWeight: '600'
  },
  centeredSmall: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xxl
  },
  emptyText: {
    ...typography.body
  },
  paymentsList: {
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden'
  },
  paymentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    gap: spacing.md
  },
  paymentAvatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    flexShrink: 0
  },
  paymentAvatarPlaceholder: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0
  },
  paymentInfo: {
    flex: 1,
    minWidth: 0
  },
  paymentSenderName: {
    ...typography.subhead,
    fontWeight: '600',
    marginBottom: 1
  },
  paymentSender: {
    ...typography.caption1,
    fontFamily: 'monospace',
    marginBottom: spacing.xs
  },
  noteTapTarget: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2
  },
  noteText: {
    ...typography.caption2,
    flex: 1,
    fontStyle: 'italic'
  },
  noteInput: {
    ...typography.caption1,
    marginTop: 4,
    paddingVertical: 3,
    borderBottomWidth: 1,
    paddingHorizontal: 0
  },
  paymentActions: {
    alignItems: 'flex-end',
    gap: spacing.xs,
    flexShrink: 0
  },
  paymentAmount: {
    ...typography.footnote,
    fontWeight: '700'
  },
  acceptButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.sm,
    alignItems: 'center',
    minWidth: 70
  },
  acceptButtonText: {
    ...typography.footnote,
    fontWeight: '600'
  }
})
