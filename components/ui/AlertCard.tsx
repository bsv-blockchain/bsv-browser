/**
 * Glass Alert Card (spec Part 2) — themed replacement for Alert.alert.
 * Imperative promise API so plain utils can call it:
 *
 *   const choice = await showAlert({
 *     title, message,
 *     buttons: [
 *       { text: t('cancel'), style: 'cancel', key: 'cancel' },
 *       { text: t('delete'), style: 'destructive', key: 'delete' },
 *     ],
 *   })
 *   if (choice === 'delete') { ... }
 *
 * <AlertHost /> must be mounted once, inside ThemeProvider (app/_layout.tsx).
 * Background is near-solid sheetBackground — deliberately NOT BlurView/LiquidGlass
 * (fractional-opacity-over-effect-view guardrail in context/theme/motion.ts).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  useReducedMotion,
} from 'react-native-reanimated'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { springs, durations } from '@/context/theme/motion'
import { haptics } from '@/hooks/useHaptics'

export interface AlertButton {
  text: string
  style?: 'default' | 'cancel' | 'destructive'
  /** Resolution value. Defaults to lowercased text. */
  key?: string
}

export interface AlertOptions {
  title: string
  message?: string
  /** Defaults to a single OK button (key "ok"). Max 3; 2 render side-by-side, 3 stack. */
  buttons?: AlertButton[]
}

type ActiveAlert = AlertOptions & { resolve: (key: string) => void }

let enqueue: ((a: ActiveAlert) => void) | null = null

export function showAlert(options: AlertOptions): Promise<string> {
  return new Promise<string>(resolve => {
    if (!enqueue) {
      console.warn('[AlertCard] AlertHost not mounted; resolving "cancel"')
      resolve('cancel')
      return
    }
    enqueue({ ...options, resolve })
  })
}

const DEFAULT_BUTTONS: AlertButton[] = [{ text: 'OK', key: 'ok' }]

export function AlertHost() {
  const { colors } = useTheme()
  const reducedMotion = useReducedMotion()
  const [queue, setQueue] = useState<ActiveAlert[]>([])
  const current = queue[0] ?? null

  const progress = useSharedValue(0)
  const exiting = useRef(false)
  const lastHapticAlert = useRef<ActiveAlert | null>(null)

  useEffect(() => {
    enqueue = (a: ActiveAlert) => setQueue(q => [...q, a])
    return () => {
      enqueue = null
      // Resolve all queued alerts with 'cancel' on unmount.
      setQueue(q => {
        q.forEach(a => a.resolve('cancel'))
        return []
      })
    }
  }, [])

  useEffect(() => {
    if (current) {
      // Reset progress to 0 before animating in to avoid stale values.
      progress.value = 0
      // Fire warning haptic at most once per distinct alert object.
      if (
        current.buttons?.some(b => b.style === 'destructive') &&
        lastHapticAlert.current !== current
      ) {
        lastHapticAlert.current = current
        haptics.warning()
      }
      progress.value = reducedMotion
        ? withTiming(1, { duration: durations.instant })
        : withSpring(1, springs.snappy)
    }
  }, [current, progress, reducedMotion])

  const dismiss = useCallback((key: string) => {
    if (!current || exiting.current) return
    exiting.current = true
    current.resolve(key)
    progress.value = withTiming(0, { duration: durations.instant })
    // Unmount after the exit fade completes.
    setTimeout(() => { exiting.current = false; setQueue(q => q.slice(1)) }, durations.instant)
  }, [current, progress])

  const backdropStyle = useAnimatedStyle(() => ({ opacity: progress.value }))
  const cardStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: 0.95 + 0.05 * progress.value }],
  }))

  if (!current) return null
  const buttons = current.buttons?.length ? current.buttons : DEFAULT_BUTTONS
  const sideBySide = buttons.length === 2

  const buttonColor = (b: AlertButton) =>
    b.style === 'destructive' ? colors.error
    : b.style === 'cancel' ? colors.textSecondary
    : colors.info

  return (
    <Modal
      transparent
      visible
      animationType="none"
      onRequestClose={() => dismiss('cancel')}
      statusBarTranslucent={Platform.OS === 'android'}
      navigationBarTranslucent={Platform.OS === 'android'}
    >
      <Animated.View style={[styles.backdrop, backdropStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => dismiss('cancel')} />
        <Animated.View
          style={[
            styles.card,
            { backgroundColor: colors.sheetBackground, borderColor: colors.separator },
            cardStyle,
          ]}
        >
          <Text style={[styles.title, { color: colors.textPrimary }]}>{current.title}</Text>
          {!!current.message && (
            <Text style={[styles.message, { color: colors.textSecondary }]}>{current.message}</Text>
          )}
          <View style={[styles.buttonGroup, { borderTopColor: colors.separator }, !sideBySide && styles.buttonGroupStacked]}>
            {buttons.map((b, i) => (
              <Pressable
                key={b.key ?? b.text}
                onPress={() => dismiss(b.key ?? b.text.toLowerCase())}
                style={({ pressed }) => [
                  styles.button,
                  sideBySide && i > 0 && { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.separator },
                  !sideBySide && i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator },
                  pressed && { backgroundColor: colors.fillTertiary },
                ]}
                accessibilityRole="button"
              >
                <Text
                  style={[
                    styles.buttonText,
                    { color: buttonColor(b) },
                    (b.style === 'destructive' || b.style === 'cancel') && styles.buttonTextBold,
                  ]}
                >
                  {b.text}
                </Text>
              </Pressable>
            ))}
          </View>
        </Animated.View>
      </Animated.View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  card: {
    width: 280,
    borderRadius: radii.xl,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    paddingTop: spacing.xl,
  },
  title: {
    ...typography.headline,
    textAlign: 'center',
    paddingHorizontal: spacing.xl,
  },
  message: {
    ...typography.footnote,
    textAlign: 'center',
    paddingHorizontal: spacing.xl,
    marginTop: spacing.xs,
  },
  buttonGroup: {
    flexDirection: 'row',
    marginTop: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  buttonGroupStacked: { flexDirection: 'column' },
  button: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
  },
  buttonText: { ...typography.body, textAlign: 'center' },
  buttonTextBold: { fontWeight: '600' },
})
