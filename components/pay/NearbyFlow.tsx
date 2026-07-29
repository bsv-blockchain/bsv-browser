/**
 * Local Payments — pay a nearby device.
 *
 * Three transports behind one user-facing flow, all bootstrapped by the same
 * pairing QR minted by the payee. selectTransport() picks the highest rung
 * both sides share:
 *
 *   AWDL    iOS↔iOS peer-to-peer Wi-Fi, TLS-PSK. Fast path.
 *   Nearby  Android↔Android over Google Nearby Connections, same Nitro surface.
 *   QR      any platform pair. The payer renders the signed frame; the payee scans it.
 *
 * Phase machine
 *
 *   entry
 *    ├─ receive_amount → receive_minting → receive_wait
 *    │      receive_wait always renders the pairing QR, and additionally runs a
 *    │      radio listener (AWDL or Nearby) when this device supports one. Either
 *    │      arrival lands in:
 *    │        · radio listener resolves ─┐
 *    │        · receive_scan (payer QR) ─┴→ receive_settling → done | already_paid
 *    └─ send_scan → send_confirm → send_working
 *           ├─ selectTransport() === 'awdl' | 'nearby' → radio.send → done
 *           └─ selectTransport() === 'qr'              → send_qr → done
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
 * The amount may come from EITHER side. A payee can name a figure or leave the
 * request open, in which case the payer enters it on the confirm screen. See
 * `Session.amount` and the settle-binding note below — the two cases differ in
 * exactly one check, and the difference is load-bearing.
 *
 * Money safety (see settleReceived below, which is the only write path):
 *   0. The frame is bound to the session before anything else: a frame whose
 *      derivation nonces do not match the live request — or whose amount
 *      contradicts an amount the payee actually asked for — is refused without
 *      burning the session, so the real payer can still pay.
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
 *   6. Nothing decorative — identity lookup, the confirmation tone, presence —
 *      is ever awaited on a money path. They are all fire-and-forget.
 *
 * Money safety, payer side (see abortBuild below):
 *   The frame is built `noSend`, which holds `amount + fee` in inputs marked
 *   unspendable. Nothing in storage ever reaps a 'nosend' action, so an
 *   abandoned build locks those funds permanently. abortBuild() releases them —
 *   but ONLY on paths where the frame provably never left the device. Once
 *   delivery is even possible the action must stay intact, because the payee may
 *   still broadcast it and a freed input can be respent into a conflict.
 *
 * ── Design notes (see .superpowers/sdd/2026-07-27-local-payments-awdl/phase-b-report.md) ──
 *
 *   Density   8pt vertical rhythm throughout. 16pt gutter, 24pt between
 *             sections, 8pt within a group. Every vertical value on this screen
 *             is a multiple of 8 except hairlines and optical nudges.
 *   Type      Four levels, doing the hierarchy work together with weight and
 *             colour: display(44/700) · title2(22/700) · subhead(15/400) ·
 *             footnote(13/400). Never size alone.
 *   Colour    Green means confirmed money and nothing else. It appears on the
 *             celebration mark, the `paid` presence state, and the "added to
 *             your wallet" notice — nowhere decorative. Everything else is
 *             neutral structure.
 *   Motion    Transforms and opacity only, under 300ms, springs.snappy or
 *             easings.out. Nothing eases in; nothing starts from scale(0).
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
  View
} from 'react-native'
import Animated, { FadeIn, FadeInDown, useReducedMotion } from 'react-native-reanimated'
import { Ionicons } from '@expo/vector-icons'
import { useFocusEffect } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import QRCode from 'react-native-qrcode-svg'
import { createNonce } from '@bsv/sdk'
import type { WalletInterface } from '@bsv/sdk'

import QRScanner from '@/components/QRScanner'
import AmountDisplay from '@/components/wallet/AmountDisplay'
import { AmountInput } from '@/components/wallet/AmountInput'
import Celebration from '@/components/ui/Celebration'
import PressableScale from '@/components/ui/PressableScale'
import PresenceRow, { type PresenceState } from '@/components/localpay/PresenceRow'
import PaymentQrDisplay from '@/components/pay/PaymentQrDisplay'
import ReceivedOverlay from '@/components/pay/ReceivedOverlay'
import { useTheme } from '@/context/theme/ThemeContext'
import { radii, spacing, typography } from '@/context/theme/tokens'
import { durations, springs } from '@/context/theme/motion'
import { useWallet } from '@/context/WalletContext'
import { sounds } from '@/hooks/useConfirmationSound'
import { updateOfflineAction } from '@/storage/methods/offlineActions'
import { identityLabel, makeIdentityClient, resolveIdentity } from '@/utils/identity/resolveIdentity'
import { getOnline } from '@/utils/net/online'
import {
  FOUNTAIN_QR_PREFIX,
  FountainDecoder,
  MAX_FRAME_QR_CHARS,
  MAX_MESSAGE_BYTES,
  awdlTransport,
  buildPaymentFrame,
  decodeFrame,
  decodeSession,
  encodeFrame,
  encodeSession,
  finalizeDelivery,
  frameFromQr,
  frameToQr,
  holdSentPaymentOffline,
  isDeclineReason,
  isSessionSpent,
  localSupportsAwdl,
  localSupportsNearby,
  markSessionSpent,
  mintSession,
  nearbyTransport,
  processPending,
  requestNearbyPermissions,
  savePending,
  selectTransport,
  type Ack,
  type ConfirmDelivery,
  type DeclineReason,
  type PaymentFrame,
  type Session
} from '@/utils/pay/rails/nearby'

// ── Types ──

type PayingWalletArg = Parameters<typeof buildPaymentFrame>[0]

type Phase =
  | 'entry'
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

/**
 * The tone of the notice on a terminal screen.
 *
 * Separate from the text because tone is a claim about money, not a style
 * choice. `success` is green and states that funds are in the wallet;
 * `broadcast pending` is emphatically NOT that, and wearing success styling was
 * the one piece of UX debt Phase A left behind (a warning dressed as a receipt).
 */
type NoticeTone = 'success' | 'info' | 'warning'

interface Notice {
  text: string
  tone: NoticeTone
}

/**
 * A frame that reached this device but could not be persisted, held for a retry.
 *
 * Only ever set for a delivery that was NOT declined — in practice, the QR
 * path, which has no ack channel. Once the payer has been told nothing was
 * queued it releases the inputs its `noSend` action holds, and re-settling the
 * same frame afterwards would queue a payment against a transaction the payer
 * now considers abandoned and free to respend. An AWDL payer recovers by
 * building afresh, which is clean; this one cannot.
 */
interface Unsettled {
  frame: PaymentFrame
  session: Session
}

/** Rendered edge length in points. The brief floors payment QRs at 280. */
const PAYMENT_QR_SIZE = 288

/**
 * Staging for the success moment. The amount lands, the mark is drawn, the tone
 * sounds — three beats, never one. Firing them on the same frame reads as a
 * single blunt event and buries the thing that actually matters, which is the
 * figure. Both delays are sequencing, not animation, so they apply under
 * reduced motion too; only the drawing inside Celebration is suppressed there.
 */
const CELEBRATION_DELAY_MS = durations.quick
const TONE_DELAY_MS = 120

/**
 * Decline codes as the PAYER renders them. The payee sends a stable machine
 * code precisely so the sentence can be produced here, in this device's locale.
 * Anything unrecognised falls through to the raw text, preserving the old
 * behaviour for a peer running a different build.
 */
const DECLINE_KEYS: Record<DeclineReason, string> = {
  session_mismatch: 'local_pay_declined_mismatch',
  already_paid: 'local_pay_declined_already_paid',
  save_failed: 'local_pay_declined_save',
  decode_failed: 'local_pay_declined_decode'
}

