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
 *    │        · receive_scan (payer QR) ─┴→ receive_settling → done | already_paid
 *    └─ send_scan → send_confirm → send_working
 *           ├─ selectTransport() === 'awdl' → awdlTransport.send → done
 *           └─ selectTransport() === 'qr'   → send_qr → done
 *
 *   already_paid is a SUCCESS terminal, not an error: the session was settled by
 *   an earlier delivery, so that money is already queued. It is the expected end
 *   of both legitimate rescan paths and must never offer a retry, because a retry
 *   mints a fresh session and invites a second payment.
 *
 *   failed is terminal for either role. It offers a retry, a route to Settings
 *   when Local Network access is the cause, a re-settle when a delivered frame
 *   could not be persisted, and — on a failed AWDL send — the already-built frame
 *   as a QR so the payment can still complete.
 *
 *   An AWDL listener error does NOT terminate the screen: the fast path is
 *   optional, so it degrades to a QR-only request with the pairing QR still up.
 *
 * Money safety (see settleReceived below, which is the only write path):
 *   0. The frame is bound to the session before anything else: a frame whose
 *      derivation nonces or amount do not match the live request is refused
 *      without burning the session, so the real payer can still pay.
 *   1. isSessionSpent() is consulted before anything is written.
 *   2. savePending() completes before markSessionSpent(). Never the reverse:
 *      a crash between the two would burn a one-shot session whose payment was
 *      never persisted, and that money is unrecoverable.
 *   3. processPending() runs only after savePending() has resolved, outside the
 *      try that can flip the screen to a failure. Once the frame is queued the
 *      payment cannot be lost, so reporting failure past that line would invite
 *      a duplicate payment — the same misreport refused for markSessionSpent.
 *   4. The live Session is threaded in as an argument — neither PaymentFrame
 *      nor PendingPayment carries a sessionId, so it cannot be recovered later.
 *   5. Every decode sits in a bare `catch`, which catches non-Error throws from
 *      atob and destructuring too, not just CodecError.
 *
 * Money safety, payer side (see abortBuild below):
 *   The frame is built `noSend`, which holds `amount + fee` in inputs marked
 *   unspendable. Nothing in storage ever reaps a 'nosend' action, so an
 *   abandoned build locks those funds permanently. abortBuild() releases them —
 *   but ONLY on paths where the frame provably never left the device. Once
 *   delivery is even possible the action must stay intact, because the payee may
 *   still broadcast it and a freed input can be respent into a conflict.
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
import { MAX_FRAME_QR_CHARS, frameFromQr, frameToQr, type PaymentFrame } from '@/utils/localpay/codec'
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
  | 'already_paid'
  | 'failed'

interface Failure {
  /** Human-readable cause, shown under the generic failure title. */
  detail: string
  /** Local Network access is off — offer a route to Settings. */
  settings: boolean
}

/** A frame that reached this device but could not be persisted. Retried, never discarded. */
interface Unsettled {
  frame: PaymentFrame
  session: Session
}

/** Rendered edge length in points. The brief floors payment QRs at 280. */
const PAYMENT_QR_SIZE = 288

// ── Helpers ──

/**
 * A QR payload for `frame`, or null when it cannot be rendered.
 *
 * `react-native-qrcode-svg` rethrows out of render when a payload does not fit
 * the symbol, and the app-level ErrorBoundary then replaces the whole app — so
 * an oversize frame must be caught here, before it is ever handed to <QRCode>.
 * `PaymentFrame.transaction` is AtomicBEEF, whose size tracks input count, so
 * multi-input payments routinely exceed the ceiling.
 */
