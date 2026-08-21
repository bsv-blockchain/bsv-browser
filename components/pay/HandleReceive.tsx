/**
 * Get paid → someone with this app.
 *
 * Your handle in three forms, because the counterparty's situation decides
 * which one works: a QR to scan across a table, a copyable key to paste, and a
 * peerpay: link to send through any messaging app. All three carry the same
 * identity key — the link is the one the app can route itself, via
 * +native-intent, straight back into Pay → handle.
 *
 * Below it: nothing, when all is well. Arriving payments are credited the moment
 * this screen sees them — accepting was never a decision anyone could act on,
 * since the money is already theirs and refusing only leaves it in the box. The
 * list below appears only for payments the wallet could NOT credit, and exists
 * so those can be retried or, when they are structurally broken, given up on.
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
import ReceivedOverlay from '@/components/pay/PaymentSuccessOverlay'
import { ConfigPanel, MessageBoxBar, useMessageBoxConfig } from '@/components/pay/MessageBoxConfig'
import { showToast } from '@/components/ui/Toast'
import { useTheme } from '@/context/theme/ThemeContext'
import { radii, spacing, typography } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import { makeIdentityClient, resolveIdentity } from '@/utils/identity/resolveIdentity'
import {
  NO_MESSAGE_BOX,
  acceptWithRetry,
  autoAcceptInbox,
  discardIncoming,
  internalizeIncoming,
  needsAttention,
  peerPayLinkFor,
  type InboxAttempt
} from '@/utils/pay/rails/handle'

/**
 * How often the inbox is re-read while this screen is in front.
 *
 * Five seconds is the "it just appeared" threshold without making the poll the
 * app's most frequent network call: it is one MessageBox list read, and it stops
 * entirely on blur, on background and during an accept.
 */
const INBOX_POLL_MS = 5000

/**
 * The description every auto-credited payment carries into the wallet's history.
 *
 * Fixed, because nobody is present to type one: the old screen let the user add
 * a note before accepting, and automatic crediting removes that moment. Same
 * default the old screen used when the note was left blank.
 */
const INBOX_DESCRIPTION = 'Identity Payment'

/** How long a tapped Discard stays armed before it disarms itself. */
const DISCARD_ARM_MS = 5000

// ── Needs attention ──────────────────────────────────────────────────────────
//
// Replaces the old accept list. An arriving payment is credited automatically
// (see autoAcceptInbox in the handle rail), so the only rows here are the ones
// the wallet could NOT credit after MAX_AUTO_ATTEMPTS tries. That makes this a
// problem queue, not an inbox: every row offers a retry, and a discard for the
// structurally broken ones that will never succeed.
//
// There is deliberately no empty state. When nothing is wrong the section is
// absent entirely — an inbox that is always visible and always empty trains
// people to ignore it, and this is the one place that must be noticed.

interface AttentionSectionProps {
  readonly payments: IncomingPayment[]
  readonly attempts: Record<string, InboxAttempt>
  readonly senderIdentities: Record<string, DisplayableIdentity | null>
  readonly busyId: string | null
  readonly armedDiscardId: string | null
  readonly colors: ReturnType<typeof import('@/context/theme/ThemeContext').useTheme>['colors']
  readonly t: ReturnType<typeof import('react-i18next').useTranslation>['t']
  readonly onRetry: (p: IncomingPayment) => void
  readonly onDiscard: (p: IncomingPayment) => void
}

function AttentionSection({
  payments,
  attempts,
  senderIdentities,
  busyId,
  armedDiscardId,
  colors,
  t,
  onRetry,
  onDiscard
}: AttentionSectionProps) {
  if (payments.length === 0) return null
  return (
    <>
      <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>{t('pay_inbox_attention')}</Text>
      <Text style={[styles.attentionHint, { color: colors.textSecondary }]}>{t('pay_inbox_attention_hint')}</Text>
      <View
        style={[
          styles.paymentsList,
          { backgroundColor: colors.backgroundSecondary, borderColor: colors.warning + '40' }
        ]}
      >
        {payments.map((payment, idx) => {
          const id = String(payment.messageId)
          return (
            <AttentionRow
              key={id}
              payment={payment}
              identity={senderIdentities[payment.sender ?? '']}
              error={attempts[id]?.error ?? ''}
              isLast={idx === payments.length - 1}
              isBusy={busyId === id}
              isArmed={armedDiscardId === id}
              onRetry={() => onRetry(payment)}
              onDiscard={() => onDiscard(payment)}
              colors={colors}
              t={t}
            />
          )
        })}
      </View>
    </>
  )
}

interface AttentionRowProps {
  readonly payment: IncomingPayment
  readonly identity: DisplayableIdentity | null | undefined
  readonly error: string
  readonly isLast: boolean
  readonly isBusy: boolean
  readonly isArmed: boolean
  readonly onRetry: () => void
  readonly onDiscard: () => void
  readonly colors: ReturnType<typeof import('@/context/theme/ThemeContext').useTheme>['colors']
  readonly t: ReturnType<typeof import('react-i18next').useTranslation>['t']
}