const NOTICE_ICONS: Record<NoticeTone, keyof typeof Ionicons.glyphMap> = {
  success: 'wallet',
  info: 'time-outline',
  warning: 'cloud-offline-outline'
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

/** Satoshis from a free-text field, or 0 when it is not yet a usable figure. */
function satsFrom(text: string): number {
  const n = Math.round(Number(text))
  return Number.isFinite(n) && n > 0 ? n : 0
}

// ── Screen ──

export interface NearbyFlowProps {
  /** Which side of the exchange this device is on. Set by the cell that mounted it. */
  role: 'payer' | 'payee'
  /** Leave the flow. The Pay screen decides what that means (back to the grid). */
  onExit: () => void
}

export default function NearbyFlow({ role: initialRole, onExit }: NearbyFlowProps) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const reducedMotion = useReducedMotion()
  const { managers, adminOriginator, storage } = useWallet()
  const wallet = managers?.permissionsManager ?? null

  const [phase, setPhase] = useState<Phase>('entry')
  const [role, setRole] = useState<'payee' | 'payer' | null>(initialRole)

  /** The payee's own minted session — drives the pairing QR and the AWDL listener. */
  const [hostedSession, setHostedSession] = useState<Session | null>(null)
  /** The session the payer scanned off the payee's screen. */
  const [scannedSession, setScannedSession] = useState<Session | null>(null)

  const [requestAmount, setRequestAmount] = useState('')
  /**
   * The payee is raising an OPEN request — no figure, the payer decides.
   *
   * Kept separate from an empty `requestAmount` because they are different
   * intents: an empty field is an unfinished specific request and must keep
   * Continue disabled, while this is a complete request that happens to name no
   * amount.
   */
  /** The payer's own entry, used only when the scanned session left the amount open. */
  const [sendAmount, setSendAmount] = useState('')

  const [paymentQr, setPaymentQr] = useState<string | null>(null)
  const [settledAmount, setSettledAmount] = useState(0)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  /**
   * The other device's identity key, once one is known, and the display name it
   * resolves to. Presentation only: the lookup is a network call that may never
   * complete on a screen two people are using precisely because the network is
   * poor, so nothing waits on it and a null name is a normal outcome.
   */
  const [peerKey, setPeerKey] = useState<string | null>(null)
  const [peerName, setPeerName] = useState<string | null>(null)

  /** True once the AWDL link has provably carried this session's frame. */
  const [linked, setLinked] = useState(false)

  /** Drives the celebration mark on the success screen. Staged, not immediate. */
  const [celebrating, setCelebrating] = useState(false)

  /**
   * The payee's full-screen receipt, held until they acknowledge it. Set only
   * once funds are provably in the wallet — see settleReceived, where a merely
   * queued payment deliberately does NOT raise it.
   *
   * `broadcast` is whether this device was online at the moment the frame was
   * durably queued (see the `broadcastCheck` probe below) — NOT a claim that
   * anyone has actually broadcast it yet. It only tells the payee whether
   * their own device could see the network; the payer's device still has to
   * reconnect and post the transaction before this money is safe from a
   * double-spend, and no read of this device's own state can promise that.
   */
  const [receivedOverlay, setReceivedOverlay] = useState<{ amount: number; broadcast: boolean } | null>(null)

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
  /** Assembles animated fountain parts across the continuous scanner's reads. */
  const fountainDecoderRef = useRef<FountainDecoder | null>(null)
  /** Live part-count for the fountain progress line under the camera. */
  const [scanProgress, setScanProgress] = useState<{ have: number; total: number } | null>(null)

  /**
   * The built payment behind the QR currently on screen. Done routes it
   * through finalizeDelivery; without it Done can only guess. Cleared by
   * reset() and consumed (nulled) by completeQrDelivery.
   */
  const builtRef = useRef<Awaited<ReturnType<typeof buildPaymentFrame>> | null>(null)

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

  /**
   * Nearby is usable only once BOTH hold: GMS is present (localSupportsNearby)
   * and the runtime grants landed. Resolved async on mount, Android only; a
   * denial leaves this false and the flow QR-only, silently — same posture as
   * a GMS-less device.
   */
  const [nearbyReady, setNearbyReady] = useState(false)
  useEffect(() => {
    if (Platform.OS !== 'android' || !localSupportsNearby()) return
    let live = true
    void requestNearbyPermissions().then(granted => {
      if (live) setNearbyReady(granted)
    })
    return () => {
      live = false
    }
  }, [])

  /** The radio this device listens on as payee, if any. */
  const radioTransport = useMemo(
    () => (supportsAwdl ? awdlTransport : nearbyReady ? nearbyTransport : null),
    [supportsAwdl, nearbyReady]
  )

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

  // Hand the shared audio player back when the screen goes away. Not required
  // for correctness — a failed release is swallowed — but this screen may sit
  // open on a counter all day and there is no reason to hold a native object.
  useEffect(() => () => sounds.release(), [])

  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => {
        setFocused(false)
        abortAll()
      }
    }, [abortAll])
  )

  const openScanner = useCallback((next: 'send_scan' | 'receive_scan') => {
    scanLatchRef.current = false
    fountainDecoderRef.current = null
    setScanProgress(null)
    setPhase(next)
  }, [])

  // The grid already asked which side the user is on, so the old role screen is
  // gone. A payee goes straight to naming an amount; a payer straight to the
  // camera. Runs once per mount.
  const enteredRef = useRef(false)
  useEffect(() => {
    if (enteredRef.current) return
    enteredRef.current = true
    if (initialRole === 'payee') setPhase('receive_amount')
    else openScanner('send_scan')
  }, [initialRole, openScanner])

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
    fountainDecoderRef.current = null
    setScanProgress(null)
    builtRef.current = null
    setPhase(initialRole === 'payee' ? 'receive_amount' : 'entry')
    setRole(initialRole)
    setHostedSession(null)
    setScannedSession(null)
    setRequestAmount('')
    setSendAmount('')
    setPaymentQr(null)
    setSettledAmount(0)
    setFailure(null)
    setNotice(null)
    setUnsettled(null)
    setNearbyError(null)
    setSessionQrBroken(false)
    setSessionMismatch(false)
    setPeerKey(null)
    setPeerName(null)
    setLinked(false)
    setCelebrating(false)
    setReceivedOverlay(null)
  }, [abortAll, initialRole])

  const goBack = useCallback(() => {
    abortAll()
    onExit()
  }, [abortAll, onExit])

  // ── Peer identity ──
  //
  // Best-effort and strictly presentational. Never awaited by a money path, and
  // a failure is indistinguishable from "nobody has vouched for this key" by
  // design — both mean the presence row simply shows no name.

  useEffect(() => {
    if (!peerKey || !wallet) return
    const client = makeIdentityClient(wallet as unknown as WalletInterface, adminOriginator)
    if (!client) return
    let live = true
    void resolveIdentity(client, peerKey).then(([, identity]) => {
      if (live) setPeerName(identityLabel(identity))
    })
    return () => {
      live = false
    }
  }, [peerKey, wallet, adminOriginator])

  // ── Receive: settle ──
  //
  // The single write path. Called by the AWDL listener and by the QR scanner
  // with whichever Session is live at that moment.

  const settleReceived = useCallback(
    async (frame: PaymentFrame, session: Session, confirm?: ConfirmDelivery) => {
      // `confirm` is how the payer learns what happened. It is undefined on the
      // QR path, which has no socket to ack over. On the AWDL path it MUST be
      // called on every exit below: with `true` only once savePending has
      // resolved (a positive ack is what releases the payer's transaction for
      // broadcast), and with `false` on every path that queued nothing, so the
      // payer aborts its build instead of resting on a green "Sent".
      //
      // Fire-and-forget throughout: ConfirmDelivery never rejects, and the
      // payee's own outcome must not depend on the ack reaching the payer.
      if (settlingRef.current) {
        // Another delivery is mid-settle (an AWDL arrival racing a QR scan).
        // Nothing was written for THIS frame, so it is a provable decline.
        void confirm?.(false, 'save_failed')
        return
      }

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
      //     THE NONCE CHECKS ALWAYS APPLY. derivationPrefix/Suffix are the
      //     per-session values the payee minted and the payer echoed back, so
      //     matching them is what makes the frame provably intended for this
      //     request. They are the whole binding, and nothing below weakens them.
      //
      //     The amount check applies ONLY where the payee actually named a
      //     figure. On an open request there is no requested amount to
      //     contradict — the payer chose it — so there is nothing to compare
      //     against, and inventing a comparison (against 0, or against whatever
      //     the frame itself claims) would either reject every legitimate open
      //     payment or be a check that always passes and merely looks like one.
      //     What the check does when it does run is unchanged: it pins the
      //     figure the payee is about to see to the figure they asked for.
      //
      //     Deliberately NOT terminal, and deliberately does NOT mark the session
      //     spent: the request stays live so the genuine payer can still complete.
      const amountDisagrees = session.amount !== undefined && frame.amount !== session.amount
      if (
        frame.derivationPrefix !== session.derivationPrefix ||
        frame.derivationSuffix !== session.derivationSuffix ||
        amountDisagrees
      ) {
        void confirm?.(false, 'session_mismatch')
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
      // The frame crossed the encrypted link and decoded against this session:
      // the peer is provably present. Presentation only — this drives nothing
      // but the presence row.
      if (confirm) setLinked(true)
      setPhase('receive_settling')

      if (!storage) {
        // The frame already reached this device, but with nowhere to write it
        // there is provably nothing queued — decline, so the payer releases its
        // inputs rather than believing the payment landed.
        void confirm?.(false, 'save_failed')
        settlingRef.current = false
        setUnsettled(confirm ? null : { frame, session })
        fail('generic', t('wallet_not_ready'))
        return
      }

      // Started here, alongside the durable write, and not awaited until the
      // receipt is raised below: whatever `processPending` costs (1) overlaps
      // with this probe, so it adds no latency to the settle path, and (2)
      // never touches the durable-write section's own try/catch — a probe
      // failure must not be mistaken for the frame being unpersisted. Caught
      // inline for the same reason: this is advisory copy, not a money path,
      // so a failed check reads as "not yet broadcast" rather than crashing
      // the settle.
      const broadcastCheck = getOnline().catch(() => false)

      // ── Durable-write section ──
      // Everything that can legitimately be reported as a payment failure lives
      // in here, and only in here. Past the closing brace the money is safe.
      try {
        // (1) One-shot session guard, before anything is written. A re-scanned
        //     or replayed session must never credit twice.
        if (await isSessionSpent(storage, session.sessionId)) {
          // Not a failure for the PAYEE: that session's payment is already
          // queued. It is a decline for the PAYER, though, and must be — this
          // delivery queued nothing, and each executeSend builds a fresh
          // action from fresh UTXOs, so acking it would broadcast a second
          // transaction for a request already paid.
          void confirm?.(false, 'already_paid')
          setHostedSession(null)
          setUnsettled(null)
          setPhase('already_paid')
          return
        }

        // (2) Persist before anything else. Once this resolves the money cannot
        //     be lost to a crash, a dead network or a closed app.
        //
        //     `confirm` is only ever supplied by a radio receive path (see
        //     radioTransport.receive's callers above and the QR/retry callers
        //     below, which omit it) — the same signal `Unsettled` already keys
        //     off of, reused here to attribute the queue row to a transport.
        //     `radioTransport?.kind` names which radio, falling back to 'awdl'
        //     only for the (unreachable in practice) case confirm exists but
        //     the listener that produced it has since gone.
        await savePending(storage, frame, confirm ? (radioTransport?.kind ?? 'awdl') : 'qr')

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
        // same settle instead of losing a payment to a transient SQLite error —
        // but only where no decline went out (see Unsettled). A declined AWDL
        // payer has already released its inputs; retrying against that frame
        // would queue a payment its transaction no longer backs.
        void confirm?.(false, 'save_failed')
        settlingRef.current = false
        setUnsettled(confirm ? null : { frame, session })
        fail('generic', messageOf(e))
        return
      }

      // (3a) ACK. The one place a positive ack may be sent: savePending has
      //      resolved, so the claim it makes to the payer — "this payee has
      //      durably queued your payment" — is now true. It is also the payer's
      //      cue to broadcast, which is why it must not be sent one line
      //      earlier. Sent before the UI updates below so the payer's screen
      //      moves as soon as possible.
      void confirm?.(true)

      // ── Past here the frame is durably queued ──
      // The payment cannot be lost, so nothing below may flip the screen to a
      // failure. A payee who is told "failed" taps Retry, mints a fresh session,
      // and the payer builds a second createAction from different UTXOs: both
      // internalize, the payee is credited twice and the payer pays twice.
      setSettledAmount(frame.amount)
      setRole('payee')
      setPhase('done')
      setUnsettled(null)
      // Who paid. Starts a best-effort identity lookup for the presence row;
      // deliberately after the durable write, and never awaited.
      setPeerKey(frame.senderIdentityKey)
      // Clearing the hosted session stops the AWDL listener: this request is settled.
      setHostedSession(null)

      // (4) Internalization is attempted only after the durable write, and its
      //     failure only downgrades the notice. processPending awaits storage
      //     outside its own per-entry try, so it can reject as a whole; the entry
      //     stays queued either way for the background retry.
      //
      //     Tone is a claim about money: `success` (green) is reserved for funds
      //     actually in the wallet. "Queued" is safe but not yet spendable, so it
      //     is neutral.
      if (!wallet) {
        setNotice({ text: t('local_pay_queued'), tone: 'info' })
        return
      }
      try {
        // Backfills who handed over a payment (and how) onto the offline_actions
        // row internalizeAction may just have created while this device was
        // offline — that row is written deep in the storage layer's hold path,
        // which never sees the frame. Captured once here rather than inside
        // `storage?.sqliteDb`, because `settleReceived` re-checks `storage`
        // is non-null on every call and this closure must not re-derive that.
        const db = storage.sqliteDb
        const results = await processPending(wallet, storage, adminOriginator, async (txid, info) => {
          if (!db) return
          await updateOfflineAction(db, txid, {
            senderIdentityKey: info.senderIdentityKey,
            receivedVia: info.receivedVia
          })
        })
        const credited = results.some(r => r.success)
        setNotice(
          credited ? { text: t('local_pay_added'), tone: 'success' } : { text: t('local_pay_queued'), tone: 'info' }
        )
        // The full-screen moment, held until acknowledged — but ONLY once the
        // funds are actually in the wallet. Queued money is safe and not yet
        // spendable, and a receipt claiming otherwise is the one thing the tone
        // rule above exists to prevent. A queued settle keeps the neutral notice
        // on the done screen instead.
        if (credited) setReceivedOverlay({ amount: frame.amount, broadcast: await broadcastCheck })
      } catch (e) {
        console.warn('[localpay] processPending failed:', messageOf(e))
        setNotice({ text: t('local_pay_queued'), tone: 'info' })
      }
    },
    [storage, wallet, adminOriginator, radioTransport, fail, t]
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
    if (!radioTransport) return

    // The Set identity is stable for the component's lifetime, but capture it so
    // the cleanup never reaches through a ref that may have been reassigned.
    const registry = abortsRef.current
    const controller = new AbortController()
    registry.add(controller)
    setNearbyError(null)

    radioTransport
      .receive(hostedSession, controller.signal)
      .then(({ frame, confirm }) => {
        if (controller.signal.aborted) {
          // The screen went away between delivery and here. The payer is
          // holding an un-acked connection and nothing was written, so tell it
          // rather than leaving it to time out on a green "Sent".
          void confirm(false, 'save_failed')
          return
        }
        void settleRef.current(frame, hostedSession, confirm)
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
  }, [hostedSession, focused, radioTransport, listenerEpoch])

  // ── Receive: mint the request ──

  const startRequest = useCallback(async () => {
    // An open request carries no figure at all. Undefined, never 0 — the codec
    // refuses a non-positive amount precisely so a corrupt zero can never be
    // read back as "any amount".
    // Zero (or blank) is the user asking the payer to choose, so it becomes an
    // open session rather than a rejected input. Undefined, never 0 — the codec
    // refuses a non-positive amount precisely so a corrupt zero can never be
    // read back as "any amount".
    const requested = satsFrom(requestAmount)
    const sats = requested > 0 ? requested : undefined
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
        // Caps advertise what this payee can DO; the payer's ladder picks the
        // highest rung both sides share, QR being the floor.
        supportsAwdl,
        supportsNearby: nearbyReady,
        os: Platform.OS === 'ios' ? 'ios' : 'android'
      })
      setRole('payee')
      setHostedSession(session)
      setPhase('receive_wait')
    } catch (e) {
      fail('generic', messageOf(e))
    }
  }, [requestAmount, wallet, storage, adminOriginator, supportsAwdl, nearbyReady, fail, t])

  // ── Receive: scan the payer's frame ──

  const onFrameScanned = useCallback(
    (data: string) => {
      // Animated-code parts arrive continuously and are handled statefully;
      // everything else keeps the one-shot latch semantics below.
      if (typeof data === 'string' && data.startsWith(FOUNTAIN_QR_PREFIX)) {
        // A settling payment must ignore late parts — the frame it already
        // solved is already on its way through settleReceived.
        if (scanLatchRef.current || settlingRef.current) return
        const session = hostedSession
        if (!session) return
        if (!fountainDecoderRef.current) fountainDecoderRef.current = new FountainDecoder()
        const s = fountainDecoderRef.current.accept(data)
        if (!s.ok) return
        setScanProgress({ have: s.have, total: s.total })
        if (!s.done) return
        const message = fountainDecoderRef.current.message()
        if (!message) return // crc mismatch: decoder reset itself, keep scanning
        fountainDecoderRef.current = null
        setScanProgress(null)
        scanLatchRef.current = true
        let frame: PaymentFrame
        try {
          frame = decodeFrame(message)
        } catch {
          fail('generic', t('invalid_qr_code'))
          return
        }
        void settleRef.current(frame, session)
        return
      }

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
      // Who is being paid. Best-effort lookup for the presence row and the
      // recipient card; nothing waits on it.
      setPeerKey(session.identityKey)
      setSendAmount('')
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

  /**
   * The figure this payment will actually carry.
   *
   * The payee's request wins outright when they named one — the payer must not
   * be able to talk it down, and the payee's settle check would refuse anything
   * else anyway. Otherwise it is the payer's own entry. 0 means "not a usable
   * amount yet" and keeps Send disabled.
   */
  const payAmount = useMemo(() => {
    if (!scannedSession) return 0
    return scannedSession.amount ?? satsFrom(sendAmount)
  }, [scannedSession, sendAmount])

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

  /**
   * Renders a peer's decline in THIS device's locale. The payee sends a stable
   * machine code rather than a sentence, so a Japanese payer never sees Polish.
   * Anything unrecognised is echoed verbatim, which keeps a peer on a different
   * build readable rather than silent.
   */
  const declineMessage = useCallback(
    (reason: string | undefined) => {
      if (reason && isDeclineReason(reason)) return t(DECLINE_KEYS[reason])
      return reason && reason.length > 0 ? reason : t('local_pay_failed')
    },
    [t]
  )

  // ── Send: build and deliver ──

  const executeSend = useCallback(async () => {
    const session = scannedSession
    if (!session || !sendKind) return
    // Guards the open-request path: with no figure there is nothing to build,
    // and buildPaymentFrame would refuse it anyway.
    if (payAmount <= 0) return
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
        built = await buildPaymentFrame(
          wallet as unknown as PayingWalletArg,
          session,
          adminOriginator,
          payAmount
        )
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

      if (sendKind === 'qr') {
        // The fountain removes the symbol-size ceiling; the only refusal left
        // is the 64 KB sanity cap, past which QR handover is unreasonable and
        // something upstream is wrong.
        if (encodeFrame(built.frame).length > MAX_MESSAGE_BYTES) {
          abortBuild(built.reference)
          setPaymentQr(null)
          fail('generic', t('local_pay_too_large'))
          return
        }
        builtRef.current = built
        setPaymentQr(frameToQr(built.frame))
        setPhase('send_qr')
        return
      }

      // sendKind is neither 'qr' (returned above) nor null (guarded at the top
      // of this callback), so it names one of the two radios here.
      const radio = sendKind === 'awdl' ? awdlTransport : nearbyTransport

      let ack: Ack
      try {
        ack = await radio.send(session, built.frame, controller.signal)
      } catch (e) {
        if (controller.signal.aborted) return
        // The radio path failed: connect timeout (radios off, peer gone),
        // Local Network denial, or a lost ack. The frame is signed and noSend,
        // so the QR still completes this payment — fall straight through to
        // the code instead of a failure screen. Deliberately NOT aborted: a
        // lost ack does not prove non-delivery, and Done's semantics
        // (broadcast-or-queue, re-showable) keep the already-delivered case
        // consistent — the payee's copy merges once this transaction is out.
        const message = messageOf(e)
        console.warn('[localpay] radio send failed, falling back to QR:', message)
        if (encodeFrame(built.frame).length > MAX_MESSAGE_BYTES) {
          // No radio and no representable code: the one genuinely dead end.
          fail(looksLikeLocalNetworkDenial(message) ? 'network' : 'generic', t('local_pay_too_large'))
          return
        }
        builtRef.current = built
        setPaymentQr(frameToQr(built.frame))
        setNotice({ text: t('local_pay_radio_fallback'), tone: 'info' })
        setPhase('send_qr')
        return
      }

      // An ack of any kind proves the encrypted link carried this frame to the
      // peer. Presentation only.
      if (!controller.signal.aborted) setLinked(true)

      // The ack is a money decision, so it is acted on even if the screen has
      // since been abandoned — releasing or reclaiming the transaction must not
      // depend on this component still being mounted. Only the UI writes below
      // are gated on the abort.
      const outcome = await finalizeDelivery(wallet as unknown as PayingWalletArg, built, ack, adminOriginator, {
        hold: async txid => {
          // `finalizeDelivery` already treats a thrown hold as non-fatal
          // (`broadcast: 'pending'`), so a clear error here is strictly
          // better than the null-dereference `storage as never` would throw
          // instead — same outward outcome, an honest cause.
          if (!storage) throw new Error('no local storage to queue this payment in')
          await holdSentPaymentOffline({ storage, txid })
        }
      })
      if (controller.signal.aborted) return

      if (outcome.kind === 'declined') {
        // An explicit decline: the peer processed the frame and refused it, so
        // nothing was queued there and finalizeDelivery has released the inputs.
        // Because they are released, the frame must NOT then be offered as a QR
        // fallback — handing over a transaction whose inputs this wallet now
        // considers free invites a double-spend. Clearing paymentQr also drops
        // any stale QR left by an earlier attempt.
        setPaymentQr(null)
        fail('generic', declineMessage(outcome.reason))
        return
      }

      // Positive ack: the payee has durably queued this payment, so it is sent
      // whatever happened to the broadcast. `broadcast: 'pending'` means only
      // that this device could not get the transaction out itself — the payee
      // holds a copy and will internalize it — so it is a retryable notice, not
      // a failure. Reporting it as a failure would invite a second payment.
      //
      // It is a WARNING, not a success: this device's copy of the transaction is
      // inert and its inputs stay locked. Green on this screen means confirmed
      // money, and a stuck broadcast is not that.
      if (outcome.broadcast === 'pending') {
        console.warn('[localpay] broadcast after a positive ack failed:', outcome.detail ?? '')
        setNotice({ text: t('local_pay_broadcast_pending'), tone: 'warning' })
      }
      setSettledAmount(payAmount)
      setPhase('done')
    } finally {
      registry.delete(controller)
    }
  }, [scannedSession, sendKind, payAmount, wallet, adminOriginator, storage, abortBuild, declineMessage, fail, t])

  // ── Send: the payer asserts QR delivery ──
  //
  // The QR path has no ack channel, so "the payee has it" is the user's claim,
  // made by tapping Done. Acting on that claim mirrors a positive AWDL ack:
  // broadcast when online, hold + queue when offline. This replaces the old
  // do-nothing Done, which stranded the transaction at nosend with no queue
  // row — nothing in the system would ever broadcast it. The risk of a wrong
  // claim is bounded: the frame is persisted on the queue row, the code can be
  // re-shown from /pay, and a payee scanning after the broadcast internalizes
  // the already-mempooled transaction as a merge.
  const completeQrDelivery = useCallback(async () => {
    const built = builtRef.current
    if (!built || !wallet) {
      // No handle (e.g. re-entry after reset): nothing to decide, just close.
      setSettledAmount(payAmount)
      setRole('payer')
      setNotice(null)
      setPhase('done')
      return
    }
    builtRef.current = null
    setPhase('send_working')
    setNotice(null)
    const outcome = await finalizeDelivery(wallet as unknown as PayingWalletArg, built, { ok: true }, adminOriginator, {
      hold: async txid => {
        if (!storage) throw new Error('no local storage to queue this payment in')
        await holdSentPaymentOffline({ storage, txid, framePayload: frameToQr(built.frame) })
      }
    })
    if (outcome.kind === 'sent' && outcome.broadcast === 'pending') {
      console.warn('[localpay] QR delivery queued or broadcast pending:', outcome.detail ?? '')
      setNotice({ text: t('local_pay_broadcast_pending'), tone: 'warning' })
    }
    setSettledAmount(payAmount)
    setRole('payer')
    setPhase('done')
  }, [wallet, storage, adminOriginator, payAmount, t])

  // ── The success moment ──
  //
  // Three beats, staged. The amount has already landed by the time this runs
  // (it animates in with the phase); then the mark is drawn, which fires the
  // success haptic from inside Celebration — this screen must NOT fire a second
  // one; then the tone. `sounds.confirmation()` returns immediately and cannot
  // throw, so a device with no audio session simply completes the payment
  // quietly.

  useEffect(() => {
    if (phase !== 'done') return
    // The payee's celebration belongs to ReceivedOverlay alone, outright — not
    // just while it happens to be up. A credited receipt celebrates once, there,
    // when it is raised; re-firing here after the payee dismisses it (overlay
    // flips to null while phase is still 'done', re-running this effect) read as
    // a second payment landing. A merely-queued receipt gets no overlay and,
    // deliberately, no fanfare either — queued money is safe but not credited,
    // and green (see the file header's tone doctrine) is reserved for funds
    // actually in the wallet.
    if (role === 'payee') return
    // Belt-and-braces for the instant the overlay is actually up.
    if (receivedOverlay) return
    const mark = setTimeout(() => setCelebrating(true), CELEBRATION_DELAY_MS)
    const tone = setTimeout(() => sounds.confirmation(), CELEBRATION_DELAY_MS + TONE_DELAY_MS)
    return () => {
      clearTimeout(mark)
      clearTimeout(tone)
    }
  }, [phase, receivedOverlay, role])

  // ── Receive: retry a settle that never reached storage ──

  const retrySettle = useCallback(() => {
    if (!unsettled) return
    setFailure(null)
    // No confirm handle by construction: Unsettled is only ever populated for
    // a delivery that was not declined, which today means the QR path.
    void settleRef.current(unsettled.frame, unsettled.session)
  }, [unsettled])

  // ── QR encoder failures ──
  //
  // react-native-qrcode-svg calls onError from inside its own render and returns
  // null; without a handler it rethrows and the app-level ErrorBoundary replaces
  // the whole app. Flipping parent state synchronously from a child's render
  // triggers React's cross-component update warning, so both handlers defer by a
  // microtask. These are backstops — every frameToQr() call site already gates
  // on MAX_MESSAGE_BYTES before calling it.

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

  /** Listening over a radio link right now. Goes false once the fast path gives up. */
  const radioActive = hostedSession !== null && radioTransport !== null && nearbyError === null
  const canSend = payAmount > 0
  const scannerOpen = phase === 'send_scan' || phase === 'receive_scan'

  /**
   * What the presence row is entitled to claim, per phase.
   *
   * Every branch is driven by something observed. There is no branch for "the
   * peer is probably nearby": `ready` says a route exists, `waiting` says this
   * device is genuinely listening or searching, `linked` is only ever set after
   * bytes crossed the encrypted channel, and `qr` admits there is no link at all.
   */
  const presence = useMemo<{ state: PresenceState; label: string } | null>(() => {
    const at = (state: PresenceState, key: string) => ({ state, label: t(key) })
    const qr = () => at('qr', 'local_pay_presence_qr')

    // Terminal first: `paid` is the only state that may be green, and nothing
    // below can override it.
    if (phase === 'done') return at('paid', 'local_pay_presence_paid')

    // `linked` is a proven fact — bytes crossed the encrypted channel — so it
    // outranks anything the phase alone would guess about the peer.
    if (linked) return at('linked', 'local_pay_presence_linked')

    if (role === 'payee') {
      if (phase === 'receive_settling') return at('linked', 'local_pay_presence_linked')
      if (phase === 'receive_wait') {
        // No radio listener means no live link at all, whatever the reason —
        // an unsupported device, a denied permission, or a fast path that gave up.
        return radioActive ? at('waiting', 'local_pay_presence_waiting_payee') : qr()
      }
      return null
    }

    if (role === 'payer') {
      // Every payer branch degrades to `qr` when the QR transport was selected,
      // because on that path the two devices genuinely never speak. `awdl` and
      // `nearby` are both live radio links (iOS and Android respectively), so
      // either counts here.
      const onRadio = sendKind === 'awdl' || sendKind === 'nearby'
      if (phase === 'send_working') {
        return onRadio ? at('waiting', 'local_pay_presence_waiting_payer') : qr()
      }
      if (phase === 'send_qr') return qr()
      if (phase === 'send_confirm') {
        return onRadio ? at('ready', 'local_pay_presence_ready') : qr()
      }
      return null
    }

    return null
  }, [phase, role, linked, radioActive, sendKind, t])

  // Dismissing the camera returns to whatever raised it. A payee's request must
  // survive this: closing the scanner is not cancelling the payment.
  const closeScanner = useCallback(() => {
    scanLatchRef.current = false
    setPhase(current => (current === 'receive_scan' ? 'receive_wait' : 'entry'))
  }, [])

  const styles = useMemo(() => makeStyles(), [])

  // Entrances: opacity + translate only, springs.snappy. Suppressed entirely
  // under reduced motion rather than shortened, and never applied to an
  // ancestor of a blur surface.
  const settleIn = reducedMotion
    ? undefined
    : FadeInDown.springify()
        .mass(springs.snappy.mass)
        .damping(springs.snappy.damping)
        .stiffness(springs.snappy.stiffness)
  const fadeIn = reducedMotion ? undefined : FadeIn.duration(durations.instant)

  // ── Render ──

  const amountBlock = (sats: number, key?: string) => (
    <Animated.View key={key} entering={settleIn} style={styles.amountBlock}>
      <Text
        style={[styles.amountDisplay, { color: colors.textPrimary }]}
        maxFontSizeMultiplier={1.3}
        numberOfLines={1}
        adjustsFontSizeToFit
        accessibilityRole="text"
      >
        <AmountDisplay>{sats}</AmountDisplay>
      </Text>
    </Animated.View>
  )

  const presenceBlock = presence ? (
    <View style={styles.presenceSlot}>
      <PresenceRow state={presence.state} label={presence.label} peer={peerName} />
    </View>
  ) : null

  const phaseTitle = (label: string) => (
    <Text
      style={[styles.title, { color: colors.textPrimary }]}
      // The nearest RN has to `text-wrap: balance`. Android honours it; iOS has
      // no equivalent, so headings are also kept short enough to fit two lines
      // at the default size in every locale.
      textBreakStrategy="balanced"
      maxFontSizeMultiplier={1.4}
    >
      {label}
    </Text>
  )

  const supportText = (label: string) => (
    <Text style={[styles.support, { color: colors.textSecondary }]} textBreakStrategy="balanced">
      {label}
    </Text>
  )

  const spinnerBlock = (label: string) => (
    <View style={styles.stage} accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator size="large" color={colors.textSecondary} />
      <View style={styles.gapLg} />
      {supportText(label)}
      {presenceBlock}
    </View>
  )

  const noticeBlock = (n: Notice) => {
    const tint =
      n.tone === 'success' ? colors.success : n.tone === 'warning' ? colors.warning : colors.textSecondary
    return (
      <Animated.View
        entering={fadeIn}
        style={[
          styles.notice,
          {
            backgroundColor: n.tone === 'info' ? colors.fillTertiary : tint + '15',
            borderColor: n.tone === 'info' ? colors.separator : tint + '40'
          }
        ]}
        accessibilityRole="text"
      >
        <Ionicons name={NOTICE_ICONS[n.tone]} size={16} color={tint} />
        <Text style={[styles.noticeText, { color: n.tone === 'info' ? colors.textSecondary : tint }]}>
          {n.text}
        </Text>
      </Animated.View>
    )
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSecondary }]}>
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.background }}
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + spacing.xxxl }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* ══ Payer entry ══
            The Pay screen's grid already asked which side of the exchange this
            device is on, so there is no role choice left to make here and only
            one action: raise the camera again. Reached only by dismissing the
            scanner that opens on mount — a payee never sees this view, they go
            straight to naming an amount. */}
        {phase === 'entry' && initialRole === 'payer' && (
          <Animated.View entering={settleIn} style={styles.stage}>
            <View style={[styles.heroCircle, { backgroundColor: colors.fillTertiary }]}>
              <Ionicons name="qr-code-outline" size={44} color={colors.textSecondary} />
            </View>
            <View style={styles.gapLg} />
            {phaseTitle(t('local_pay_scan_qr'))}
            {supportText(t('pay_pre_nearby'))}
            <View style={styles.gapXl} />
            <PrimaryButton
              styles={styles}
              colors={colors}
              icon="scan-outline"
              label={t('local_pay_scan_qr')}
              onPress={() => openScanner('send_scan')}
            />

            {/* TEMPORARY simulator affordance — __DEV__ only, never ships.
                The simulator has no camera, so the payer flow is unreachable
                there. This mints an OPEN session (no amount) and feeds it
                through the real `onSessionScanned`, so decodeSession and every
                downstream branch run exactly as they would from a real scan —
                what you see is the genuine payer UI, not a mock.
                supportsAwdl is false so selectTransport picks the QR path,
                which is the one a simulator can actually complete. */}
            {__DEV__ && (
              <>
                <View style={styles.gapMd} />
                <SecondaryButton
                  styles={styles}
                  colors={colors}
                  icon="construct"
                  label="DEV: pay an open request"
                  onPress={() => {
                    scanLatchRef.current = false
                    onSessionScanned(
                      encodeSession(
                        mintSession({
                          // secp256k1 generator point: a genuinely valid
                          // compressed pubkey, so key derivation won't throw.
                          identityKey:
                            '0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798',
                          derivationPrefix: 'ZGV2LXByZWZpeA==',
                          derivationSuffix: 'ZGV2LXN1ZmZpeA==',
                          supportsAwdl: false
                        })
                      )
                    )
                  }}
                />
              </>
            )}
          </Animated.View>
        )}

        {/* ══ Receive: amount ══
            Focal: the amount field. Everything else on the view is a label. */}
        {phase === 'receive_amount' && (
          <Animated.View entering={settleIn}>
            {phaseTitle(t('local_pay_request'))}
            {supportText(t('local_pay_amount_optional_hint'))}
            <View style={styles.gapXl} />

            <Text style={[styles.fieldLabel, { color: colors.textTertiary }]}>
              {t('local_pay_amount').toUpperCase()}
            </Text>
            {/* No max button: this asks the payer for money, so "entire wallet
                balance" would mean the requester's own balance — meaningless here. */}
            <AmountInput value={requestAmount} onChangeText={setRequestAmount} showMax={false} />

            <View style={styles.gapXl} />
            {/* Never disabled. Leaving the amount at zero is a real choice — it
                means "payer decides" — so gating Continue on a non-zero amount
                would make that choice unreachable. startRequest maps 0 to an
                open session. */}
            <PrimaryButton
              styles={styles}
              colors={colors}
              label={t('continue_action')}
              onPress={() => void startRequest()}
            />
            <CancelButton styles={styles} colors={colors} label={t('cancel')} onPress={reset} />
          </Animated.View>
        )}

        {/* Focal on each of these: the single status line. */}
        {phase === 'receive_minting' && spinnerBlock(t('local_pay_preparing'))}
        {phase === 'receive_settling' && spinnerBlock(t('local_pay_saving'))}
        {phase === 'send_working' && spinnerBlock(t('local_pay_delivering'))}

        {/* ══ Receive: pairing QR (always) + AWDL listener (when supported) ══
            Focal: the pairing code. This is the one view whose focal element is
            not the amount, and deliberately: the code is the object being
            physically held up to another person, and shrinking a working
            scanner target to win a typographic argument would be the wrong
            trade. The amount sits above it at title scale, as the code's price. */}
        {phase === 'receive_wait' && hostedSession && (
          <Animated.View entering={settleIn} style={styles.stage}>
            {phaseTitle(t('local_pay_show_qr'))}
            <Text
              style={[styles.amountTitle, { color: colors.textSecondary }]}
              maxFontSizeMultiplier={1.4}
              numberOfLines={1}
            >
              {hostedSession.amount === undefined ? (
                t('local_pay_any_amount')
              ) : (
                <AmountDisplay>{hostedSession.amount}</AmountDisplay>
              )}
            </Text>
            <View style={styles.gapLg} />

            {sessionQr && !sessionQrBroken ? (
              <View style={[styles.qrCard, { shadowColor: colors.textPrimary }]}>
                <View style={styles.qrPlate}>
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
              </View>
            ) : (
              // Error state for this data area. The session cannot be handed
              // over at all, so the only way forward is a fresh one.
              <View
                style={[styles.qrError, { backgroundColor: colors.fillTertiary, borderColor: colors.separator }]}
                accessibilityRole="alert"
              >
                <Ionicons name="alert-circle-outline" size={28} color={colors.error} />
                <View style={styles.gapSm} />
                <Text style={[styles.support, { color: colors.textSecondary }]}>{t('local_pay_qr_unavailable')}</Text>
              </View>
            )}

            <View style={styles.gapLg} />
            {presenceBlock}

            {/* A frame arrived that belongs to a different request. Advisory,
                not a failure: this session was deliberately NOT marked spent,
                so the pairing QR above is still live for the real payer. */}
            {sessionMismatch && (
              <>
                <View style={styles.gapLg} />
                <Animated.View
                  entering={fadeIn}
                  style={[styles.notice, { backgroundColor: colors.error + '15', borderColor: colors.error + '40' }]}
                  accessibilityRole="alert"
                >
                  <Ionicons name="alert-circle-outline" size={16} color={colors.error} />
                  <Text style={[styles.noticeText, { color: colors.error }]}>{t('local_pay_wrong_session')}</Text>
                </Animated.View>
              </>
            )}

            {/* The fast path gave up. The request is still live over QR, so this
                is an advisory, not a failure — the pairing QR above still works. */}
            {nearbyError && (
              <>
                <View style={styles.gapLg} />
                <Animated.View
                  entering={fadeIn}
                  style={[styles.notice, { backgroundColor: colors.fillTertiary, borderColor: colors.separator }]}
                >
                  <Ionicons name="information-circle-outline" size={16} color={colors.textSecondary} />
                  <Text style={[styles.noticeText, { color: colors.textSecondary }]}>
                    {nearbyError.networkDenied ? t('local_pay_network_denied') : t('local_pay_nearby_unavailable')}
                  </Text>
                </Animated.View>
              </>
            )}

            <View style={styles.gapXl} />
            {nearbyError?.networkDenied && (
              <>
                <SecondaryButton
                  styles={styles}
                  colors={colors}
                  icon="settings-outline"
                  label={t('open_settings')}
                  onPress={() => void Linking.openSettings()}
                />
                <View style={styles.gapMd} />
              </>
            )}
            <SecondaryButton
              styles={styles}
              colors={colors}
              icon="scan-outline"
              label={t('local_pay_scan_payer_qr')}
              onPress={() => openScanner('receive_scan')}
            />
            <CancelButton styles={styles} colors={colors} label={t('cancel')} onPress={reset} />
          </Animated.View>
        )}

        {/* ══ Send: confirm ══
            Focal: the amount — the figure being handed over, at display scale
            when the payee fixed it, or the live field when they left it open. */}
        {phase === 'send_confirm' && scannedSession && (
          <Animated.View entering={settleIn}>
            {phaseTitle(scannedSession.amount === undefined ? t('local_pay_choose_amount') : t('local_pay_send'))}

            {scannedSession.amount === undefined ? (
              <>
                {supportText(t('local_pay_enter_amount_send'))}
                <View style={styles.gapXl} />
                <Text style={[styles.fieldLabel, { color: colors.textTertiary }]}>
                  {t('local_pay_amount').toUpperCase()}
                </Text>
                <AmountInput value={sendAmount} onChangeText={setSendAmount} />
              </>
            ) : (
              <View style={styles.stageTight}>{amountBlock(scannedSession.amount)}</View>
            )}

            <View style={styles.gapXl} />
            <View style={[styles.idCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.separator }]}>
              <View style={[styles.avatar, { backgroundColor: colors.fillTertiary }]}>
                <Ionicons name="person" size={20} color={colors.textSecondary} />
              </View>
              <View style={styles.idText}>
                <Text style={[styles.idLabel, { color: colors.textTertiary }]}>{t('recipient').toUpperCase()}</Text>
                <Text style={[styles.idName, { color: colors.textPrimary }]} numberOfLines={1}>
                  {peerName ?? abbreviateKey(scannedSession.identityKey)}
                </Text>
                {!!peerName && (
                  <Text style={[styles.idKey, { color: colors.textTertiary }]} numberOfLines={1} ellipsizeMode="middle">
                    {abbreviateKey(scannedSession.identityKey)}
                  </Text>
                )}
              </View>
            </View>

            <View style={styles.gapLg} />
            {presenceBlock}

            <View style={styles.gapXl} />
            <PrimaryButton
              styles={styles}
              colors={colors}
              icon="arrow-up"
              label={t('local_pay_send')}
              disabled={!canSend}
              onPress={() => void executeSend()}
            />
            <CancelButton styles={styles} colors={colors} label={t('cancel')} onPress={reset} />
          </Animated.View>
        )}

        {/* ══ Send: hand the frame over as a QR ══
            Focal: the payment code. The amount is settled by this point and
            demotes to a caption. */}
        {phase === 'send_qr' && paymentQr && (
          <Animated.View entering={settleIn} style={styles.stage}>
            {phaseTitle(t('local_pay_show_payment_qr'))}
            <Text
              style={[styles.amountTitle, { color: colors.textSecondary }]}
              maxFontSizeMultiplier={1.4}
              numberOfLines={1}
            >
              <AmountDisplay>{payAmount}</AmountDisplay>
            </Text>
            {paymentQr.length > MAX_FRAME_QR_CHARS && (
              <Text style={[styles.support, { color: colors.textSecondary }]}>{t('local_pay_animated_hint')}</Text>
            )}
            <View style={styles.gapLg} />
            <View style={[styles.qrCard, { shadowColor: colors.textPrimary }]}>
              <View style={styles.qrPlate}>
                {/* onError is mandatory: without it an oversize payload rethrows
                    from render and the app-level ErrorBoundary swallows the app. */}
                <PaymentQrDisplay frameQr={paymentQr} size={PAYMENT_QR_SIZE} onError={onPaymentQrError} />
              </View>
            </View>
            <View style={styles.gapLg} />
            {presenceBlock}
            {!!notice && (
              <>
                <View style={styles.gapLg} />
                {noticeBlock(notice)}
              </>
            )}
            <View style={styles.gapXl} />
            {/* Done asserts delivery: broadcast when online, hold + queue when
                offline (see completeQrDelivery). Never an abort — the payee may
                be about to broadcast this frame, and freeing its inputs would
                let this wallet respend them into a conflict. */}
            <PrimaryButton
              styles={styles}
              colors={colors}
              label={t('done')}
              onPress={() => void completeQrDelivery()}
            />
          </Animated.View>
        )}

        {/* ══ Done ══
            Focal: the amount. The celebration mark is a transient overlay that
            owns attention for ~700ms and then hands it back, so the two never
            compete for the same beat. */}
        {phase === 'done' && (
          <View style={styles.stage}>
            {phaseTitle(role === 'payer' ? t('local_pay_sent') : t('local_pay_received'))}
            <View style={styles.gapSm} />
            {amountBlock(settledAmount, 'done-amount')}
            <View style={styles.gapMd} />
            {presenceBlock}
            {!!notice && (
              <>
                <View style={styles.gapXl} />
                {noticeBlock(notice)}
              </>
            )}
            <View style={styles.gapXl} />
            <PrimaryButton styles={styles} colors={colors} label={t('done')} onPress={goBack} />
          </View>
        )}

        {/* ══ Already paid — a success terminal, not an error ══
            Focal: the headline. There is no figure to show — this device never
            saw a second payment — so nothing here is at display scale. */}
        {phase === 'already_paid' && (
          <Animated.View entering={settleIn} style={styles.stage}>
            <Ionicons name="checkmark-done-circle-outline" size={56} color={colors.textSecondary} />
            <View style={styles.gapLg} />
            {phaseTitle(t('local_pay_already_paid'))}
            {supportText(t('local_pay_queued'))}
            <View style={styles.gapXl} />
            {/* Deliberately no retry: reset() would mint a fresh session and ask
                the payer to pay a second time for money already queued here. */}
            <PrimaryButton styles={styles} colors={colors} label={t('done')} onPress={goBack} />
          </Animated.View>
        )}

        {/* ══ Failed ══
            Focal: the reason. The title is generic by design, so the sentence
            under it carries the information and gets the weight. */}
        {phase === 'failed' && (
          <Animated.View entering={settleIn} style={styles.stage} accessibilityRole="alert">
            <View style={[styles.heroCircle, { backgroundColor: colors.error + '15' }]}>
              <Ionicons name="alert-circle-outline" size={40} color={colors.error} />
            </View>
            <View style={styles.gapLg} />
            {phaseTitle(t('local_pay_failed'))}
            <Text style={[styles.reason, { color: colors.textPrimary }]} textBreakStrategy="balanced">
              {failure?.detail}
            </Text>
            <View style={styles.gapXl} />

            {/* A frame reached this device but never reached storage. Retry the
                SAME session — reset() would mint one that can never receive it. */}
            {unsettled && (
              <>
                <PrimaryButton
                  styles={styles}
                  colors={colors}
                  icon="refresh"
                  label={t('local_pay_retry_save')}
                  onPress={retrySettle}
                />
                <View style={styles.gapMd} />
              </>
            )}

            {failure?.settings && (
              <>
                <SecondaryButton
                  styles={styles}
                  colors={colors}
                  icon="settings-outline"
                  label={t('open_settings')}
                  onPress={() => void Linking.openSettings()}
                />
                <View style={styles.gapMd} />
              </>
            )}

            {paymentQr && (
              <>
                <SecondaryButton
                  styles={styles}
                  colors={colors}
                  icon="qr-code-outline"
                  label={t('local_pay_show_qr_instead')}
                  onPress={() => {
                    setFailure(null)
                    setPhase('send_qr')
                  }}
                />
                <View style={styles.gapMd} />
              </>
            )}

            {/* With a frame in hand, reset() means abandoning it — the frame lives
                only in memory — so it is demoted to the secondary action. */}
            {unsettled ? (
              <CancelButton styles={styles} colors={colors} label={t('cancel')} onPress={reset} />
            ) : (
              <PrimaryButton styles={styles} colors={colors} label={t('retry')} onPress={reset} />
            )}
          </Animated.View>
        )}
      </ScrollView>

      {/* ══ Scanner ══ */}
      <Modal visible={scannerOpen} animationType="slide" onRequestClose={closeScanner} statusBarTranslucent>
        <StatusBar style="light" />
        <QRScanner
          multiScan
          continuous={phase === 'receive_scan'}
          onScan={phase === 'send_scan' ? onSessionScanned : onFrameScanned}
          onClose={closeScanner}
          hintText={phase === 'send_scan' ? t('local_pay_scan_qr') : t('local_pay_scan_payer_qr')}
          renderBottom={
            phase === 'receive_scan' && scanProgress
              ? () => (
                  <Text style={{ color: 'rgba(255,255,255,0.8)', marginTop: 8 }}>
                    {t('local_pay_scan_progress', { have: scanProgress.have, total: scanProgress.total })}
                  </Text>
                )
              : undefined
          }
        />
      </Modal>

      {/* ══ The moment ══
          Celebration fires haptics.success() itself. This screen must never fire
          a second one — two success notifications in a row read as an error. */}
      {celebrating && (
        <View style={styles.celebrationOverlay} pointerEvents="none">
          <Celebration onDone={() => setCelebrating(false)} />
        </View>
      )}

      {/* The payee's receipt. Full screen, and it stays until acknowledged —
          being paid in person is the one moment both people are watching for. */}
      {receivedOverlay && (
        <ReceivedOverlay
          amount={receivedOverlay.amount}
          broadcast={receivedOverlay.broadcast}
          onDismiss={() => setReceivedOverlay(null)}
        />
      )}
    </View>
  )
}

