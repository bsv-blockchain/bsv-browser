import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Animated, Dimensions, Pressable, StyleSheet, View } from 'react-native'
import { PanGestureHandler, State as GestureState } from 'react-native-gesture-handler'

interface BottomDrawerProps {
  visible: boolean
  onClose: () => void
  heightPercent?: number
  backgroundColor?: string
  backdropOpacity?: number
  closeInstantly?: boolean
  backdropLingerMs?: number
  children?: React.ReactNode
}

const BottomDrawer: React.FC<BottomDrawerProps> = ({
  visible,
  onClose,
  heightPercent = 0.75,
  backgroundColor = '#fff',
  backdropOpacity = 0.7,
  closeInstantly = false,
  backdropLingerMs = 60,
  children
}) => {
  const CLOSE_TIMEOUT_MS = 300
  const windowHeight = Dimensions.get('window').height
  const sheetHeight = Math.max(0, Math.min(1, heightPercent)) * windowHeight
  const topOffset = windowHeight - sheetHeight

  const translateY = useRef(new Animated.Value(sheetHeight)).current
  const [isAnimating, setIsAnimating] = useState(false)
  const closingRef = useRef(false)
  const skipEffectCloseRef = useRef(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const containerStyle = useMemo(
    () => [
      styles.sheet,
      {
        backgroundColor,
        height: sheetHeight,
        top: topOffset,
        transform: [{ translateY }]
      }
    ],
    [backgroundColor, sheetHeight, topOffset, translateY]
  )

  const wasVisibleRef = useRef(false)

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
    } else {
      if (wasVisibleRef.current) {
        if (closeInstantly) {
          skipEffectCloseRef.current = false
          translateY.setValue(sheetHeight)
          setIsAnimating(false)
        } else if (!skipEffectCloseRef.current) {
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
          }, CLOSE_TIMEOUT_MS + backdropLingerMs)
        } else {
          skipEffectCloseRef.current = false
          translateY.setValue(sheetHeight)
        }
      } else {
        translateY.setValue(sheetHeight)
        setIsAnimating(false)
      }
    }
    wasVisibleRef.current = visible
  }, [visible, sheetHeight, translateY, closeInstantly, backdropLingerMs])

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
      }, CLOSE_TIMEOUT_MS + backdropLingerMs)
    },
    [onClose, sheetHeight, translateY, backdropLingerMs]
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
          style={[styles.backdrop, { backgroundColor: `rgba(0,0,0,${backdropOpacity})` }]}
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
            <View style={styles.handleBar} />
          </Animated.View>
        </PanGestureHandler>
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
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    overflow: 'hidden',
    zIndex: 20,
    elevation: 12
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'black',
    zIndex: 10
  },
  handleArea: {
    height: 40,
    alignItems: 'center',
    justifyContent: 'center'
  },
  handleBar: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#999'
  }
})

export default memo(BottomDrawer)
