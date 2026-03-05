import React, { memo, useEffect } from 'react'
import { Dimensions, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import Animated, { useSharedValue, useAnimatedStyle, withSpring, runOnJS } from 'react-native-reanimated'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@/context/theme/ThemeContext'
import { radii, spacing, typography } from '@/context/theme/tokens'

interface SheetProps {
  visible: boolean
  onClose: () => void
  title?: string
  onBack?: () => void
  heightPercent?: number
  fullPage?: boolean
  children?: React.ReactNode
}

/**
 * Unified bottom sheet.
 * Uses Reanimated 4 + Gesture v2 so the swipe-to-close spring
 * is never interrupted by a stale Animated.event reset.
 *
 * When `fullPage` is true the sheet covers the entire screen with a
 * Transactions-style navigation header (safe-area aware, hairline separator,
 * no drag handle, no backdrop dimming).
 */
const Sheet: React.FC<SheetProps> = ({
  visible,
  onClose,
  title,
  onBack,
  heightPercent = 0.75,
  fullPage = false,
  children
}) => {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { height: windowHeight } = Dimensions.get('window')
  const sheetHeight = fullPage ? windowHeight : Math.max(0, Math.min(1, heightPercent)) * windowHeight

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
      translateY.value = withSpring(sheetHeight, { mass: 1, stiffness: 400, damping: 38 }, finished => {
        if (finished) runOnJS(setRendered)(false)
      })
    }
  }, [visible]) // eslint-disable-line react-hooks/exhaustive-deps

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }]
  }))

  const panGesture = Gesture.Pan()
    .activeOffsetY(10)
    .failOffsetX([-25, 25])
    .onUpdate(e => {
      translateY.value = Math.max(0, e.translationY)
    })
    .onEnd(e => {
      const shouldClose = e.translationY > sheetHeight / 3 || e.velocityY > 800
      if (shouldClose) {
        translateY.value = withSpring(
          sheetHeight,
          {
            mass: 1,
            stiffness: 400,
            damping: 38,
            velocity: e.velocityY
          },
          () => runOnJS(onClose)()
        )
      } else {
        translateY.value = withSpring(0, { mass: 1, stiffness: 400, damping: 38 })
      }
    })

  const isVisible = visible || rendered

  if (!isVisible) return null

  /* ------------------------------------------------------------------ */
  /* Full-page mode — matches the Transactions screen style              */
  /* ------------------------------------------------------------------ */
  if (fullPage) {
    return (
      <Animated.View
        style={[
          styles.fullPageSheet,
          {
            backgroundColor: colors.backgroundSecondary,
            height: sheetHeight,
            paddingTop: insets.top
          },
          animatedStyle
        ]}
      >
        {/* Header */}
        <View style={[styles.fullPageHeader, { borderBottomColor: colors.separator }]}>
          {onBack ? (
            <TouchableOpacity style={styles.fullPageBack} onPress={onBack} activeOpacity={0.6}>
              <Ionicons name="chevron-back" size={24} color={colors.accent} />
            </TouchableOpacity>
          ) : (
            <View style={styles.fullPageBack} />
          )}
          {title && (
            <Text style={[styles.fullPageTitle, { color: colors.textPrimary }]} numberOfLines={1}>
              {title}
            </Text>
          )}
          <View style={styles.fullPageBack} />
        </View>

        <View style={{ flex: 1 }}>{rendered ? children : null}</View>
      </Animated.View>
    )
  }

  /* ------------------------------------------------------------------ */
  /* Standard bottom-sheet mode                                          */
  /* ------------------------------------------------------------------ */
  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: 50 }]}>
      {isVisible && <Pressable style={styles.backdrop} onPress={onClose} />}
      <Animated.View
        style={[
          styles.sheet,
          {
            backgroundColor: colors.backgroundSecondary,
            height: sheetHeight
          },
          animatedStyle
        ]}
      >
        {/* Draggable handle + header */}
        <GestureDetector gesture={panGesture}>
          <View style={styles.handleArea}>
            <View style={[styles.handleBar, { backgroundColor: colors.fillSecondary }]} />
            {(title || onBack) && (
              <View style={styles.headerRow}>
                {onBack ? (
                  <TouchableOpacity style={styles.backButton} onPress={onBack} activeOpacity={0.6}>
                    <Ionicons name="chevron-back" size={22} color={colors.accent} />
                  </TouchableOpacity>
                ) : (
                  <View style={styles.backButton} />
                )}
                {title && (
                  <Text style={[styles.headerTitle, { color: colors.textPrimary }]} numberOfLines={1}>
                    {title}
                  </Text>
                )}
                <View style={styles.backButton} />
              </View>
            )}
          </View>
        </GestureDetector>

        <View style={{ flex: 1 }}>{rendered ? children : null}</View>
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  /* Full-page styles */
  fullPageSheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 50,
    elevation: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.15,
    shadowRadius: 10
  },
  fullPageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  fullPageBack: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center'
  },
  fullPageTitle: {
    ...typography.headline,
    flex: 1,
    textAlign: 'center'
  },

  /* Standard sheet styles */
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
    shadowRadius: 10
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
    zIndex: 10
  },
  handleArea: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: spacing.sm
  },
  handleBar: {
    width: 36,
    height: 5,
    borderRadius: 2.5
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    minHeight: 36
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 60
  },
  headerTitle: {
    ...typography.headline,
    flex: 1,
    textAlign: 'center'
  }
})

export default memo(Sheet)