// ── Small components ──
//
// Every control below covers the full interaction set RN can express: default,
// pressed (PressableScale's 0.97 spring, plus a fill change where the shape is
// not already filled), disabled (dimmed AND announced through
// accessibilityState, not colour alone), and focus, which on this platform is
// VoiceOver's focus and is served by the role/label/state triple. There is no
// hover on a touch device; a pointer-capable iPad hover falls back to the
// pressed treatment.

type Colors = ReturnType<typeof useTheme>['colors']
type Styles = ReturnType<typeof makeStyles>

function PrimaryButton({
  styles,
  colors,
  label,
  icon,
  onPress,
  disabled
}: {
  styles: Styles
  colors: Colors
  label: string
  icon?: keyof typeof Ionicons.glyphMap
  onPress: () => void
  disabled?: boolean
}) {
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      haptic="confirm"
      style={[styles.button, { backgroundColor: disabled ? colors.fill : colors.accent }]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
    >
      {!!icon && <Ionicons name={icon} size={20} color={disabled ? colors.textTertiary : colors.textOnAccent} />}
      <Text style={[styles.buttonText, { color: disabled ? colors.textTertiary : colors.textOnAccent }]}>
        {label}
      </Text>
    </PressableScale>
  )
}

function SecondaryButton({
  styles,
  colors,
  label,
  icon,
  onPress,
  disabled
}: {
  styles: Styles
  colors: Colors
  label: string
  icon?: keyof typeof Ionicons.glyphMap
  onPress: () => void
  disabled?: boolean
}) {
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      haptic="tap"
      style={[styles.button, styles.buttonOutline, { borderColor: colors.separator }]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
    >
      {!!icon && <Ionicons name={icon} size={18} color={disabled ? colors.textTertiary : colors.accent} />}
      <Text style={[styles.buttonText, { color: disabled ? colors.textTertiary : colors.accent }]}>{label}</Text>
    </PressableScale>
  )
}

