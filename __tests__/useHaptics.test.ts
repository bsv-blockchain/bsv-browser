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

  describe('iOS', () => {
    beforeEach(() => { Platform.OS = 'ios' })
    afterEach(() => { Platform.OS = 'ios' })

    it('maps semantics to the iOS APIs from the spec', () => {
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
  })

  describe('Android', () => {
    beforeEach(() => { Platform.OS = 'android' })
    afterEach(() => { Platform.OS = 'ios' })

    it('no-ops tap/confirm on android', () => {
      haptics.tap()
      haptics.confirm()
      expect(Haptics.selectionAsync).not.toHaveBeenCalled()
      expect(Haptics.impactAsync).not.toHaveBeenCalled()
    })

    it('success/warning/error still call notificationAsync on android', () => {
      haptics.success()
      expect(Haptics.notificationAsync).toHaveBeenCalledWith('success')
      haptics.warning()
      expect(Haptics.notificationAsync).toHaveBeenCalledWith('warning')
      haptics.error()
      expect(Haptics.notificationAsync).toHaveBeenCalledWith('error')
      expect(Haptics.selectionAsync).not.toHaveBeenCalled()
      expect(Haptics.impactAsync).not.toHaveBeenCalled()
    })
  })
})
