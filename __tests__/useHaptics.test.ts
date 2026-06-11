jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}))

import * as Haptics from 'expo-haptics'
import { Platform } from 'react-native'
import { haptics } from '@/hooks/useHaptics'

describe('haptic vocabulary', () => {
  beforeEach(() => jest.clearAllMocks())

  it('maps semantics to the iOS APIs from the spec', () => {
    Platform.OS = 'ios'
    haptics.tap()
    expect(Haptics.selectionAsync).toHaveBeenCalled()
    haptics.confirm()
    expect(Haptics.impactAsync).toHaveBeenCalledWith('light')
    haptics.success()
    expect(Haptics.notificationAsync).toHaveBeenCalledWith('success')
    haptics.warning()
    expect(Haptics.notificationAsync).toHaveBeenCalledWith('warning')
    haptics.error()
    expect(Haptics.notificationAsync).toHaveBeenCalledWith('error')
  })

  it('no-ops tap/confirm on android', () => {
    Platform.OS = 'android'
    haptics.tap()
    haptics.confirm()
    expect(Haptics.selectionAsync).not.toHaveBeenCalled()
    expect(Haptics.impactAsync).not.toHaveBeenCalled()
    Platform.OS = 'ios'
  })
})