function frameQrOrNull(frame: PaymentFrame): string | null {
  try {
    const qr = frameToQr(frame)
    return qr.length <= MAX_FRAME_QR_CHARS ? qr : null
  } catch {
    return null
  }
}

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

  /**
   * A frame that was delivered but could not be persisted. Held so the payee can
   * retry against the SAME session: dropping it would lose a payment the payer
   * already considers sent, and reset() would mint a session that can never
   * receive it.
   */
  const [unsettled, setUnsettled] = useState<Unsettled | null>(null)

  /**
   * The AWDL fast path gave up. Non-fatal by design — the pairing QR is still on
   * screen and a QR-path payer can still complete, so this only downgrades the
   * request to QR-only.
   */
  const [nearbyError, setNearbyError] = useState<{ networkDenied: boolean } | null>(null)

  /** The encoder rejected the pairing payload. Should be unreachable at ~170 chars. */
  const [sessionQrBroken, setSessionQrBroken] = useState(false)

  /**
   * A frame arrived that does not belong to this request. Advisory, not fatal:
   * the session is deliberately left live so the real payer can still pay.
   */
  const [sessionMismatch, setSessionMismatch] = useState(false)

  /**
   * Bumped to restart the AWDL listener. A rejected frame resolves the listener
   * promise, so without this the fast path would stay dead for the rest of a
   * session that is still accepting payment.
   */
  const [listenerEpoch, setListenerEpoch] = useState(0)

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

  /**
   * Whether this device can be an AWDL peer. Resolved ONCE per mount.
   *
   * `localSupportsAwdl()` is not a cheap predicate: each call constructs a
   * throwaway NWListener in Swift on the JS thread, and can trigger the Local
   * Network permission alert. It was previously called from render and twice
   * more per render of the confirm screen. The answer cannot change while the
   * screen is mounted, so every read goes through this.
   */
  const supportsAwdl = useMemo(() => localSupportsAwdl(), [])

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
    setUnsettled(null)
    setNearbyError(null)
    setSessionQrBroken(false)
    setSessionMismatch(false)
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

      // (0) Bind the frame to THIS session, before the one-shot latch and before
      //     any write. Two distinct holes close here:
      //
      //     · frame.amount is display-only — internalizeAction credits whatever
      //       the output actually holds — so a payer could send 1 satoshi against
      //       a 100,000 request with amount: 100000 in the frame and the payee's
      //       screen would read "Received 100,000".
      //     · onFrameScanned hands ANY decoded frame to the live hostedSession, so
      //       scanning a stray payment QR would queue a stranger's payment AND burn
      //       this session. The real payer would then be told already_paid, acked
      //       ok, and silently discarded.
      //
      //     The nonces are the load-bearing check: derivationPrefix/Suffix are the
      //     per-session values the payee minted and the payer echoed back, so
      //     matching them is what makes the frame provably intended for this
      //     request. The amount check rides along to pin the displayed figure.
      //
      //     Deliberately NOT terminal, and deliberately does NOT mark the session
      //     spent: the request stays live so the genuine payer can still complete.
      if (
        frame.derivationPrefix !== session.derivationPrefix ||
        frame.derivationSuffix !== session.derivationSuffix ||
        frame.amount !== session.amount
      ) {
        scanLatchRef.current = false
        setSessionMismatch(true)
        // Back to the waiting screen with the pairing QR still up, and restart
        // the AWDL listener the rejected frame consumed.
        setPhase('receive_wait')
        setListenerEpoch(n => n + 1)
        return
      }

      settlingRef.current = true
      setSessionMismatch(false)
      setPhase('receive_settling')

      if (!storage) {
        // The frame already reached this device — the payer believes it is sent —
        // so hold it for a retry rather than discarding it.
        settlingRef.current = false
        setUnsettled({ frame, session })
        fail('generic', t('wallet_not_ready'))
        return
      }

      // ── Durable-write section ──
      // Everything that can legitimately be reported as a payment failure lives
      // in here, and only in here. Past the closing brace the money is safe.
      try {
        // (1) One-shot session guard, before anything is written. A re-scanned
        //     or replayed session must never credit twice.
        if (await isSessionSpent(storage, session.sessionId)) {
          // Not a failure: that session's payment is already queued. Terminal,
          // and deliberately without a retry — retrying mints a new session and
          // would ask the payer to pay a second time.
          setHostedSession(null)
          setUnsettled(null)
          setPhase('already_paid')
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
          // must not be reported as one. internalizeAction is idempotent on a
          // repeat of the same output — the toolbox merges "wallet payment"
          // internalizations by txid and skips the second credit — so a replay
          // from here cannot double-credit.
          console.warn('[localpay] markSessionSpent failed:', messageOf(e))
        }
      } catch (e) {
        // Reached only while the frame is still un-persisted, so this is a real
        // failure. Keep the frame and the session so the payee can retry the
        // same settle instead of losing a payment to a transient SQLite error.
        settlingRef.current = false
        setUnsettled({ frame, session })
        fail('generic', messageOf(e))
        return
      }

      // ── Past here the frame is durably queued ──
      // The payment cannot be lost, so nothing below may flip the screen to a
      // failure. A payee who is told "failed" taps Retry, mints a fresh session,
      // and the payer builds a second createAction from different UTXOs: both
      // internalize, the payee is credited twice and the payer pays twice.
      setSettledAmount(frame.amount)
      setRole('payee')
      setPhase('done')
      setUnsettled(null)
      // Clearing the hosted session stops the AWDL listener: this request is settled.
      setHostedSession(null)

      // (4) Internalization is attempted only after the durable write, and its
      //     failure only downgrades the notice. processPending awaits storage
      //     outside its own per-entry try, so it can reject as a whole; the entry
      //     stays queued either way for the background retry.
      if (!wallet) {
        setNotice(t('local_pay_queued'))
        return
      }
      try {
        const results = await processPending(wallet, storage, adminOriginator)
        setNotice(results.some(r => r.success) ? t('local_pay_added') : t('local_pay_queued'))
      } catch (e) {
        console.warn('[localpay] processPending failed:', messageOf(e))
        setNotice(t('local_pay_queued'))
      }
    },
    [storage, wallet, adminOriginator, fail, t]
  )

  // Read through refs so the listener effect below depends only on the session
  // and focus, and is never restarted by an unrelated re-render.
  const settleRef = useRef(settleReceived)
  useEffect(() => {
    settleRef.current = settleReceived
  }, [settleReceived])

  // ── Receive: AWDL listener ──
  //
  // Started only when this device can be an AWDL peer. The pairing QR is rendered
  // regardless, so a QR-path payer can always complete against the same session.

  useEffect(() => {
    if (!hostedSession || !focused) return
    if (!supportsAwdl) return

    // The Set identity is stable for the component's lifetime, but capture it so
    // the cleanup never reaches through a ref that may have been reassigned.
    const registry = abortsRef.current
    const controller = new AbortController()
    registry.add(controller)
    setNearbyError(null)

    awdlTransport
      .receive(hostedSession, controller.signal)
      .then(frame => {
        if (controller.signal.aborted) return
        void settleRef.current(frame, hostedSession)
      })
      .catch(e => {
        if (controller.signal.aborted) return
        // Never terminal. AWDL is the optional fast path; failing it must not
        // unmount the pairing QR a QR-path payer is relying on. One native error
        // site also fires on a failed ack AFTER the frame reached JS, so flipping
        // to a failure screen here could contradict a settle already in flight.
        setNearbyError({ networkDenied: looksLikeLocalNetworkDenial(messageOf(e)) })
      })

    return () => {
      controller.abort()
      registry.delete(controller)
    }
  }, [hostedSession, focused, supportsAwdl, listenerEpoch])

  // ── Receive: mint the request ──

  const startRequest = useCallback(async () => {
    const sats = Math.round(Number(requestAmount))
    if (!Number.isFinite(sats) || sats <= 0) return
    // Gate on storage too, not just the wallet. Advertising with storage null
    // means a payer can deliver a frame the payee then cannot persist, after the
    // transport has already acked it as accepted.
    if (!wallet || !storage) {
      fail('generic', t('wallet_not_ready'))
      return
    }
    setPhase('receive_minting')
    setNearbyError(null)
    setSessionQrBroken(false)
    setSessionMismatch(false)
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
        supportsAwdl
      })
      setRole('payee')
      setHostedSession(session)
      setPhase('receive_wait')
    } catch (e) {
      fail('generic', messageOf(e))
    }
  }, [requestAmount, wallet, storage, adminOriginator, supportsAwdl, fail, t])

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

  /**
   * The transport this payment will take. Memoized per scanned session:
   * selectTransport() reaches through to localSupportsAwdl(), which is a native
   * call, and the confirm screen reads it twice on every render.
   *
   * Declared above executeSend on purpose — a useCallback dependency array is
   * evaluated at render time, so referencing it from below would hit the TDZ.
   */
  const sendKind = useMemo(
    () => (scannedSession ? selectTransport(scannedSession) : null),
    [scannedSession]
  )

  // ── Send: release an abandoned build ──
  //
  // buildPaymentFrame creates the action with `noSend: true`, which flips its
  // inputs to `spendable: false`. The storage sweeper (TaskFailAbandoned) reaps
  // only 'unprocessed' and 'unsigned' actions — never 'nosend' — so a build that
  // is abandoned locks `amount + fee` in this wallet permanently and silently.
  //
  // Only ever call this where the frame PROVABLY never left the device. Never
  // after a possible delivery: the payee may still broadcast, and freeing the
  // inputs here would let this wallet respend them into a conflicting tx.
  // Fire-and-forget — an abort failure is a stuck UTXO, not a lost payment, and
  // must not overwrite the real error already on screen.

  const abortBuild = useCallback(
    (reference: string | undefined) => {
      if (!reference || !wallet) return
      void (wallet as unknown as PayingWalletArg)
        .abortAction({ reference }, adminOriginator)
        .catch(e => console.warn('[localpay] abortAction failed:', messageOf(e)))
    },
    [wallet, adminOriginator]
  )

  // ── Send: build and deliver ──

  const executeSend = useCallback(async () => {
    const session = scannedSession
    if (!session || !sendKind) return
    if (!wallet) {
      fail('generic', t('wallet_not_ready'))
      return
    }
    setPhase('send_working')

    const registry = abortsRef.current
    const controller = new AbortController()
    registry.add(controller)

    try {
      let built: Awaited<ReturnType<typeof buildPaymentFrame>>
      try {
        // The structural `PayingWallet` in build.ts pins `createAction().tx` to
        // `number[]`, while the SDK's `AtomicBEEF` is `Byte[] | Uint8Array`. The
        // manager satisfies the contract at runtime — build.ts wraps the result in
        // `new Uint8Array(...)`, which accepts either — so this is nominal only.
        built = await buildPaymentFrame(wallet as unknown as PayingWalletArg, session, adminOriginator)
      } catch (e) {
        // Build errors are wallet errors and must keep their own message. A
        // declined spending prompt reads "Permission denied", which the Local
        // Network heuristic would otherwise misread into an Open Settings button
        // for the wrong permission, discarding the real reason. Nothing was
        // built, so there is nothing to abort.
        if (!controller.signal.aborted) fail('generic', messageOf(e))
        return
      }
      if (controller.signal.aborted) {
        // The user backed out or the screen blurred while "Delivering…" was up.
        // The frame was never handed to a transport and never rendered.
        abortBuild(built.reference)
        return
      }

      // Computed once, before anything can render it. Null means the frame is
      // too large for a symbol — AtomicBEEF grows with input count — and handing
      // it to <QRCode> would throw during render and take the app down.
      const qr = frameQrOrNull(built.frame)

      if (sendKind === 'qr') {
        if (!qr) {
          // The only transport for this pair is a QR the frame cannot fit in,
          // so it can never be delivered. Release the inputs — and, having
          // released them, make sure no earlier frame is left on offer.
          abortBuild(built.reference)
          setPaymentQr(null)
          fail('generic', t('local_pay_too_large'))
          return
        }
        setPaymentQr(qr)
        setPhase('send_qr')
        return
      }

      try {
        const ack = await awdlTransport.send(session, built.frame, controller.signal)
        if (controller.signal.aborted) return
        if (!ack.ok) {
          // An explicit decline: the peer processed the frame and refused it, so
          // nothing was accepted and the inputs can be released. Because they
          // are released, the frame must NOT then be offered as a QR fallback —
          // handing over a transaction whose inputs this wallet now considers
          // free invites a double-spend. Clearing paymentQr also drops any stale
          // QR left by an earlier attempt.
          abortBuild(built.reference)
          setPaymentQr(null)
          fail('generic', ack.error ?? t('local_pay_failed'))
          return
        }
        setSettledAmount(session.amount)
        setPhase('done')
      } catch (e) {
        if (controller.signal.aborted) return
        // Deliberately NOT aborted. A throw here does not prove non-delivery —
        // the bytes may have reached the peer before the ack was lost — so the
        // action must stay intact and spendable-by-the-payee. The frame is
        // signed but noSend, so offering it as a QR lets the payment still
        // complete. `qr` is null when it would not fit, hiding that offer.
        setPaymentQr(qr)
        const message = messageOf(e)
        // The heuristic is scoped to the transport call: only here can a message
        // legitimately be about Local Network access.
        fail(looksLikeLocalNetworkDenial(message) ? 'network' : 'generic', message)
      }
    } finally {
      registry.delete(controller)
    }
  }, [scannedSession, sendKind, wallet, adminOriginator, abortBuild, fail, t])

  // ── Receive: retry a settle that never reached storage ──

  const retrySettle = useCallback(() => {
    if (!unsettled) return
    setFailure(null)
    void settleRef.current(unsettled.frame, unsettled.session)
  }, [unsettled])

  // ── QR encoder failures ──
  //
  // react-native-qrcode-svg calls onError from inside its own render and returns
  // null; without a handler it rethrows and the app-level ErrorBoundary replaces
  // the whole app. Flipping parent state synchronously from a child's render
  // triggers React's cross-component update warning, so both handlers defer by a
  // microtask. These are backstops — frameQrOrNull() already gates on length.

  const onSessionQrError = useCallback(() => {
    void Promise.resolve().then(() => setSessionQrBroken(true))
  }, [])

  const onPaymentQrError = useCallback(() => {
    void Promise.resolve().then(() => {
      setPaymentQr(null)
      fail('generic', t('local_pay_too_large'))
    })
  }, [fail, t])

  // ── Derived ──

  const sessionQr = useMemo(() => {
    if (!hostedSession) return null
    try {
      return encodeSession(hostedSession)
    } catch {
      return null
    }
  }, [hostedSession])

  /** Listening over AWDL right now. Goes false once the fast path gives up. */
  const awdlActive = hostedSession !== null && supportsAwdl && nearbyError === null
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

            {sessionQr && !sessionQrBroken ? (
              <View style={[styles.qrCard, { shadowColor: colors.textPrimary }]}>
                {/* onError is mandatory: without it the encoder rethrows from
                    render and the app-level ErrorBoundary swallows the app. */}
                <QRCode
                  value={sessionQr}
                  size={PAYMENT_QR_SIZE}
                  ecl="M"
                  color="#000"
                  backgroundColor="#fff"
                  onError={onSessionQrError}
                />
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

            {/* A frame arrived that belongs to a different request. Advisory,
                not a failure: this session was deliberately NOT marked spent,
                so the pairing QR above is still live for the real payer. */}
            {sessionMismatch && (
              <View style={[styles.note, { backgroundColor: colors.error + '15', borderColor: colors.error + '40' }]}>
                <Ionicons name="alert-circle-outline" size={16} color={colors.error} />
                <Text style={[styles.noteText, { color: colors.error }]}>{t('local_pay_wrong_session')}</Text>
              </View>
            )}

            {/* The fast path gave up. The request is still live over QR, so this
                is an advisory, not a failure — the pairing QR above still works. */}
            {nearbyError && (
              <View style={[styles.note, { backgroundColor: colors.fillTertiary, borderColor: colors.separator }]}>
                <Ionicons name="information-circle-outline" size={16} color={colors.textSecondary} />
                <Text style={[styles.noteText, { color: colors.textSecondary }]}>
                  {nearbyError.networkDenied ? t('local_pay_network_denied') : t('local_pay_nearby_unavailable')}
                </Text>
              </View>
            )}

            {nearbyError?.networkDenied && (
              <TouchableOpacity
                style={[styles.outlineBtn, { borderColor: colors.separator }]}
                onPress={() => void Linking.openSettings()}
              >
                <Ionicons name="settings-outline" size={18} color={colors.accent} />
                <Text style={[styles.outlineBtnText, { color: colors.accent }]}>{t('open_settings')}</Text>
              </TouchableOpacity>
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
                name={sendKind === 'awdl' ? 'wifi' : 'qr-code-outline'}
                size={14}
                color={colors.textSecondary}
              />
              <Text style={[styles.badgeText, { color: colors.textSecondary }]}>
                {sendKind === 'awdl' ? t('local_pay_via_nearby') : t('local_pay_via_qr')}
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
              {/* onError is mandatory: without it an oversize payload rethrows
                  from render and the app-level ErrorBoundary swallows the app. */}
              <QRCode
                value={paymentQr}
                size={PAYMENT_QR_SIZE}
                ecl="M"
                color="#000"
                backgroundColor="#fff"
                onError={onPaymentQrError}
              />
            </View>
            {/* Deliberately does NOT abort the build.
                The QR path has no ack by design, so this screen cannot know
                whether the payee scanned. "Done" is modelled as the SUCCESS
                terminal for this path — it goes straight to "Payment sent" —
                so the overwhelmingly likely reading is "the payee has it".
                Aborting would free inputs the payee is about to broadcast and
                let this wallet respend them into a conflicting transaction,
                turning a stuck UTXO into a failed payment. The abandoned-build
                lock is the strictly safer of the two failure modes here. */}
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

        {/* ══ Already paid — a success terminal, not an error ══ */}
        {phase === 'already_paid' && (
          <View style={styles.center}>
            <Ionicons name="checkmark-done-circle" size={72} color={colors.info} style={{ marginBottom: spacing.md }} />
            <Text style={[styles.phaseTitle, { color: colors.textPrimary }]}>{t('local_pay_already_paid')}</Text>
            <Text style={[styles.phaseSub, { color: colors.textSecondary }]}>{t('local_pay_queued')}</Text>
            {/* Deliberately no retry: reset() would mint a fresh session and ask
                the payer to pay a second time for money already queued here. */}
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

            {/* A frame reached this device but never reached storage. Retry the
                SAME session — reset() would mint one that can never receive it. */}
            {unsettled && (
              <TouchableOpacity
                style={[styles.bigBtn, { backgroundColor: colors.info, marginBottom: spacing.md }]}
                onPress={retrySettle}
              >
                <Ionicons name="refresh" size={18} color="#fff" />
                <Text style={[styles.bigBtnText, { color: '#fff' }]}>{t('local_pay_retry_save')}</Text>
              </TouchableOpacity>
            )}

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

            {/* With a frame in hand, reset() means abandoning it — the frame lives
                only in memory — so it is demoted to the secondary action. */}
            {unsettled ? (
              <CancelBtn colors={colors} styles={styles} label={t('cancel')} onPress={reset} />
            ) : (
              <TouchableOpacity style={[styles.bigBtn, { backgroundColor: colors.accent }]} onPress={reset}>
                <Text style={[styles.bigBtnText, { color: colors.textOnAccent }]}>{t('retry')}</Text>
              </TouchableOpacity>
            )}
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
