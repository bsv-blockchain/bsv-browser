import React, { useRef } from 'react'
import { Animated, PanResponder, Text, StyleSheet } from 'react-native'

type SwipeableTabProps = {
  tab: string
  index: number
  removeTab: (index: number) => void
}

const SwipeableTab: React.FC<SwipeableTabProps> = ({ tab, index, removeTab }) => {
  const translateX = useRef(new Animated.Value(0)).current

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gestureState) => {
        return Math.abs(gestureState.dx) > 20
      },
      onPanResponderMove: (_, gestureState) => {
        translateX.setValue(gestureState.dx)
      },
      onPanResponderRelease: (_, gestureState) => {
        if (gestureState.dx < -120) {
          Animated.timing(translateX, {
            toValue: -400,
            duration: 200,
            useNativeDriver: true
          }).start(() => removeTab(index))
        } else {
          Animated.spring(translateX, {
            toValue: 0,
            useNativeDriver: true
          }).start()
        }
      }
    })
  ).current

  return (
    <Animated.View style={[styles.tab, { transform: [{ translateX }] }]} {...panResponder.panHandlers}>
      <Text style={styles.tabText}>{tab}</Text>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  tab: {
    backgroundColor: '#333',
    padding: 16,
    marginVertical: 6,
    marginHorizontal: 12,
    borderRadius: 10
  },
  tabText: {
    color: '#fff',
    fontSize: 16
  }
})

export default SwipeableTab