function AttentionRow({
  payment,
  identity,
  error,
  isLast,
  isBusy,
  isArmed,
  onRetry,
  onDiscard,
  colors,
  t
}: AttentionRowProps) {
  const senderKey = payment.sender ?? ''
  return (
    <View
      style={[
        styles.paymentRow,
        !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }
      ]}
    >
      {identity?.avatarURL ? (
        <Image source={{ uri: identity.avatarURL }} style={styles.paymentAvatar} />
      ) : (
        <View style={[styles.paymentAvatarPlaceholder, { backgroundColor: colors.accent + 'CC' }]}>
          <Ionicons name="person" size={24} color={colors.background} />
        </View>
      )}

      <View style={styles.paymentInfo}>
        <Text style={[styles.paymentSenderName, { color: colors.textPrimary }]} numberOfLines={1}>
          {identity?.name ?? t('unknown')}
        </Text>
        <Text style={[styles.paymentSender, { color: colors.textSecondary }]} numberOfLines={1}>
          {identity?.abbreviatedKey ?? `${senderKey.slice(0, 16)}…`}
        </Text>
        {/* The reason, verbatim from the wallet. It is the only thing that tells
            the user whether a retry has any chance of working. */}
        {!!error && (
          <Text style={[styles.attentionError, { color: colors.warning }]} numberOfLines={2}>
            {error}
          </Text>
        )}

        <View style={[styles.attentionActions, { borderTopColor: colors.separator }]}>
          <TouchableOpacity
            onPress={onRetry}
            disabled={isBusy}
            style={[
              styles.attentionButton,
              { borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.separator }
            ]}
          >
            {isBusy ? (
              <ActivityIndicator size="small" color={colors.accent} />
            ) : (
              <Text style={[styles.attentionButtonText, { color: colors.accent }]}>{t('retry')}</Text>
            )}
          </TouchableOpacity>
          {/* Two taps, because this one is irreversible: discarding acknowledges
              the message, which removes it from the box for good. A single
              mis-tap next to Retry would throw the payment away. */}
          <TouchableOpacity onPress={onDiscard} disabled={isBusy} style={styles.attentionButton}>
            <Text
              style={[styles.attentionButtonText, { color: isArmed ? colors.error : colors.textSecondary }]}
              numberOfLines={1}
            >
              {isArmed ? t('pay_dismiss_confirm') : t('dismiss')}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.paymentActions}>
        <Text style={[styles.paymentAmount, { color: colors.textSecondary }]}>
          <AmountDisplay>{payment.token.amount}</AmountDisplay>
        </Text>
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
  const [senderIdentities, setSenderIdentities] = useState<Record<string, DisplayableIdentity | null>>({})
  const [result, setResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  /**
   * The success moment, held until the payee acknowledges it. Set by the credit
   * pass; cleared only by the overlay's Done.
   */
  const [received, setReceived] = useState<{ amount: number; count: number } | null>(null)

  /** Payments the wallet has failed to credit, keyed by message id. */
  const [attempts, setAttempts] = useState<Record<string, InboxAttempt>>({})
  /** The row whose retry or discard is running. */
  const [busyId, setBusyId] = useState<string | null>(null)
  /**
   * The row whose Discard has been tapped once and is waiting for a second tap.
   *
   * Discarding is irreversible — it acknowledges the message, so the payment
   * leaves the box for good and can never be credited. It sits next to Retry,
   * so one tap must not be enough.
   */
  const [armedDiscardId, setArmedDiscardId] = useState<string | null>(null)
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** One inbox read at a time — see fetchPayments. */
  const fetchingRef = useRef(false)
  /** A credit pass is running; it refreshes the list itself, so the poll stands off. */
  const acceptingRef = useRef(false)
  /** The live attempt map, for the async credit pass that must not close over stale state. */
  const attemptsRef = useRef<Record<string, InboxAttempt>>({})
  /** Set below to the credit pass; called by fetchPayments, which is declared first. */
  const creditRef = useRef<(list: IncomingPayment[], force?: string[]) => Promise<void>>(async () => {})
  useEffect(() => {
    attemptsRef.current = attempts
  }, [attempts])

  // An armed discard must not stay armed across a screen the user walked away
  // from and came back to.
  useEffect(
    () => () => {
      if (armTimerRef.current) clearTimeout(armTimerRef.current)
    },
    []
  )
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
      try {
        const list = await client.listIncomingPayments(messageBoxUrl)
        setPayments(list)
        // Credit before resolving identities: the money matters and the names are
        // decorative, so nothing about a payment landing waits on an overlay
        // lookup that may never return.
        await creditRef.current(list)
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

  /**
   * Credit everything creditable, automatically.
   *
   * Accepting was never a decision: the money is already the user's and the
   * token is already in their box, so the tap only delayed it. This runs after
   * every list read, and again with `force` when a user retries a row that had
   * given up. autoAcceptInbox holds the policy and its tests; this wires it to
   * the wallet and the screen.
   */
  const creditInbox = useCallback(
    async (list: IncomingPayment[], force?: string[]) => {
      const client = peerPayClient
      if (!client || list.length === 0) return
      acceptingRef.current = true
      try {
        const outcome = await autoAcceptInbox({
          payments: list,
          attempts: attemptsRef.current,
          force,
          // acceptWithRetry re-lists once on failure, which clears the common
          // stale-token case before it is ever counted as an attempt.
          accept: payment => acceptWithRetry(client, messageBoxUrl, payment, INBOX_DESCRIPTION, internalize)
        })
        attemptsRef.current = outcome.attempts
        setAttempts(outcome.attempts)
        if (outcome.accepted > 0) {
          // Full screen and held until acknowledged, not a toast. Money arriving
          // can be missed entirely — phone face down, in a pocket, not being
          // looked at — and whether it landed is the one thing a payee must never
          // be left unsure about. Everything not left in the attempt map was
          // credited, so that is what the figure sums.
          const credited = list.filter(p => !outcome.attempts[String(p.messageId)])
          setReceived({
            amount: credited.reduce((sum, p) => sum + (p.token?.amount ?? 0), 0),
            count: outcome.accepted
          })
        }
      } finally {
        acceptingRef.current = false
      }
    },
    // No `t`: the copy moved into ReceivedOverlay, which translates it itself.
    [peerPayClient, messageBoxUrl, internalize]
  )

  // The credit pass is invoked from fetchPayments, which is declared above it —
  // reached through a ref so neither has to depend on the other.
  useEffect(() => {
    creditRef.current = creditInbox
  }, [creditInbox])

  /** Retry one row that had given up. Runs the whole pass, forcing this id. */
  const handleRetry = useCallback(
    async (payment: IncomingPayment) => {
      const id = String(payment.messageId)
      setArmedDiscardId(null)
      setBusyId(id)
      try {
        await creditInbox(payments, [id])
      } finally {
        setBusyId(null)
      }
    },
    [creditInbox, payments]
  )

  /**
   * Give up on a row. TWO TAPS, and the second one abandons money.
   *
   * The first tap only arms the button and starts a timer, so a mis-tap next to
   * Retry costs nothing. The second acknowledges the message on the MessageBox,
   * which removes it from every future listing — this wallet can never credit
   * that payment again, and the only recovery is asking the sender to resend.
   */
  const handleDiscard = useCallback(
    async (payment: IncomingPayment) => {
      const client = peerPayClient
      if (!client) return
      const id = String(payment.messageId)

      if (armedDiscardId !== id) {
        setArmedDiscardId(id)
        if (armTimerRef.current) clearTimeout(armTimerRef.current)
        // Disarms itself, so a button left armed does not become a one-tap
        // discard for whoever picks the phone up next.
        armTimerRef.current = setTimeout(() => setArmedDiscardId(null), DISCARD_ARM_MS)
        return
      }

      if (armTimerRef.current) clearTimeout(armTimerRef.current)
      setArmedDiscardId(null)
      setBusyId(id)
      try {
        await discardIncoming(client, payment)
        // Drop it locally too: it will never be listed again, so waiting for the
        // next poll would leave a row on screen that no longer exists.
        setAttempts(prev => {
          const next = { ...prev }
          delete next[id]
          attemptsRef.current = next
          return next
        })
        setPayments(prev => prev.filter(p => String(p.messageId) !== id))
        setResult({ type: 'success', message: t('pay_dismissed') })
      } catch (e: any) {
        setResult({ type: 'error', message: e?.message || t('unknown_error') })
      } finally {
        setBusyId(null)
        setTimeout(() => setResult(null), 5000)
      }
    },
    [peerPayClient, armedDiscardId, t]
  )

  /**
   * The rows worth showing: only payments the wallet has given up on. Everything
   * else was credited and acknowledged, so it is gone.
   */
  const attention = useMemo(
    () => payments.filter(p => needsAttention(attempts[String(p.messageId)])),
    [payments, attempts]
  )

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

      {/* Only the payments the wallet gave up on. Everything else was credited
          the moment it was seen, so there is nothing here to accept. */}
      {isConfigured && (
        <AttentionSection
          payments={attention}
          attempts={attempts}
          senderIdentities={senderIdentities}
          busyId={busyId}
          armedDiscardId={armedDiscardId}
          colors={colors}
          t={t}
          onRetry={handleRetry}
          onDiscard={handleDiscard}
        />
      )}
      {result && <ResultBanner result={result} onDismiss={() => setResult(null)} colors={colors} />}

      {/* The moment money arrives. A Modal, so it covers the header too. */}
      {received && (
        <ReceivedOverlay amount={received.amount} count={received.count} onDismiss={() => setReceived(null)} />
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg
  },

  // Needs attention
  attentionHint: {
    ...typography.footnote,
    marginBottom: spacing.md
  },
  attentionError: {
    ...typography.caption1,
    marginTop: spacing.xs
  },
  attentionActions: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.sm
  },
  attentionButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm + 2
  },
  attentionButtonText: {
    ...typography.subhead,
    fontWeight: '500'
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
  paymentActions: {
    alignItems: 'flex-end',
    gap: spacing.xs,
    flexShrink: 0
  },
  paymentAmount: {
    ...typography.footnote,
    fontWeight: '700'
  }
})