function CancelButton({
  styles,
  colors,
  label,
  onPress
}: {
  styles: Styles
  colors: Colors
  label: string
  onPress: () => void
}) {
  return (
    <PressableScale
      onPress={onPress}
      haptic="tap"
      style={styles.cancel}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text style={[styles.cancelText, { color: colors.textSecondary }]}>{label}</Text>
    </PressableScale>
  )
}

/**
 * Specific amount vs any amount.
 *
 * Concentric by construction: the track's 10pt radius is the segment's 8pt plus
 * the 2pt inset between them, so the selected pill sits parallel to the outer
 * edge instead of drifting away from it at the corners.
 */
// ── Styles ──
//
// Density: 8pt vertical rhythm, 16pt gutter (spacing.lg), 24pt between sections
// (spacing.xxl), 8pt within a group (spacing.sm). Horizontal insets use
// Start/End rather than Left/Right so Arabic mirrors correctly; `row` is flipped
// by Yoga itself.

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
    // 44×44 — the HIG minimum, and the reason the header is 8pt-padded rather
    // than sized to the glyph.
    headerBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    headerTitle: { ...typography.headline, flexShrink: 1, textAlign: 'center' },
    scroll: { padding: spacing.lg },

    stage: { alignItems: 'center', paddingVertical: spacing.xxl },
    stageTight: { alignItems: 'center' },

    // Rhythm spacers. Named for the token so the 8pt grid stays visible in the
    // markup rather than hiding inside a dozen one-off margins.
    gapSm: { height: spacing.sm },
    gapMd: { height: spacing.md },
    gapLg: { height: spacing.lg },
    gapXl: { height: spacing.xxl },

    heroCircle: {
      width: 88,
      height: 88,
      borderRadius: 44,
      alignItems: 'center',
      justifyContent: 'center'
    },

    // ── Type: four levels, hierarchy from size + weight + colour together ──
    // L1 display 44/700  the amount, and only the amount
    // L2 title2  22/700  the phase heading
    // L3 subhead 15/400  supporting sentence, textSecondary
    // L4 footnote 13/400 status and metadata, textTertiary
    amountBlock: { alignItems: 'center' },
    amountDisplay: { ...typography.display, fontVariant: ['tabular-nums'], textAlign: 'center' },
    amountTitle: { ...typography.title2, fontVariant: ['tabular-nums'], textAlign: 'center' },
    title: { ...typography.title2, textAlign: 'center' },
    support: { ...typography.subhead, textAlign: 'center', marginTop: spacing.sm },
    reason: { ...typography.subhead, fontWeight: '500', textAlign: 'center', marginTop: spacing.sm },
    fieldLabel: { ...typography.caption2, fontWeight: '600', letterSpacing: 0.8, marginBottom: spacing.sm },

    presenceSlot: { alignSelf: 'stretch', alignItems: 'center' },

    // Concentric: outer 20 = inner plate 4 + padding 16.
    qrCard: {
      backgroundColor: '#fff',
      padding: spacing.lg,
      borderRadius: radii.xl,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.1,
      shadowRadius: 16,
      elevation: 6
    },
    qrPlate: { borderRadius: 4, overflow: 'hidden', backgroundColor: '#fff' },
    qrError: {
      alignSelf: 'stretch',
      alignItems: 'center',
      paddingVertical: spacing.xxxl,
      paddingHorizontal: spacing.lg,
      borderRadius: radii.xl,
      borderWidth: StyleSheet.hairlineWidth
    },

    button: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      alignSelf: 'stretch',
      gap: spacing.sm,
      minHeight: 48,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.lg,
      borderRadius: radii.md
    },
    buttonOutline: { borderWidth: StyleSheet.hairlineWidth },
    buttonText: { ...typography.body, fontWeight: '600' },

    cancel: {
      alignItems: 'center',
      justifyContent: 'center',
      alignSelf: 'stretch',
      minHeight: 44,
      paddingVertical: spacing.md,
      borderRadius: radii.md,
      marginTop: spacing.lg
    },
    cancelText: { ...typography.body, fontWeight: '500' },

    // Concentric: track 10 = segment 8 + 2pt inset.
    segmentTrack: {
      flexDirection: 'row',
      alignSelf: 'stretch',
      padding: 2,
      borderRadius: radii.md
    },
    segmentTextSelected: { fontWeight: '600' },

    idCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      alignSelf: 'stretch',
      padding: spacing.md,
      borderRadius: radii.lg,
      borderWidth: StyleSheet.hairlineWidth
    },
    avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
    idText: { flex: 1, minWidth: 0, gap: 2 },
    idLabel: { ...typography.caption2, fontWeight: '600', letterSpacing: 0.8 },
    idName: { ...typography.body, fontWeight: '600' },
    idKey: { ...typography.caption2, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },

    notice: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      alignSelf: 'stretch',
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.md,
      borderRadius: radii.md,
      borderWidth: StyleSheet.hairlineWidth
    },
    noticeText: { ...typography.footnote, flex: 1 },

    celebrationOverlay: {
      ...StyleSheet.absoluteFillObject,
      alignItems: 'center',
      justifyContent: 'center'
    }
  })
}
