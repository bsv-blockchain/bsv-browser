import React from 'react'
import { render } from '@testing-library/react-native'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
} from 'react-native-reanimated'

function AnimatedBox() {
  const opacity = useSharedValue(1)
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }))
  return <Animated.View testID="animated-box" style={animatedStyle} />
}

describe('reanimated sanity', () => {
  it('renders an Animated.View with useSharedValue + useAnimatedStyle', () => {
    const { getByTestId } = render(<AnimatedBox />)
    expect(getByTestId('animated-box')).toBeOnTheScreen()
  })
})
