/**
 * Standard press feedback (spec Part 2): scale 0.97 + opacity 0.85, driven by
 * a UI-thread spring. Replaces bare TouchableOpacity / opacity-only Pressable
 * in interactive chrome. Optional semantic haptic on press.
 */
import React, { useCallback } from 'react'
import { Pressable, PressableProps, StyleProp, ViewStyle, GestureResponderEvent } from 'react-native'
import Animated, { useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated'
import { springs } from '@/context/theme/motion'
import { haptics, HapticName } from '@/hooks/useHaptics'

interface PressableScaleProps extends Omit<PressableProps, 'style'> {
  /** Style for the animated content view (Pressable itself stays unstyled). */
  style?: StyleProp<ViewStyle>
  haptic?: HapticName
  scaleTo?: number
  children?: React.ReactNode
}

export default function PressableScale({
  style,
  haptic,
  scaleTo = 0.97,
  onPressIn,
  onPressOut,
  onPress,
  children,
  ...rest
}: PressableScaleProps) {
  const pressed = useSharedValue(0)

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - (1 - scaleTo) * pressed.value }],
    opacity: 1 - 0.15 * pressed.value,
  }))

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
    <Pressable
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onPress={handlePress}
      accessibilityRole="button"
      {...rest}
    >
      <Animated.View style={[style, animatedStyle]}>{children}</Animated.View>
    </Pressable>
  )
}
