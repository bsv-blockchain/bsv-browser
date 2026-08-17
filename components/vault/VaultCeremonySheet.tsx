/**
 * The vault ceremony sheet — the one place the user is told what to do with the
 * YubiKey and why. Globally mounted (beside PermissionSheet); driven by
 * VaultContext, which mirrors the ceremony singleton.
 *
 * Every phase says three things: WHY (the reason string / transfer summary),
 * WHAT to do now (the phase copy + illustration), and how long is left
 * (countdown on awaiting-touch and armed). Motion is scale/opacity of the
 * sheet's own subviews only — never a fractional-opacity animation over glass
 * (the UIVisualEffectView freeze guardrail).
 */
import React, { useEffect, useRef, useState } from 'react'
import { View, Text, StyleSheet, TextInput, ActivityIndicator, Platform } from 'react-native'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  cancelAnimation,
  useReducedMotion,
  Easing
} from 'react-native-reanimated'
import { Ionicons } from '@expo/vector-icons'
import Sheet from '@/components/ui/Sheet'
import PressableScale from '@/components/ui/PressableScale'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { useVault } from '@/context/VaultContext'
import { haptics } from '@/hooks/useHaptics'
import i18n from '@/context/i18n/translations'
import type { CeremonyPhase } from '@/services/vault/ceremony'
import type { VaultErrorCode } from '@/services/vault/types'

const t = (k: string, opts?: Record<string, unknown>) => i18n.t(k, opts) as string

const ERROR_COPY: Record<string, string> = {
  'serial-mismatch': 'vault_err_wrong_key',
  'wrong-key': 'vault_err_wrong_key',
  'touch-timeout': 'vault_err_touch_timeout',
  'pin-locked': 'vault_err_pin_locked',
  'pin-invalid': 'vault_err_pin_invalid',
  'key-removed-mid-op': 'vault_err_removed',
  'no-key': 'vault_err_no_key',
  'driver-unavailable': 'vault_err_unavailable',
  'not-enrolled': 'vault_err_unavailable',
  'mgmt-key-custom': 'vault_err_mgmt_key',
  'user-cancelled': 'vault_err_generic',
  'unsupported-platform': 'vault_err_unavailable',
  'slot-occupied': 'vault_err_generic',
  'pin-required': 'vault_enter_pin',
  'nfc-lost': 'vault_err_nfc_lost'
}

/** Errors where the fix is simply "do the tap again" — worth a Retry button
 * instead of only Dismiss. Must stay a SUBSET of `CeremonyController`'s own
 * retryable set (services/vault/ceremony.ts) or the button renders but does
 * nothing — 'key-removed-mid-op' is deliberately excluded even though the
 * ceremony loop can produce it, because it can ALSO arrive from a moment the
 * loop doesn't cover (waiting-for-key), where retry would be a dead button. */
const RETRYABLE_ERRORS = new Set<string>(['touch-timeout', 'nfc-lost'])

/** Swallows the sheet's dismiss while work is in flight — `Sheet` requires an
 * onClose, and cancelling mid-signature is the thing we are preventing. */
const noop = (): void => {}

const PhaseIcon: Record<CeremonyPhase, keyof typeof Ionicons.glyphMap> = {
  idle: 'lock-closed',
  'waiting-for-key': 'hardware-chip-outline',
  connecting: 'sync-outline',
  'pin-entry': 'keypad-outline',
  'awaiting-touch': 'finger-print-outline',
  preparing: 'lock-open-outline',
  signing: 'create-outline',
  broadcasting: 'paper-plane-outline',
  armed: 'lock-open',
  error: 'alert-circle-outline'
}

