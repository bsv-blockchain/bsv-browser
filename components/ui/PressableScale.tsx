/**
 * Standard press feedback (spec Part 2): scale 0.97 driven by a UI-thread
 * spring. Replaces bare TouchableOpacity / opacity-only Pressable in
 * interactive chrome. Optional semantic haptic on press.
 *
 * The Pressable itself is animated (via createAnimatedComponent) so the style
 * prop lands directly on the animated node — no inner Animated.View wrapper.
 *
 * animateOpacity (default false):
 *   WARNING — fractional opacity animation on an ancestor of LiquidGlass /
 *   BlurView freezes UIVisualEffectView on iOS. Scale-only is safe everywhere.
 *   Only set animateOpacity=true when you are certain no BlurView lives inside
 *   or behind this pressable.
 *
 * Reduced motion:
 *   When the system "Reduce Motion" accessibility setting is on, both the scale
 *   transform and opacity animation are suppressed entirely. Haptic feedback and
 *   onPress still fire normally.
 */
import React, { useCallback } from 'react'
import { Pressable, StyleProp, ViewStyle, GestureResponderEvent } from 'react-native'
import type { PressableProps } from 'react-native'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  useReducedMotion,
} from 'react-native-reanimated'
import { springs } from '@/context/theme/motion'
import { haptics, HapticName } from '@/hooks/useHaptics'

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

interface PressableScaleProps extends PressableProps {
  /** Style applied directly to the animated Pressable node. */
  style?: StyleProp<ViewStyle>
  haptic?: HapticName
  scaleTo?: number
  /**
   * When true, opacity animates from 1 → 0.85 together with the scale spring.
   *
   * WARNING: fractional opacity animation on an ancestor of LiquidGlass /
   * BlurView freezes UIVisualEffectView on iOS. Leave this false (the default)
   * whenever a BlurView lives inside or behind this pressable.
   */
  animateOpacity?: boolean
  children?: React.ReactNode
}

export default function PressableScale({
  style,
  haptic,
  scaleTo = 0.97,
  animateOpacity = false,
  onPressIn,
  onPressOut,
  onPress,
  children,
  ...rest
}: PressableScaleProps) {
  const pressed = useSharedValue(0)
  const reducedMotion = useReducedMotion()

  const animatedStyle = useAnimatedStyle(() => {
    if (reducedMotion) {
      return {}
    }
    if (animateOpacity) {
      return {
        transform: [{ scale: 1 - (1 - scaleTo) * pressed.value }],
        opacity: 1 - 0.15 * pressed.value,
      }
    }
    return {
      transform: [{ scale: 1 - (1 - scaleTo) * pressed.value }],
    }
  }, [scaleTo, animateOpacity, reducedMotion])

  const handlePressIn = useCallback((e: GestureResponderEvent) => {
    pressed.value = withSpring(1, springs.snappy)
    onPressIn?.(e)
  }, [onPressIn, pressed])

  const handlePressOut = useCallback((e: GestureResponderEvent) => {
    pressed.value = withSpring(0, springs.snappy)
    onPressOut?.(e)
  }, [onPressOut, pressed])

  const handlePress = useCallback((e: GestureResponderEvent) => {
    if (haptic) haptics[haptic]()
    onPress?.(e)
  }, [haptic, onPress])

  return (
    <AnimatedPressable
      {...rest}
      accessibilityRole={rest.accessibilityRole ?? 'button'}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onPress={handlePress}
      style={[style, animatedStyle]}
    >
      {children}
    </AnimatedPressable>
  )
}
