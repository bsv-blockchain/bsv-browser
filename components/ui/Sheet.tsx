import React, { memo, useCallback, useEffect, useRef, useState, useMemo } from 'react'
import { Animated, Dimensions, Pressable, StyleSheet, Text, View } from 'react-native'
import { PanGestureHandler, State as GestureState } from 'react-native-gesture-handler'
import { useTheme } from '@/context/theme/ThemeContext'
import { radii, spacing, typography } from '@/context/theme/tokens'

interface SheetProps {
  visible: boolean
  onClose: () => void
  title?: string
  heightPercent?: number
  children?: React.ReactNode
}

const CLOSE_TIMEOUT_MS = 300
const BACKDROP_LINGER_MS = 60

/**
 * Unified bottom sheet with Safari-style appearance.
 * Uses theme colors for background, handle bar, and optional title.
 */
const Sheet: React.FC<SheetProps> = ({
  visible,
  onClose,
  title,
  heightPercent = 0.75,
  children
}) => {
  const { colors, isDark } = useTheme()
  const windowHeight = Dimensions.get('window').height
  const sheetHeight = Math.max(0, Math.min(1, heightPercent)) * windowHeight
  const topOffset = windowHeight - sheetHeight

  const translateY = useRef(new Animated.Value(sheetHeight)).current
  const [isAnimating, setIsAnimating] = useState(false)
  const closingRef = useRef(false)
  const skipEffectCloseRef = useRef(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wasVisibleRef = useRef(false)

  const containerStyle = useMemo(
    () => [
      styles.sheet,
      {
        backgroundColor: colors.backgroundElevated,
        height: sheetHeight,
        top: topOffset,
        transform: [{ translateY }]
      }
    ],
    [colors.backgroundElevated, sheetHeight, topOffset, translateY]
  )

  useEffect(() => {
    if (visible) {
      setIsAnimating(true)
      translateY.setValue(sheetHeight)
      Animated.spring(translateY, {
        toValue: 0,
        useNativeDriver: true,
        tension: 40,
        friction: 8
      }).start(() => setIsAnimating(false))
    } else if (wasVisibleRef.current) {
      if (!skipEffectCloseRef.current) {
        setIsAnimating(true)
        Animated.spring(translateY, {
          toValue: sheetHeight,
          useNativeDriver: true,
          tension: 100,
          friction: 8
        }).start()
        if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
        closeTimerRef.current = setTimeout(() => {
          setIsAnimating(false)
        }, CLOSE_TIMEOUT_MS + BACKDROP_LINGER_MS)
      } else {
        skipEffectCloseRef.current = false
        translateY.setValue(sheetHeight)
      }
    } else {
      translateY.setValue(sheetHeight)
      setIsAnimating(false)
    }
    wasVisibleRef.current = visible
  }, [visible, sheetHeight, translateY])

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    }
  }, [])

  const onPanGestureEvent = useRef(
    Animated.event([{ nativeEvent: { translationY: translateY } }], {
      useNativeDriver: true
    })
  ).current

  const requestClose = useCallback(
    (velocityY?: number) => {
      if (closingRef.current) return
      closingRef.current = true
      skipEffectCloseRef.current = true
      setIsAnimating(true)
      Animated.spring(translateY, {
        toValue: sheetHeight,
        useNativeDriver: true,
        tension: 100,
        friction: 8,
        velocity: (velocityY || 0) / 500
      }).start()
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
      closeTimerRef.current = setTimeout(() => {
        onClose()
        setIsAnimating(false)
        closingRef.current = false
      }, CLOSE_TIMEOUT_MS + BACKDROP_LINGER_MS)
    },
    [onClose, sheetHeight, translateY]
  )

  const onPanHandlerStateChange = useCallback(
    (event: any) => {
      if (event.nativeEvent.oldState === GestureState.ACTIVE) {
        const { translationY, velocityY } = event.nativeEvent
        const shouldClose = translationY > sheetHeight / 3 || velocityY > 800
        if (shouldClose) {
          requestClose(velocityY)
        } else {
          setIsAnimating(true)
          Animated.spring(translateY, {
            toValue: 0,
            useNativeDriver: true,
            tension: 100,
            friction: 8
          }).start(() => setIsAnimating(false))
        }
      }
    },
    [requestClose, sheetHeight, translateY]
  )

  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents={visible || isAnimating ? 'auto' : 'none'}
    >
      {(visible || isAnimating) && (
        <Pressable
          style={styles.backdrop}
          onPress={() => requestClose()}
        />
      )}
      <Animated.View style={containerStyle}>
        <PanGestureHandler
          onGestureEvent={onPanGestureEvent}
          onHandlerStateChange={onPanHandlerStateChange}
          activeOffsetY={10}
          failOffsetX={[-20, 20]}
        >
          <Animated.View style={styles.handleArea}>
            <View style={[styles.handleBar, { backgroundColor: colors.fillSecondary }]} />
          </Animated.View>
        </PanGestureHandler>
        {title && (
          <View style={[styles.titleRow, { borderBottomColor: colors.separator }]}>
            <Text style={[styles.titleText, { color: colors.textPrimary }]}>{title}</Text>
          </View>
        )}
        <View style={{ flex: 1 }}>{visible || isAnimating ? children : null}</View>
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
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