export const VaultCeremonySheet: React.FC = () => {
  const { colors } = useTheme()
  const { state, submitPin, cancel, retry } = useVault()
  const reducedMotion = useReducedMotion()
  const [pin, setPin] = useState('')

  const phase = state.phase
  // 'armed' stays hidden: it persists for the whole retention window, so
  // showing it would leave the sheet up for minutes after a withdrawal is done.
  const visible = phase !== 'idle' && phase !== 'armed'

  /**
   * Work is under way and there is nothing for the user to do but wait.
   *
   * The sheet is deliberately NOT dismissable here. A backdrop tap runs
   * cancel(), which mid-signature is the abandonment this progress display
   * exists to prevent — and a cancelled withdrawal can leave the vault UTXO
   * reserved. Cancel stays available while we are waiting on the user
   * (waiting-for-key, pin-entry).
   */
  const busy = phase === 'preparing' || phase === 'signing' || phase === 'broadcasting'

  // Pulse the icon while waiting for the user to act (insert / touch).
  const pulse = useSharedValue(1)
  useEffect(() => {
    const active =
      phase === 'waiting-for-key' ||
      phase === 'awaiting-touch' ||
      phase === 'preparing' ||
      phase === 'signing' ||
      phase === 'broadcasting'
    if (active && !reducedMotion) {
      pulse.value = withRepeat(
        withSequence(
          withTiming(1.12, { duration: 700, easing: Easing.inOut(Easing.quad) }),
          withTiming(1, { duration: 700, easing: Easing.inOut(Easing.quad) })
        ),
        -1,
        false
      )
    } else {
      cancelAnimation(pulse)
      pulse.value = withTiming(1, { duration: 150 })
    }
    return () => cancelAnimation(pulse)
  }, [phase, reducedMotion, pulse])
  const pulseStyle = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }))

  // Reset the PIN field whenever we (re)enter pin-entry.
  useEffect(() => {
    if (phase === 'pin-entry') setPin('')
  }, [phase])

  const reason = state.reason
  const errCode = state.error?.code as VaultErrorCode | undefined

  // iOS talks to the key over NFC (a tap), Android over USB (insert + touch).
  const nfc = Platform.OS === 'ios'

  const title = (() => {
    switch (phase) {
      case 'waiting-for-key':
        return nfc ? t('vault_hold_key_nfc') : t('vault_insert_key')
      case 'connecting':
        return t('vault_reading_key')
      case 'pin-entry':
        return t('vault_enter_pin')
      case 'awaiting-touch':
        return nfc ? t('vault_keep_holding_nfc') : t('vault_touch_contact')
      case 'preparing':
        return t('vault_unlocking_funds')
      case 'signing':
        return t('vault_unlocking_funds')
      case 'broadcasting':
        return t('vault_sending_to_network')
      case 'error':
        return t((errCode && ERROR_COPY[errCode]) ?? 'vault_err_generic')
      default:
        return ''
    }
  })()

  const iconColor = phase === 'error' ? colors.error : colors.accent

  return (
    <Sheet visible={visible} onClose={busy ? noop : cancel} title={t('vault_title')} fitContent>
      <View style={styles.body}>
        {reason ? <Text style={[styles.reason, { color: colors.textSecondary }]}>{reason}</Text> : null}

        <Animated.View style={[styles.iconWrap, { backgroundColor: colors.backgroundSecondary }, pulseStyle]}>
          {phase === 'connecting' || busy ? (
            <ActivityIndicator color={iconColor} />
          ) : (
            <Ionicons name={PhaseIcon[phase]} size={40} color={iconColor} />
          )}
        </Animated.View>

        <Text style={[styles.title, { color: colors.textPrimary }]}>{title}</Text>

        {/* The whole point of the busy phases: say the work is real, say not to
            leave, and — when there is more than one signature — say how far
            along it is, so a long wait reads as progress rather than a hang. */}
        {busy && (
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
            {phase === 'broadcasting' ? t('vault_sending_sub') : t('vault_unlocking_sub')}
          </Text>
        )}

        {state.signing && state.signing.total > 1 && phase !== 'broadcasting' && (
          <Text style={[styles.subtitle, { color: colors.textTertiary }]}>
            {t('vault_signature_progress', {
              index: state.signing.index,
              total: state.signing.total
            })}
          </Text>
        )}

        {phase === 'awaiting-touch' && <TouchCountdown color={colors.accent} trackColor={colors.backgroundSecondary} />}

        {phase === 'pin-entry' && (
          <>
            <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
              {nfc ? t('vault_pin_sub_nfc') : t('vault_pin_sub_usb')}
            </Text>
            <TextInput
              style={[styles.pin, { color: colors.textPrimary, backgroundColor: colors.backgroundSecondary }]}
              value={pin}
              onChangeText={setPin}
              placeholder="••••••"
              placeholderTextColor={colors.textTertiary}
              keyboardType="number-pad"
              secureTextEntry
              maxLength={8}
              autoFocus
            />
            {state.error?.code === 'pin-invalid' && typeof state.error.retriesLeft === 'number' && (
              <Text style={[styles.hint, { color: colors.warning }]}>
                {t('vault_pin_retries', { count: state.error.retriesLeft })}
              </Text>
            )}
            <PressableScale
              haptic="confirm"
              onPress={() => {
                if (pin.length >= 4) submitPin(pin)
              }}
              style={[styles.primaryBtn, { backgroundColor: colors.accent, opacity: pin.length >= 4 ? 1 : 0.4 }]}
            >
              <Text style={[styles.primaryLabel, { color: colors.textOnAccent }]}>{t('vault_unlock_cta')}</Text>
            </PressableScale>
          </>
        )}

        {phase === 'error' && errCode === 'pin-invalid' && (
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
            {typeof state.error?.retriesLeft === 'number'
              ? t('vault_pin_invalid_retry', { count: state.error.retriesLeft })
              : t('vault_pin_invalid_retry_generic')}
          </Text>
        )}

        {phase === 'error' && (
          <View style={styles.errorActions}>
            {errCode && RETRYABLE_ERRORS.has(errCode) && (
              <PressableScale
                haptic="confirm"
                onPress={retry}
                style={[styles.primaryBtn, { backgroundColor: colors.accent }]}
              >
                <Text style={[styles.primaryLabel, { color: colors.textOnAccent }]}>{t('vault_retry')}</Text>
              </PressableScale>
            )}
            <PressableScale onPress={cancel} style={styles.secondaryBtn}>
              <Text style={[styles.secondaryLabel, { color: colors.textSecondary }]}>{t('vault_dismiss')}</Text>
            </PressableScale>
          </View>
        )}

        {(phase === 'waiting-for-key' || phase === 'awaiting-touch' || phase === 'connecting') && (
          <PressableScale onPress={cancel} style={styles.secondaryBtn}>
            <Text style={[styles.secondaryLabel, { color: colors.textSecondary }]}>{t('vault_cancel')}</Text>
          </PressableScale>
        )}
      </View>
    </Sheet>
  )
}

