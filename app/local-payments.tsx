/**
 * Local Payments — pay a nearby device.
 *
 * Two transports behind one user-facing flow, both bootstrapped by the same
 * pairing QR minted by the payee:
 *
 *   AWDL  iOS↔iOS peer-to-peer Wi-Fi, TLS-PSK. Fast path.
 *   QR    any platform pair. The payer renders the signed frame; the payee scans it.
 *
 * Phase machine
 *
 *   role
 *    ├─ receive_amount → receive_minting → receive_wait
 *    │      receive_wait always renders the pairing QR, and additionally runs an
 *    │      AWDL listener when this device supports it. Either arrival lands in:
 *    │        · AWDL listener resolves ─┐
 *    │        · receive_scan (payer QR) ─┴→ receive_settling → done
 *    └─ send_scan → send_confirm → send_working
 *           ├─ selectTransport() === 'awdl' → awdlTransport.send → done
 *           └─ selectTransport() === 'qr'   → send_qr → done
 *
 *   failed is terminal for either role. It offers a retry, a route to Settings
 *   when Local Network access is the cause, and — on a failed AWDL send — the
 *   already-built frame as a QR so the payment can still complete.
 *
 * Money safety (see settleReceived below, which is the only write path):
 *   1. isSessionSpent() is consulted before anything is written.
 *   2. savePending() completes before markSessionSpent(). Never the reverse:
 *      a crash between the two would burn a one-shot session whose payment was
 *      never persisted, and that money is unrecoverable.
 *   3. processPending() runs only after savePending() has resolved.
 *   4. The live Session is threaded in as an argument — neither PaymentFrame
 *      nor PendingPayment carries a sessionId, so it cannot be recovered later.
 *   5. Every decode sits in a bare `catch`, which catches non-Error throws from
 *      atob and destructuring too, not just CodecError.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { router, useFocusEffect } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import QRCode from 'react-native-qrcode-svg'
import { createNonce } from '@bsv/sdk'

import QRScanner from '@/components/QRScanner'
import AmountDisplay from '@/components/wallet/AmountDisplay'
import { AmountInput } from '@/components/wallet/AmountInput'
import { useTheme } from '@/context/theme/ThemeContext'
import { radii, spacing, typography } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import { decodeFrame, encodeFrame, type PaymentFrame } from '@/utils/localpay/codec'
import { decodeSession, encodeSession, mintSession, type Session } from '@/utils/localpay/session'
import { isSessionSpent, markSessionSpent, processPending, savePending } from '@/utils/localpay/pending'
import { buildPaymentFrame } from '@/utils/localpay/build'
import { awdlTransport } from '@/utils/localpay/transport/awdl'
import { localSupportsAwdl, selectTransport } from '@/utils/localpay/transport/select'

// ── Types ──

type PayingWalletArg = Parameters<typeof buildPaymentFrame>[0]

type Phase =
  | 'role'
  | 'receive_amount'
  | 'receive_minting'
  | 'receive_wait'
  | 'receive_scan'
  | 'receive_settling'
  | 'send_scan'
  | 'send_confirm'
  | 'send_working'
  | 'send_qr'
  | 'done'
  | 'failed'

interface Failure {
  /** Human-readable cause, shown under the generic failure title. */
  detail: string
  /** Local Network access is off — offer a route to Settings. */
  settings: boolean
}

// ── Frame ⇄ QR ──
//
// encodeFrame() yields bytes; a QR carries a string. base64url keeps the payload
// inside the alphanumeric-safe ASCII range so the encoder never widens a byte to
// two in UTF-8. A ~450-byte frame becomes ~600 chars, well inside a v40 symbol at
// error-correction level M (2,331 bytes).

const FRAME_QR_PREFIX = 'bsvpayf1:'
/** Rendered edge length in points. The brief floors payment QRs at 280. */
const PAYMENT_QR_SIZE = 288

