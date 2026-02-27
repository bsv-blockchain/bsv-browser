import React, { memo, useEffect } from 'react'
import { Dimensions, Pressable, StyleSheet, Text, View } from 'react-native'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  runOnJS,
} from 'react-native-reanimated'
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler'
import { useTheme } from '@/context/theme/ThemeContext'
import { radii, spacing, typography } from '@/context/theme/tokens'

interface SheetProps {
  visible: boolean
  onClose: () => void
  title?: string
  heightPercent?: number
  children?: React.ReactNode
}

/**
 * Unified bottom sheet.
 * Uses Reanimated 4 + Gesture v2 so the swipe-to-close spring
 * is never interrupted by a stale Animated.event reset.
 */
const Sheet: React.FC<SheetProps> = ({
  visible,
  onClose,
  title,
  heightPercent = 0.75,
  children,
}) => {
  const { colors } = useTheme()
  const { height: windowHeight } = Dimensions.get('window')
  const sheetHeight = Math.max(0, Math.min(1, heightPercent)) * windowHeight

  // 0 = fully open, sheetHeight = fully hidden (below screen)
  const translateY = useSharedValue(sheetHeight)
  // Track whether the sheet is visible for rendering children
  const [rendered, setRendered] = React.useState(false)

  // Open / close driven by `visible` prop
  useEffect(() => {
    if (visible) {
      setRendered(true)
      translateY.value = sheetHeight
      translateY.value = withSpring(0, { mass: 1, stiffness: 280, damping: 32 })
    } else {
      translateY.value = withSpring(
        sheetHeight,
        { mass: 1, stiffness: 400, damping: 38 },
        (finished) => {
          if (finished) runOnJS(setRendered)(false)
        }
      )
    }
  }, [visible]) // eslint-disable-line react-hooks/exhaustive-deps

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }))

  const panGesture = Gesture.Pan()
    .activeOffsetY(10)
    .failOffsetX([-25, 25])
    .onUpdate((e) => {
      translateY.value = Math.max(0, e.translationY)
    })
    .onEnd((e) => {
      const shouldClose =
        e.translationY > sheetHeight / 3 || e.velocityY > 800
      if (shouldClose) {
        translateY.value = withSpring(
          sheetHeight,
          {
            mass: 1,
            stiffness: 400,
            damping: 38,
            velocity: e.velocityY,
          },
          () => runOnJS(onClose)()
        )
      } else {
        translateY.value = withSpring(0, { mass: 1, stiffness: 400, damping: 38 })
      }
    })

  const isVisible = visible || rendered

  // Don't mount while hidden — RNGH registers native gesture recognizers
  // at the OS level regardless of pointerEvents, which would silently block
  // touches on the content underneath (especially at the top of the screen).
  if (!isVisible) return null

  return (
    <GestureHandlerRootView
      style={[StyleSheet.absoluteFill, { zIndex: 50 }]}
    >
      {isVisible && (
        <Pressable style={styles.backdrop} onPress={onClose} />
      )}
      <Animated.View
        style={[
          styles.sheet,
          {
            backgroundColor: colors.backgroundSecondary,
            maxHeight: sheetHeight,
          },
          animatedStyle,
        ]}
      >
        {/* Draggable handle area */}
        <GestureDetector gesture={panGesture}>
          <View style={styles.handleArea}>
            <View style={[styles.handleBar, { backgroundColor: colors.fillSecondary }]} />
          </View>
        </GestureDetector>

        {title && (
          <View style={[styles.titleRow, { borderBottomColor: colors.separator }]}>
            <Text style={[styles.titleText, { color: colors.textPrimary }]}>{title}</Text>
          </View>
        )}

        <View style={{ flex: 1 }}>{rendered ? children : null}</View>
      </Animated.View>
    </GestureHandlerRootView>
  )
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    overflow: 'hidden',
    zIndex: 20,
    elevation: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.15,
    shadowRadius: 10,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
    zIndex: 10,
  },
  handleArea: {
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  handleBar: {
    width: 36,
    height: 5,
    borderRadius: 2.5,
  },
  titleRow: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  titleText: {
    ...typography.headline,
  },
})

export default memo(Sheet)