/** 15-second ring that empties while the key waits for a touch. Purely a UI
 * countdown — the native touch policy enforces the real timeout. */
const TouchCountdown: React.FC<{ color: string; trackColor: string }> = ({ color, trackColor }) => {
  const reducedMotion = useReducedMotion()
  const progress = useSharedValue(1)
  const startedRef = useRef(false)
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    if (reducedMotion) return
    haptics.tap()
    progress.value = withTiming(0, { duration: 15000, easing: Easing.linear })
    return () => cancelAnimation(progress)
  }, [progress, reducedMotion])
  const style = useAnimatedStyle(() => ({ width: `${Math.max(0, progress.value) * 100}%` }))
  return (
    <View style={[styles.countdownTrack, { backgroundColor: trackColor }]}>
      <Animated.View style={[styles.countdownFill, { backgroundColor: color }, style]} />
    </View>
  )
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxl, alignItems: 'center', gap: spacing.lg },
  reason: { ...typography.subhead, textAlign: 'center' },
  iconWrap: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.md
  },
  title: { ...typography.title3, textAlign: 'center' },
  subtitle: { ...typography.subhead, textAlign: 'center', marginTop: -spacing.sm },
  pin: {
    width: '70%',
    textAlign: 'center',
    ...typography.title2,
    letterSpacing: 8,
    borderRadius: radii.md,
    paddingVertical: spacing.md
  },
  hint: { ...typography.footnote },
  primaryBtn: { width: '100%', borderRadius: radii.md, paddingVertical: spacing.lg, alignItems: 'center' },
  primaryLabel: { ...typography.headline },
  secondaryBtn: { paddingVertical: spacing.md, alignItems: 'center' },
  secondaryLabel: { ...typography.body },
  errorActions: { width: '100%', gap: spacing.sm },
  countdownTrack: { width: '80%', height: 6, borderRadius: 3, overflow: 'hidden' },
  countdownFill: { height: '100%' }
})
