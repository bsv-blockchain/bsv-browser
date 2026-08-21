/**
 * The moment money arrives.
 *
 * Full screen, and it stays until the person receiving taps Done. That is the
 * whole point: a toast is the right weight for "your settings were saved" and
 * the wrong weight for "someone just paid you" — it can be missed entirely if
 * the phone is face down, in a pocket, or simply not being looked at when it
 * fires, and the one thing a payee must never be unsure about is whether the
 * money arrived. Requiring an acknowledgement means the event cannot be missed,
 * only dismissed.
 *
 * Presentational only. It reports nothing and decides nothing — by the time it
 * mounts the payment is already credited, so dismissing it cannot affect money.
 *
 * Staged in three beats, as the nearby flow's success screen is: the amount is
 * already on screen when the mark begins drawing, the mark fires the success
 * haptic from inside Celebration, then the tone sounds. Firing them together
 * reads as one blunt event and buries the figure, which is the thing that
 * actually matters.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Modal, StyleSheet, Text, View } from 'react-native'
import Animated, { FadeIn, FadeInDown, useReducedMotion } from 'react-native-reanimated'
import { router } from 'expo-router'
import { useTranslation } from 'react-i18next'

import AmountDisplay from '@/components/wallet/AmountDisplay'
import Celebration from '@/components/ui/Celebration'
import PressableScale from '@/components/ui/PressableScale'
import { useTheme } from '@/context/theme/ThemeContext'
import { durations, springs } from '@/context/theme/motion'
import { spacing, typography, radii } from '@/context/theme/tokens'
import { sounds } from '@/hooks/useConfirmationSound'

/** Beat two: the tone, just behind the mark. Sequencing, not animation. */
const TONE_DELAY_MS = 120

export interface ReceivedOverlayProps {
  /** Total satoshis credited (received) or paid (sent) in this event. */
  amount: number
  /** How many payments made up that total. Only shown when it is more than one. */
  count?: number
  /**
   * False when the payment was accepted with no network and has not reached a
   * broadcaster yet. The money is credited and spendable either way; what is
   * unsettled is whether anyone but these two devices has seen it, and the
   * payee is entitled to know that before treating it as final.
   */
  broadcast?: boolean
  /**
   * Which way the money moved. The staging is identical — that is the point of
   * sharing this screen across every rail — only the words change: 'received'
   * says the money is in the wallet; 'sent' names who it went to.
   */
  direction?: 'received' | 'sent'
  /** Sent only: the resolved counterparty (name, handle, or abbreviated address). */
  recipientName?: string
  /**
   * Acknowledged. The only way this screen closes. Clean up local state here —
   * the overlay itself then returns the user to the wallet, so the updated
   * balance is the next thing they see.
   */
  onDismiss: () => void
}

export default function PaymentSuccessOverlay({
  amount,
  count = 1,
  broadcast = true,
  direction = 'received',
  recipientName,
  onDismiss
}: ReceivedOverlayProps) {
  const sent = direction === 'sent'
  const { t } = useTranslation()
  const { colors } = useTheme()
  const reducedMotion = useReducedMotion()

  /**
   * The button appears once the mark has landed. It is not a gate — nothing is
   * pending — but a Done button already on screen while a checkmark is still
   * drawing invites a tap through the moment it exists to deliver.
   */
  const [ready, setReady] = useState(false)

  useEffect(() => {
    // Returns immediately and cannot throw, so a device with no audio session
    // simply gets the payment quietly.
    const tone = setTimeout(() => sounds.confirmation(), TONE_DELAY_MS)
    return () => clearTimeout(tone)
  }, [])

  // Hand the shared player back; a payee may leave this screen up on a counter.
  useEffect(() => () => sounds.release(), [])

  const onMarkDone = useCallback(() => setReady(true), [])

  /**
   * Done means "back to the wallet", uniformly: a completed payment in either
   * direction ends on the balance it changed. `navigate` walks back to the
   * wallet screen when it is already in the stack (the common case — Pay/Get
   * paid are reached from it) rather than stacking a fresh copy, and the wallet
   * refetches balance and activity on focus.
   */
  const acknowledge = useCallback(() => {
    onDismiss()
    router.navigate('/wallet')
  }, [onDismiss])

  const settleIn = reducedMotion
    ? undefined
    : FadeInDown.springify()
        .mass(springs.snappy.mass)
        .damping(springs.snappy.damping)
        .stiffness(springs.snappy.stiffness)
  const fadeIn = reducedMotion ? undefined : FadeIn.duration(durations.quick)

  return (
    <Modal
      visible
      animationType="fade"
      statusBarTranslucent
      // No onRequestClose handler that dismisses: Android's back button must not
      // be able to clear this without the acknowledgement being deliberate.
      onRequestClose={() => {}}
    >
      <View
        style={[styles.container, { backgroundColor: colors.background }]}
        accessibilityViewIsModal
        accessibilityRole="alert"
        accessibilityLabel={sent ? t('local_pay_sent') : `${t('local_pay_received')}. ${t('local_pay_added')}`}
      >
        <View style={styles.stage}>
          <Celebration onDone={onMarkDone} />
          <View style={styles.gapXl} />

          <Text style={[styles.title, { color: colors.textPrimary }]} textBreakStrategy="balanced">
            {t(sent ? 'local_pay_sent' : 'local_pay_received')}
          </Text>

          {/* The focal element. Everything else on this screen is a label. */}
          <Animated.View entering={settleIn} style={styles.amountBlock}>
            <Text
              style={[styles.amount, { color: colors.textPrimary }]}
              maxFontSizeMultiplier={1.3}
              numberOfLines={1}
              adjustsFontSizeToFit
              accessibilityRole="text"
            >
              <AmountDisplay>{amount}</AmountDisplay>
            </Text>
          </Animated.View>

          {sent ? (
            !!recipientName && (
              <Text style={[styles.support, { color: colors.textSecondary }]} numberOfLines={1} ellipsizeMode="middle">
                {recipientName}
              </Text>
            )
          ) : (
            <Text style={[styles.support, { color: colors.success }]} textBreakStrategy="balanced">
              {count > 1 ? t('local_pay_added_multiple', { count }) : t('local_pay_added')}
            </Text>
          )}

          {!broadcast && (
            <Text style={[styles.pending, { color: colors.textSecondary }]}>{t('pay_received_not_broadcast')}</Text>
          )}
        </View>

        {ready && (
          <Animated.View entering={fadeIn} style={styles.footer}>
            <PressableScale
              onPress={acknowledge}
              haptic="tap"
              style={[styles.button, { backgroundColor: colors.accent }]}
              accessibilityRole="button"
              accessibilityLabel={t('done')}
            >
              <Text style={[styles.buttonText, { color: colors.textOnAccent }]}>{t('done')}</Text>
            </PressableScale>
          </Animated.View>
        )}
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xxxl
  },
  stage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  gapXl: {
    height: spacing.xl
  },
  title: {
    ...typography.title2,
    fontWeight: '700',
    textAlign: 'center'
  },
  amountBlock: {
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
    alignSelf: 'stretch',
    alignItems: 'center'
  },
  amount: {
    fontSize: 44,
    lineHeight: 52,
    fontWeight: '700',
    textAlign: 'center'
  },
  support: {
    ...typography.subhead,
    textAlign: 'center'
  },
  pending: {
    ...typography.footnote,
    textAlign: 'center',
    marginTop: spacing.xs
  },
  footer: {
    paddingBottom: spacing.md
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md + 2,
    borderRadius: radii.md
  },
  buttonText: {
    ...typography.headline,
    fontWeight: '600'
  }
})
