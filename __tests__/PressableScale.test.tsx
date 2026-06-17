jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}))

import React from 'react'
import { Text } from 'react-native'
import { render, fireEvent } from '@testing-library/react-native'
import * as Haptics from 'expo-haptics'
import PressableScale from '@/components/ui/PressableScale'

describe('PressableScale', () => {
  it('renders children and fires onPress', () => {
    const onPress = jest.fn()
    const { getByText } = render(
      <PressableScale onPress={onPress} accessibilityLabel="go">
        <Text>Go</Text>
      </PressableScale>
    )
    fireEvent.press(getByText('Go'))
    expect(onPress).toHaveBeenCalled()
  })

  it('disabled blocks onPress', () => {
    const onPress = jest.fn()
    const { getByText } = render(
      <PressableScale onPress={onPress} disabled accessibilityLabel="go">
        <Text>Go</Text>
      </PressableScale>
    )
    fireEvent.press(getByText('Go'))
    expect(onPress).not.toHaveBeenCalled()
  })

  it('haptic="confirm" calls impactAsync on press', () => {
    const { getByText } = render(
      <PressableScale haptic="confirm" accessibilityLabel="go">
        <Text>Go</Text>
      </PressableScale>
    )
    fireEvent.press(getByText('Go'))
    expect(Haptics.impactAsync).toHaveBeenCalled()
  })

  it('onPressIn/onPressOut chain to user handlers', () => {
    const onPressIn = jest.fn()
    const onPressOut = jest.fn()
    const { getByText } = render(
      <PressableScale onPressIn={onPressIn} onPressOut={onPressOut} accessibilityLabel="go">
        <Text>Go</Text>
      </PressableScale>
    )
    fireEvent(getByText('Go'), 'pressIn')
    expect(onPressIn).toHaveBeenCalled()
    fireEvent(getByText('Go'), 'pressOut')
    expect(onPressOut).toHaveBeenCalled()
  })

  it('does not override caller opacity when animateOpacity is false (default)', () => {
    // The reanimated mock runs useAnimatedStyle's worklet immediately with
    // pressed.value === 0 (initial shared value). When animateOpacity is false
    // (the default), the worklet must NOT emit an opacity key — so that the
    // caller-provided opacity (e.g. 0.3 for a disabled IconButton) is not
    // overridden by a pinned opacity:1.
    //
    // We verify this by inspecting the style array on the root element's props.
    // The AnimatedPressable receives style=[callerStyle, animatedStyle] — the
    // animatedStyle object must have no `opacity` key.
    const { getByTestId } = render(
      <PressableScale
        testID="ps"
        style={{ opacity: 0.3 }}
        accessibilityLabel="go"
      >
        <Text>Go</Text>
      </PressableScale>
    )
    const element = getByTestId('ps')
    // The style prop is an array [callerStyle, animatedStyle].
    // Flatten it to check the combined result.
    const styleArray: any[] = [].concat(element.props.style ?? [])
    // animatedStyle is the last entry (added by PressableScale after callerStyle)
    const animatedStyle = styleArray[styleArray.length - 1]
    expect(animatedStyle).not.toHaveProperty('opacity')
    // The caller style must still carry opacity: 0.3
    const callerStyle = styleArray.find(
      (s: any) => s && typeof s === 'object' && 'opacity' in s
    )
    expect(callerStyle?.opacity).toBe(0.3)
  })

  it('emits opacity in animatedStyle when animateOpacity=true', () => {
    // When animateOpacity is true and not pressed (pressed.value === 0),
    // opacity should be 1 (1 - 0.15 * 0 = 1).
    const { getByTestId } = render(
      <PressableScale
        testID="ps2"
        animateOpacity
        accessibilityLabel="go"
      >
        <Text>Go</Text>
      </PressableScale>
    )
    const element = getByTestId('ps2')
    const styleArray: any[] = [].concat(element.props.style ?? [])
    const animatedStyle = styleArray[styleArray.length - 1]
    expect(animatedStyle).toHaveProperty('opacity', 1)
  })
})