function toB64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = globalThis.atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  return Uint8Array.from(binary, c => c.charCodeAt(0))
}

function frameToQr(frame: PaymentFrame): string {
  return FRAME_QR_PREFIX + toB64url(encodeFrame(frame))
}

function frameFromQr(text: string): PaymentFrame {
  if (!text.startsWith(FRAME_QR_PREFIX)) throw new Error('not a nearby-payment QR')
  return decodeFrame(fromB64url(text.slice(FRAME_QR_PREFIX.length)))
}

/** Never throws — used on failure paths where losing the fallback QR is worse than a null. */
function safeFrameToQr(frame: PaymentFrame): string | null {
  try {
    return frameToQr(frame)
  } catch {
    return null
  }
}

// ── Helpers ──

function messageOf(e: unknown): string {
  if (e instanceof Error && e.message) return e.message
  const text = String(e)
  return text === '[object Object]' ? '' : text
}

/**
 * iOS surfaces a Local Network denial through Network.framework as a policy or
 * routing error rather than a typed permission result, so this is a match on the
 * localized NWError description. Treated as advisory: a false positive only means
 * the user is additionally offered a Settings shortcut.
 */
function looksLikeLocalNetworkDenial(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes('policy') ||
    m.includes('denied') ||
    m.includes('not permitted') ||
    m.includes('no route to host') ||
    m.includes('network is down') ||
    m.includes('-65570')
  )
}

function abbreviateKey(key: string): string {
  return key.length > 16 ? `${key.slice(0, 10)}…${key.slice(-6)}` : key
}

// ── Screen ──

