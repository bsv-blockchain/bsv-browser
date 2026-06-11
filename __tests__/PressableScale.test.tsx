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
})
