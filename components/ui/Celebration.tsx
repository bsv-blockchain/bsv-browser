/**
 * Celebration checkmark (spec Part 5) — used in EXACTLY three places:
 * first payment sent, wallet created, backup verified. Everything else uses
 * quiet feedback. Drawn check + success haptic; reduced motion = static check.
 */
import React, { useEffect } from 'react'
import { StyleSheet, View } from 'react-native'
import Svg, { Circle, Path } from 'react-native-svg'
import Animated, {
  useSharedValue,
  useAnimatedProps,
  useAnimatedStyle,
  withSpring,
  withTiming,
  withDelay,
  useReducedMotion,
} from 'react-native-reanimated'
import { useTheme } from '@/context/theme/ThemeContext'
import { springs } from '@/context/theme/motion'
import { haptics } from '@/hooks/useHaptics'

const AnimatedPath = Animated.createAnimatedComponent(Path)
// Path M26 45 L39 58 L62 32:
//   segment1 = sqrt(13²+13²) ≈ 18.4
//   segment2 = sqrt(23²+26²) ≈ 34.7
//   total    ≈ 53.1
// Using 54 (slightly over actual) so dasharray covers the full stroke;
// slightly-under (48) would leave a visible gap at the tip.
const CHECK_LENGTH = 54

interface CelebrationProps {
  size?: number
  /** Called ~700ms after mount, when the moment has landed. */
  onDone?: () => void
}

export default function Celebration({ size = 88, onDone }: CelebrationProps) {
  const { colors } = useTheme()
  const reducedMotion = useReducedMotion()
  const scale = useSharedValue(reducedMotion ? 1 : 0.6)
  const opacity = useSharedValue(reducedMotion ? 1 : 0)
  const draw = useSharedValue(reducedMotion ? 0 : CHECK_LENGTH)

  useEffect(() => {
    haptics.success()
    if (!reducedMotion) {
      scale.value = withSpring(1, springs.snappy)
      opacity.value = withTiming(1, { duration: 150 })
      draw.value = withDelay(120, withTiming(0, { duration: 320 }))
    }
    if (onDone) {
      const t = setTimeout(onDone, 700)
      return () => clearTimeout(t)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const circleStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }))
  const pathProps = useAnimatedProps(() => ({ strokeDashoffset: draw.value }))

  return (
    <View style={styles.center}>
      <Animated.View style={circleStyle}>
        <Svg width={size} height={size} viewBox="0 0 88 88">
          <Circle cx="44" cy="44" r="42" fill={colors.success} />
          <AnimatedPath
            d="M26 45 L39 58 L62 32"
            stroke="#FFFFFF"
            strokeWidth={6}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
            strokeDasharray={CHECK_LENGTH}
            animatedProps={pathProps}
          />
        </Svg>
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
})
