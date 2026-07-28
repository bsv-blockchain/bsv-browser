/**
 * Presence — the quiet line that says whether another person's device is
 * actually there.
 *
 * This is the only screen in the app with a live peer, and this row is the only
 * place that fact is visible. It is STATUS, not decoration: every state below
 * is entered from a real signal, and there is deliberately no state for "we
 * think they're probably nearby".
 *
 * ── Why there is no separate "device found" ──
 *
 * The AWDL transport surfaces exactly two things to JS: a decoded frame, or an
 * error (see packages/react-native-localpay-transport — `startListening`,
 * `sendFrame`). There is no connection callback, so neither side can observe
 * discovery separately from the TLS-PSK handshake. By the time anything reaches
 * JS, the peer has been found AND the encrypted channel has carried real bytes.
 * Those two facts arrive together, so they are one state — `linked` — rather
 * than an invented pair of steps with a timer between them. Splitting them
 * would be theatre, and on a payment screen theatre is a lie about whether the
 * other device is really there.
 *
 * ── The honest degrades ──
 *
 * `qr` exists because the QR hand-off has no live link at all. It must never
 * animate like a connection or borrow connection language: the payer's device
 * is not talking to the payee's, and pretending otherwise would tell someone a
 * stranger's phone is on the other end of a channel that does not exist.
 *
 * `ready` says a nearby route is *available* — the peer's pairing code claims
 * AWDL and this device supports it — not that anything is open yet.
 *
 * ── Colour ──
 *
 * Green appears on exactly one state, `paid`, because green on this screen
 * means confirmed money and nothing else. `linked` — the moment the other
 * person's device is proven present — earns its emphasis from weight and text
 * colour instead, never from the accent.
 */
import React, { useEffect } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, typography } from '@/context/theme/tokens'
import { durations, easings, springs } from '@/context/theme/motion'

export type PresenceState =
  /** No live link on this path. The QR hand-off. */
  | 'qr'
  /** An encrypted nearby route is available; nothing is open yet. */
  | 'ready'
  /** Genuinely listening or searching for the peer right now. */
  | 'waiting'
  /** An encrypted peer-to-peer link carried real bytes. Found + secured, proven together. */
  | 'linked'
  /** Confirmed money. The only state that may be green. */
  | 'paid'

interface PresenceRowProps {
  state: PresenceState
  /** Localized, role-appropriate sentence. The screen owns the wording. */
  label: string
  /** The peer's resolved display name, when identity lookup found one. */
  peer?: string | null
}

const ICONS: Record<PresenceState, keyof typeof Ionicons.glyphMap> = {
  qr: 'qr-code-outline',
  ready: 'wifi',
  waiting: 'wifi',
  linked: 'lock-closed',
  paid: 'checkmark-circle',
}

const DOT = 8

export default function PresenceRow({ state, label, peer }: PresenceRowProps) {
  const { colors } = useTheme()
  const reducedMotion = useReducedMotion()

  // 0 → 1 on every state change. Re-run rather than cross-faded: the row is one
  // short line, so a clean re-entry reads as "this changed" where a dissolve
  // reads as a rendering artifact.
  const enter = useSharedValue(1)
  // Ambient breathing while genuinely waiting. Never runs in any other state —
  // a pulsing dot beside "Paid" would imply something is still in flight.
  const pulse = useSharedValue(1)

  useEffect(() => {
    if (reducedMotion) {
      enter.value = 0
      enter.value = withTiming(1, { duration: durations.instant, easing: easings.out })
      return
    }
    enter.value = 0
    enter.value = withSpring(1, springs.snappy)
  }, [state, reducedMotion, enter])

  useEffect(() => {
    if (state !== 'waiting' || reducedMotion) {
      pulse.value = withTiming(1, { duration: durations.instant, easing: easings.out })
      return
    }
    pulse.value = withRepeat(
      withSequence(
        withTiming(0.35, { duration: durations.moderate, easing: easings.out }),
        withTiming(1, { duration: durations.moderate, easing: easings.out })
      ),
      -1,
      false
    )
  }, [state, reducedMotion, pulse])

  // Opacity is animated on this row's own content only. It is never an ancestor
  // of LiquidGlass or BlurView — see the guardrail at the top of
  // context/theme/motion.ts — and must not become one.
  const rowStyle = useAnimatedStyle(() => {
    if (reducedMotion) return { opacity: enter.value }
    return {
      opacity: enter.value,
      transform: [{ translateY: (1 - enter.value) * 6 }],
    }
  }, [reducedMotion])

  const dotStyle = useAnimatedStyle(() => ({ opacity: pulse.value }), [])

  const paid = state === 'paid'
  const strong = paid || state === 'linked'
  const dotColor = paid ? colors.success : strong ? colors.textPrimary : colors.textTertiary
  const labelColor = paid ? colors.success : strong ? colors.textPrimary : colors.textSecondary

  return (
    <Animated.View
      // Announced as one string so VoiceOver does not read the peer name as a
      // separate, contextless element.
      accessibilityRole="text"
      accessibilityLabel={peer ? `${label}. ${peer}` : label}
      style={[styles.row, rowStyle]}
    >
      <Animated.View style={dotStyle}>
        {state === 'waiting' ? (
          <View style={[styles.dot, { backgroundColor: dotColor }]} />
        ) : (
          <Ionicons name={ICONS[state]} size={13} color={dotColor} />
        )}
      </Animated.View>
      <Text style={[styles.label, { color: labelColor }, strong && styles.labelStrong]} numberOfLines={1}>
        {label}
      </Text>
      {!!peer && (
        <>
          <Text style={[styles.sep, { color: colors.textQuaternary }]}>·</Text>
          <Text style={[styles.peer, { color: colors.textSecondary }]} numberOfLines={1}>
            {peer}
          </Text>
        </>
      )}
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    // Held constant across every state so the content beneath never shifts as
    // the status changes.
    minHeight: 20,
    paddingHorizontal: spacing.sm,
  },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
  label: { ...typography.footnote, flexShrink: 1 },
  labelStrong: { fontWeight: '600' },
  sep: { ...typography.footnote },
  peer: { ...typography.footnote, flexShrink: 1 },
})
