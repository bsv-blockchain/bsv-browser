/**
 * 2px page-load progress line under the address bar. Driven by a Reanimated
 * shared value (0..1) owned by the parent; renders nothing when idle.
 * Eases ahead so it never appears stalled; snaps to 1 then fades on finish.
 */
import React from 'react'
import { StyleSheet } from 'react-native'
import Animated, { useAnimatedStyle, SharedValue } from 'react-native-reanimated'
import { useTheme } from '@/context/theme/ThemeContext'

interface Props {
  /** 0..1 load progress; set to 0 when idle, 1 triggers fade-out. */
  progress: SharedValue<number>
}

export default function LoadProgressBar({ progress }: Props) {
  const { colors } = useTheme()
  const style = useAnimatedStyle(() => ({
    width: `${Math.min(progress.value, 1) * 100}%` as any,
    opacity: progress.value > 0 && progress.value < 1 ? 1 : 0,
  }))
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.bar, { backgroundColor: colors.info }, style]}
    />
  )
}

const styles = StyleSheet.create({
  bar: { position: 'absolute', bottom: 0, left: 0, height: 2, borderRadius: 1 },
})