export default function LocalPaymentsScreen() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { managers, adminOriginator, storage } = useWallet()
  const wallet = managers?.permissionsManager ?? null

  const [phase, setPhase] = useState<Phase>('role')
  const [role, setRole] = useState<'payee' | 'payer' | null>(null)

  /** The payee's own minted session — drives the pairing QR and the AWDL listener. */
  const [hostedSession, setHostedSession] = useState<Session | null>(null)
  /** The session the payer scanned off the payee's screen. */
  const [scannedSession, setScannedSession] = useState<Session | null>(null)

  const [requestAmount, setRequestAmount] = useState('')
  const [paymentQr, setPaymentQr] = useState<string | null>(null)
  const [settledAmount, setSettledAmount] = useState(0)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  /** Blur must abort the AWDL listener; refocus must bring it back. */
  const [focused, setFocused] = useState(true)

  // Every in-flight transport call registers its controller here so unmount,
  // back-navigation and reset can all tear the listener down. A leaked listener
  // leaves the device advertising on the local network.
  const abortsRef = useRef<Set<AbortController>>(new Set())
  /** One-shot latch: two concurrent settles would both clear the spent check. */
  const settlingRef = useRef(false)
  /** Ignores the repeat reads multiScan produces while a scan is being handled. */
  const scanLatchRef = useRef(false)

  const abortAll = useCallback(() => {
    for (const controller of abortsRef.current) {
      try {
        controller.abort()
      } catch {
        /* already aborted */
      }
    }
    abortsRef.current.clear()
  }, [])

  useEffect(() => () => abortAll(), [abortAll])

  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => {
        setFocused(false)
        abortAll()
      }
    }, [abortAll])
  )

  const fail = useCallback(
    (kind: 'network' | 'generic', detail?: string) => {
      setFailure(
        kind === 'network'
          ? { detail: t('local_pay_network_denied'), settings: true }
          : { detail: detail && detail.length > 0 ? detail : t('local_pay_failed'), settings: false }
      )
      setPhase('failed')
    },
    [t]
  )

  const reset = useCallback(() => {
    abortAll()
    settlingRef.current = false
    scanLatchRef.current = false
    setPhase('role')
    setRole(null)
    setHostedSession(null)
    setScannedSession(null)
    setRequestAmount('')
    setPaymentQr(null)
    setSettledAmount(0)
    setFailure(null)
    setNotice(null)
  }, [abortAll])

  const goBack = useCallback(() => {
    abortAll()
    router.back()
  }, [abortAll])

  // ── Receive: settle ──
  //
  // The single write path. Called by the AWDL listener and by the QR scanner
  // with whichever Session is live at that moment.

  const settleReceived = useCallback(
    async (frame: PaymentFrame, session: Session) => {
      if (settlingRef.current) return
      settlingRef.current = true
      setPhase('receive_settling')

      if (!storage) {
        settlingRef.current = false
        fail('generic', t('wallet_not_ready'))
        return
      }

      try {
        // (1) One-shot session guard, before anything is written. A re-scanned
        //     or replayed session must never credit twice.
        if (await isSessionSpent(storage, session.sessionId)) {
          fail('generic', t('local_pay_already_paid'))
          return
        }

        // (2) Persist before anything else. Once this resolves the money cannot
        //     be lost to a crash, a dead network or a closed app.
        await savePending(storage, frame)

        // (3) Only now is it safe to burn the session. Doing this first would
        //     mean a crash in between marks the session handled while nothing
        //     was persisted — unrecoverable, because sessions are one-shot.
        try {
          await markSessionSpent(storage, session.sessionId)
        } catch (e) {
          // The frame is already queued, so this is not a payment failure and
          // must not be reported as one. internalizeAction rejecting a repeat of
          // the same output is the backstop against a replay from here.
          console.warn('[localpay] markSessionSpent failed:', messageOf(e))
        }

        setSettledAmount(frame.amount)
        setRole('payee')
        setPhase('done')
        // Clearing the hosted session stops the AWDL listener: this request is settled.
        setHostedSession(null)

        // (4) Internalization is attempted only after the durable write. If it
        //     fails the entry stays queued for the background retry.
        if (!wallet) {
          setNotice(t('local_pay_queued'))
          return
        }
        const results = await processPending(wallet, storage, adminOriginator)
        setNotice(results.some(r => r.success) ? t('local_pay_added') : t('local_pay_queued'))
      } catch (e) {
        settlingRef.current = false
        fail('generic', messageOf(e))
      }
    },
    [storage, wallet, adminOriginator, fail, t]
  )

  // Read through refs so the listener effect below depends only on the session
  // and focus, and is never restarted by an unrelated re-render.
  const settleRef = useRef(settleReceived)
  const failRef = useRef(fail)
  useEffect(() => {
    settleRef.current = settleReceived
    failRef.current = fail
  }, [settleReceived, fail])

  // ── Receive: AWDL listener ──
  //
  // Started only when this device can be an AWDL peer. The pairing QR is rendered
  // regardless, so a QR-path payer can always complete against the same session.

  useEffect(() => {
    if (!hostedSession || !focused) return
    if (!localSupportsAwdl()) return

    // The Set identity is stable for the component's lifetime, but capture it so
    // the cleanup never reaches through a ref that may have been reassigned.
    const registry = abortsRef.current
    const controller = new AbortController()
    registry.add(controller)

    awdlTransport
      .receive(hostedSession, controller.signal)
      .then(frame => {
        if (controller.signal.aborted) return
        void settleRef.current(frame, hostedSession)
      })
      .catch(e => {
        if (controller.signal.aborted) return
        const message = messageOf(e)
        failRef.current(looksLikeLocalNetworkDenial(message) ? 'network' : 'generic', message)
      })

    return () => {
      controller.abort()
      registry.delete(controller)
    }
  }, [hostedSession, focused])

  // ── Receive: mint the request ──

  const startRequest = useCallback(async () => {
    const sats = Math.round(Number(requestAmount))
    if (!Number.isFinite(sats) || sats <= 0) return
    if (!wallet) {
      fail('generic', t('wallet_not_ready'))
      return
    }
    setPhase('receive_minting')
    try {
      const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true }, adminOriginator)
      const derivationPrefix = await createNonce(wallet, 'self', adminOriginator)
      const derivationSuffix = await createNonce(wallet, 'self', adminOriginator)
      const session = mintSession({
        identityKey,
        amount: sats,
        derivationPrefix,
        derivationSuffix,
        // An Android payee advertises no AWDL capability, so the payer's
        // selectTransport() takes the QR path without a negotiation round trip.
        supportsAwdl: localSupportsAwdl()
      })
      setRole('payee')
      setHostedSession(session)
      setPhase('receive_wait')
    } catch (e) {
      fail('generic', messageOf(e))
    }
  }, [requestAmount, wallet, adminOriginator, fail, t])

  // ── Receive: scan the payer's frame ──

  const onFrameScanned = useCallback(
    (data: string) => {
      if (scanLatchRef.current) return
      scanLatchRef.current = true
      const session = hostedSession
      if (!session) {
        fail('generic', t('local_pay_failed'))
        return
      }
      let frame: PaymentFrame
      try {
        // Bare catch on purpose: a structurally valid envelope with malformed
        // base64, or a body that destructures from null, throws something that
        // is not a CodecError — and must still land here, not crash the screen.
        frame = frameFromQr(data)
      } catch {
        fail('generic', t('invalid_qr_code'))
        return
      }
      void settleRef.current(frame, session)
    },
    [hostedSession, fail, t]
  )

  // ── Send: scan the payee's session ──

  const onSessionScanned = useCallback(
    (data: string) => {
      if (scanLatchRef.current) return
      scanLatchRef.current = true
      let session: Session
      try {
        session = decodeSession(data)
      } catch {
        fail('generic', t('invalid_qr_code'))
        return
      }
      setScannedSession(session)
      setRole('payer')
      setPhase('send_confirm')
    },
    [fail, t]
  )

  // ── Send: build and deliver ──

  const executeSend = useCallback(async () => {
    const session = scannedSession
    if (!session) return
    if (!wallet) {
      fail('generic', t('wallet_not_ready'))
      return
    }
    const kind = selectTransport(session)
    setPhase('send_working')

    const controller = new AbortController()
    abortsRef.current.add(controller)
    let built: PaymentFrame | null = null

    try {
      // The structural `PayingWallet` in build.ts pins `createAction().tx` to
      // `number[]`, while the SDK's `AtomicBEEF` is `Byte[] | Uint8Array`. The
      // manager satisfies the contract at runtime — build.ts wraps the result in
      // `new Uint8Array(...)`, which accepts either — so this is nominal only.
      built = await buildPaymentFrame(wallet as unknown as PayingWalletArg, session, kind, adminOriginator)
      if (controller.signal.aborted) return

      if (kind === 'qr') {
        setPaymentQr(frameToQr(built))
        setPhase('send_qr')
        return
      }

      const ack = await awdlTransport.send(session, built, controller.signal)
      if (controller.signal.aborted) return
      if (!ack.ok) {
        setPaymentQr(safeFrameToQr(built))
        fail('generic', ack.error ?? t('local_pay_failed'))
        return
      }
      setSettledAmount(session.amount)
      setPhase('done')
    } catch (e) {
      if (controller.signal.aborted) return
      // The frame is signed but noSend — nothing has left the wallet — so it is
      // safe to offer it as a QR and let the payment complete over the fallback.
      if (built) setPaymentQr(safeFrameToQr(built))
      const message = messageOf(e)
      fail(looksLikeLocalNetworkDenial(message) ? 'network' : 'generic', message)
    } finally {
      abortsRef.current.delete(controller)
    }
  }, [scannedSession, wallet, adminOriginator, fail, t])

  // ── Derived ──

  const sessionQr = useMemo(() => {
    if (!hostedSession) return null
    try {
      return encodeSession(hostedSession)
    } catch {
      return null
    }
  }, [hostedSession])

  const awdlActive = hostedSession !== null && localSupportsAwdl()
  const requestedSats = Math.round(Number(requestAmount))
  const canRequest = Number.isFinite(requestedSats) && requestedSats > 0
  const scannerOpen = phase === 'send_scan' || phase === 'receive_scan'

  const openScanner = useCallback((next: 'send_scan' | 'receive_scan') => {
    scanLatchRef.current = false
    setPhase(next)
  }, [])

  // Dismissing the camera returns to whatever raised it. A payee's request must
  // survive this: closing the scanner is not cancelling the payment.
  const closeScanner = useCallback(() => {
    scanLatchRef.current = false
    setPhase(current => (current === 'receive_scan' ? 'receive_wait' : 'role'))
  }, [])

  const styles = useMemo(() => makeStyles(), [])

  // ── Render ──

  const spinnerBlock = (label: string) => (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={colors.info} style={{ marginBottom: spacing.lg }} />
      <Text style={[styles.phaseSub, { color: colors.textSecondary }]}>{label}</Text>
    </View>
  )

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: colors.separator }]}>
        <TouchableOpacity onPress={goBack} style={styles.headerBtn} accessibilityRole="button">
          <Ionicons name="chevron-back" size={24} color={colors.accent} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>{t('local_payments')}</Text>
        <View style={styles.headerBtn} />
      </View>

      <ScrollView
        style={{ flex: 1, backgroundColor: colors.background }}
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        {/* ══ Choose a role ══ */}
        {phase === 'role' && (
          <>
            <View style={styles.center}>
              <View style={[styles.heroCircle, { backgroundColor: colors.info + '12' }]}>
                <Ionicons name="wifi" size={52} color={colors.info} />
              </View>
              <Text style={[styles.heroText, { color: colors.textSecondary }]}>{t('local_payments_subtitle')}</Text>
            </View>
            <TouchableOpacity
              style={[styles.bigBtn, { backgroundColor: colors.accent }]}
              onPress={() => setPhase('receive_amount')}
            >
              <Ionicons name="download-outline" size={22} color={colors.textOnAccent} />
              <Text style={[styles.bigBtnText, { color: colors.textOnAccent }]}>{t('local_pay_request')}</Text>
            </TouchableOpacity>
            <View style={{ height: spacing.md }} />
            <TouchableOpacity
              style={[styles.bigBtn, { backgroundColor: colors.success }]}
              onPress={() => openScanner('send_scan')}
            >
              <Ionicons name="send-outline" size={22} color="#fff" />
              <Text style={[styles.bigBtnText, { color: '#fff' }]}>{t('local_pay_send')}</Text>
            </TouchableOpacity>
          </>
        )}

        {/* ══ Receive: amount ══ */}
        {phase === 'receive_amount' && (
          <View>
            <Text style={[styles.phaseTitle, { color: colors.textPrimary }]}>{t('local_pay_request')}</Text>
            <Text style={[styles.phaseSub, { color: colors.textSecondary }]}>{t('local_pay_enter_amount')}</Text>
            <Text style={[styles.fieldLabel, { color: colors.textTertiary }]}>
              {t('local_pay_amount').toUpperCase()}
            </Text>
            <AmountInput value={requestAmount} onChangeText={setRequestAmount} />
            <TouchableOpacity
              style={[
                styles.bigBtn,
                { backgroundColor: canRequest ? colors.accent : colors.fill, marginTop: spacing.xl }
              ]}
              onPress={() => void startRequest()}
              disabled={!canRequest}
            >
              <Text style={[styles.bigBtnText, { color: canRequest ? colors.textOnAccent : colors.textTertiary }]}>
                {t('continue_action')}
              </Text>
            </TouchableOpacity>
            <CancelBtn colors={colors} styles={styles} label={t('cancel')} onPress={reset} />
          </View>
        )}

        {phase === 'receive_minting' && spinnerBlock(t('local_pay_preparing'))}
        {phase === 'receive_settling' && spinnerBlock(t('local_pay_saving'))}
        {phase === 'send_working' && spinnerBlock(t('local_pay_delivering'))}

        {/* ══ Receive: pairing QR (always) + AWDL listener (when supported) ══ */}
        {phase === 'receive_wait' && hostedSession && (
          <View style={styles.center}>
            <Text style={[styles.phaseTitle, { color: colors.textPrimary }]}>{t('local_pay_show_qr')}</Text>
            <Text style={[styles.phaseSub, { color: colors.textSecondary }]}>
              <AmountDisplay>{hostedSession.amount}</AmountDisplay>
            </Text>

            {sessionQr ? (
              <View style={[styles.qrCard, { shadowColor: colors.textPrimary }]}>
                <QRCode value={sessionQr} size={PAYMENT_QR_SIZE} ecl="M" color="#000" backgroundColor="#fff" />
              </View>
            ) : (
              <Text style={[styles.phaseSub, { color: colors.error }]}>{t('local_pay_failed')}</Text>
            )}

            <View style={[styles.badge, { backgroundColor: colors.fillTertiary }]}>
              <Ionicons
                name={awdlActive ? 'wifi' : 'qr-code-outline'}
                size={14}
                color={awdlActive ? colors.info : colors.textSecondary}
              />
              <Text style={[styles.badgeText, { color: colors.textSecondary }]}>
                {awdlActive ? t('local_pay_via_nearby') : t('local_pay_via_qr')}
              </Text>
            </View>

            {awdlActive && (
              <View style={styles.waitingRow}>
                <ActivityIndicator size="small" color={colors.info} />
                <Text style={[styles.waitingText, { color: colors.textTertiary }]}>{t('local_pay_waiting')}</Text>
              </View>
            )}

            <TouchableOpacity
              style={[styles.outlineBtn, { borderColor: colors.separator }]}
              onPress={() => openScanner('receive_scan')}
            >
              <Ionicons name="scan-outline" size={18} color={colors.accent} />
              <Text style={[styles.outlineBtnText, { color: colors.accent }]}>{t('local_pay_scan_payer_qr')}</Text>
            </TouchableOpacity>

            <CancelBtn colors={colors} styles={styles} label={t('cancel')} onPress={reset} />
          </View>
        )}

        {/* ══ Send: confirm ══ */}
        {phase === 'send_confirm' && scannedSession && (
          <View>
            <Text style={[styles.phaseTitle, { color: colors.textPrimary }]}>{t('local_pay_send')}</Text>
            <View style={styles.center}>
              <Text style={[styles.bigAmount, { color: colors.textPrimary }]}>
                <AmountDisplay>{scannedSession.amount}</AmountDisplay>
              </Text>
            </View>
            <View
              style={[styles.idCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.separator }]}
            >
              <View style={[styles.avatarPlaceholder, { backgroundColor: colors.info + '15' }]}>
                <Ionicons name="person" size={22} color={colors.info} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[styles.idName, { color: colors.textPrimary }]}>{t('recipient')}</Text>
                <Text style={[styles.idKey, { color: colors.textTertiary }]} numberOfLines={1} ellipsizeMode="middle">
                  {abbreviateKey(scannedSession.identityKey)}
                </Text>
              </View>
            </View>

            <View style={[styles.badge, { backgroundColor: colors.fillTertiary, alignSelf: 'center' }]}>
              <Ionicons
                name={selectTransport(scannedSession) === 'awdl' ? 'wifi' : 'qr-code-outline'}
                size={14}
                color={colors.textSecondary}
              />
              <Text style={[styles.badgeText, { color: colors.textSecondary }]}>
                {selectTransport(scannedSession) === 'awdl' ? t('local_pay_via_nearby') : t('local_pay_via_qr')}
              </Text>
            </View>

            <TouchableOpacity
              style={[styles.bigBtn, { backgroundColor: colors.success, marginTop: spacing.lg }]}
              onPress={() => void executeSend()}
            >
              <Ionicons name="send" size={20} color="#fff" />
              <Text style={[styles.bigBtnText, { color: '#fff' }]}>{t('local_pay_send')}</Text>
            </TouchableOpacity>
            <CancelBtn colors={colors} styles={styles} label={t('cancel')} onPress={reset} />
          </View>
        )}

        {/* ══ Send: hand the frame over as a QR ══ */}
        {phase === 'send_qr' && paymentQr && (
          <View style={styles.center}>
            <Text style={[styles.phaseTitle, { color: colors.textPrimary }]}>{t('local_pay_show_payment_qr')}</Text>
            <View style={[styles.qrCard, { shadowColor: colors.textPrimary }]}>
              <QRCode value={paymentQr} size={PAYMENT_QR_SIZE} ecl="M" color="#000" backgroundColor="#fff" />
            </View>
            <TouchableOpacity
              style={[styles.bigBtn, { backgroundColor: colors.accent, marginTop: spacing.lg }]}
              onPress={() => {
                setSettledAmount(scannedSession?.amount ?? 0)
                setRole('payer')
                setPhase('done')
              }}
            >
              <Text style={[styles.bigBtnText, { color: colors.textOnAccent }]}>{t('done')}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ══ Done ══ */}
        {phase === 'done' && (
          <View style={styles.center}>
            <Ionicons name="checkmark-circle" size={72} color={colors.success} style={{ marginBottom: spacing.md }} />
            <Text style={[styles.phaseTitle, { color: colors.textPrimary }]}>
              {role === 'payer' ? t('local_pay_sent') : t('local_pay_received')}
            </Text>
            <Text style={[styles.bigAmount, { color: colors.textPrimary }]}>
              <AmountDisplay>{settledAmount}</AmountDisplay>
            </Text>
            {notice && (
              <View
                style={[styles.note, { backgroundColor: colors.success + '15', borderColor: colors.success + '40' }]}
              >
                <Ionicons name="wallet-outline" size={16} color={colors.success} />
                <Text style={[styles.noteText, { color: colors.success }]}>{notice}</Text>
              </View>
            )}
            <TouchableOpacity style={[styles.bigBtn, { backgroundColor: colors.accent }]} onPress={goBack}>
              <Text style={[styles.bigBtnText, { color: colors.textOnAccent }]}>{t('done')}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ══ Failed ══ */}
        {phase === 'failed' && (
          <View style={styles.center}>
            <Ionicons name="alert-circle" size={72} color={colors.error} style={{ marginBottom: spacing.md }} />
            <Text style={[styles.phaseTitle, { color: colors.textPrimary }]}>{t('local_pay_failed')}</Text>
            <Text style={[styles.phaseSub, { color: colors.textSecondary }]}>{failure?.detail}</Text>

            {failure?.settings && (
              <TouchableOpacity
                style={[styles.bigBtn, { backgroundColor: colors.info, marginBottom: spacing.md }]}
                onPress={() => void Linking.openSettings()}
              >
                <Ionicons name="settings-outline" size={18} color="#fff" />
                <Text style={[styles.bigBtnText, { color: '#fff' }]}>{t('open_settings')}</Text>
              </TouchableOpacity>
            )}

            {paymentQr && (
              <TouchableOpacity
                style={[styles.outlineBtn, { borderColor: colors.separator, marginBottom: spacing.md }]}
                onPress={() => {
                  setFailure(null)
                  setPhase('send_qr')
                }}
              >
                <Ionicons name="qr-code-outline" size={18} color={colors.accent} />
                <Text style={[styles.outlineBtnText, { color: colors.accent }]}>{t('local_pay_show_qr_instead')}</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity style={[styles.bigBtn, { backgroundColor: colors.accent }]} onPress={reset}>
              <Text style={[styles.bigBtnText, { color: colors.textOnAccent }]}>{t('retry')}</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      {/* ══ Scanner ══ */}
      <Modal visible={scannerOpen} animationType="slide" onRequestClose={closeScanner} statusBarTranslucent>
        <StatusBar style="light" />
        <QRScanner
          multiScan
          onScan={phase === 'send_scan' ? onSessionScanned : onFrameScanned}
          onClose={closeScanner}
          hintText={phase === 'send_scan' ? t('local_pay_scan_qr') : t('local_pay_scan_payer_qr')}
        />
      </Modal>
    </View>
  )
}

// ── Small components ──

function CancelBtn({
  colors,
  styles,
  label,
  onPress
}: {
  colors: ReturnType<typeof useTheme>['colors']
  styles: ReturnType<typeof makeStyles>
  label: string
  onPress: () => void
}) {
  return (
    <TouchableOpacity style={[styles.cancelBtn, { borderColor: colors.separator }]} onPress={onPress}>
      <Text style={[styles.cancelBtnText, { color: colors.textSecondary }]}>{label}</Text>
    </TouchableOpacity>
  )
}

// ── Styles ──

function makeStyles() {
  return StyleSheet.create({
    container: { flex: 1 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth
    },
    headerBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    headerTitle: { ...typography.headline, fontWeight: '600' },
    scroll: { padding: spacing.lg, paddingBottom: spacing.xxxl },

    center: { alignItems: 'center', paddingVertical: spacing.xl },
    heroCircle: {
      width: 100,
      height: 100,
      borderRadius: 50,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing.md
    },
    heroText: { ...typography.subhead, textAlign: 'center', paddingHorizontal: spacing.lg, marginBottom: spacing.xl },

    bigBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      alignSelf: 'stretch',
      gap: spacing.sm,
      paddingVertical: 14,
      borderRadius: radii.md
    },
    bigBtnText: { ...typography.body, fontWeight: '600' },

    outlineBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      alignSelf: 'stretch',
      gap: spacing.sm,
      paddingVertical: spacing.md,
      borderRadius: radii.md,
      borderWidth: StyleSheet.hairlineWidth,
      marginTop: spacing.lg
    },
    outlineBtnText: { ...typography.subhead, fontWeight: '500' },

    phaseTitle: { ...typography.title3, fontWeight: '700', textAlign: 'center' },
    phaseSub: { ...typography.subhead, textAlign: 'center', marginBottom: spacing.lg },
    fieldLabel: { ...typography.caption2, fontWeight: '600', letterSpacing: 0.8, marginBottom: spacing.sm },

    qrCard: {
      backgroundColor: '#fff',
      padding: spacing.lg,
      borderRadius: radii.xl,
      marginBottom: spacing.lg,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.1,
      shadowRadius: 16,
      elevation: 6
    },

    badge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      borderRadius: radii.pill,
      paddingVertical: spacing.xs,
      paddingHorizontal: spacing.md
    },
    badgeText: { ...typography.caption1, fontWeight: '500' },

    waitingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
    waitingText: { ...typography.footnote },

    idCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      padding: spacing.md,
      borderRadius: radii.lg,
      borderWidth: StyleSheet.hairlineWidth,
      marginBottom: spacing.lg
    },
    avatarPlaceholder: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
    idName: { ...typography.body, fontWeight: '600', marginBottom: 1 },
    idKey: { ...typography.caption2, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },

    bigAmount: { fontSize: 34, fontWeight: '700', letterSpacing: 0.4, marginBottom: spacing.lg },

    note: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      borderRadius: radii.md,
      borderWidth: 1,
      marginBottom: spacing.lg,
      alignSelf: 'stretch'
    },
    noteText: { ...typography.subhead, flex: 1 },

    cancelBtn: {
      alignItems: 'center',
      alignSelf: 'stretch',
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.lg,
      borderRadius: radii.md,
      borderWidth: 1,
      marginTop: spacing.xl
    },
    cancelBtnText: { ...typography.body, fontWeight: '500' }
  })
}
