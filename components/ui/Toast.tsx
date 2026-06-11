/**
 * Non-modal notice capsule (spec Part 2). For FYI messages only — decisions
 * use showAlert. Queue of 1: newest replaces current. Auto-dismiss 2s.
 *
 *   showToast('Copied')
 *   showToast(t('export_failed'), { type: 'error' })
 *
 * <ToastHost /> must be mounted once, inside ThemeProvider, ABOVE the Stack
 * (app/_layout.tsx). Near-solid background — no BlurView (see motion.ts).
 */
import React, { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  useReducedMotion,
} from 'react-native-reanimated'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { springs, durations } from '@/context/theme/motion'
import { haptics } from '@/hooks/useHaptics'

export type ToastType = 'info' | 'success' | 'error'
interface ToastData { id: number; message: string; type: ToastType }

const TOAST_MS = 2000

let push: ((message: string, type: ToastType) => void) | null = null
let nextId = 1

export function showToast(message: string, opts?: { type?: ToastType }) {
  const type = opts?.type ?? 'info'
  if (type === 'success') haptics.success()
  if (type === 'error') haptics.error()
  if (!push) { console.warn('[Toast] ToastHost not mounted:', message); return }
  push(message, type)
}

export function ToastHost() {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const reducedMotion = useReducedMotion()
  const [toast, setToast] = useState<ToastData | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const progress = useSharedValue(0)

  useEffect(() => {
    push = (message, type) => {
      if (hideTimer.current) clearTimeout(hideTimer.current)
      setToast({ id: nextId++, message, type })
    }
    return () => { push = null }
  }, [])

  useEffect(() => {
    if (!toast) return
    progress.value = 0
    progress.value = reducedMotion
      ? withTiming(1, { duration: durations.instant })
      : withSpring(1, springs.snappy)
    hideTimer.current = setTimeout(() => {
      progress.value = withTiming(0, { duration: durations.quick })
      hideTimer.current = setTimeout(() => setToast(null), durations.quick)
    }, TOAST_MS)
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current) }
  }, [toast, progress, reducedMotion])

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: -12 * (1 - progress.value) }],
  }))

  if (!toast) return null

  const icon = toast.type === 'success' ? 'checkmark-circle'
    : toast.type === 'error' ? 'alert-circle'
    : null
  const iconColor = toast.type === 'success' ? colors.success : colors.error

  return (
    <View pointerEvents="none" style={[styles.wrap, { top: insets.top + spacing.sm }]}>
      <Animated.View
        key={toast.id}
        style={[
          styles.capsule,
          { backgroundColor: colors.sheetBackground, borderColor: colors.separator },
          animatedStyle,
        ]}
      >
        {icon && <Ionicons name={icon} size={18} color={iconColor} style={styles.icon} />}
        <Text numberOfLines={2} style={[styles.text, { color: colors.textPrimary }]}>
          {toast.message}
        </Text>
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 10000,
  },
  capsule: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: '86%',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  icon: { marginRight: spacing.sm },
  text: { ...typography.subhead, flexShrink: 1 },
})
