jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}))

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}))

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}))

import React from 'react'
import { render, act } from '@testing-library/react-native'
import { ToastHost, showToast } from '@/components/ui/Toast'
import { ThemeProvider } from '@/context/theme/ThemeContext'

jest.useFakeTimers()

describe('showToast', () => {
  it('renders message, newest wins, auto-dismisses after 2s', () => {
    const screen = render(<ThemeProvider><ToastHost /></ThemeProvider>)
    act(() => { showToast('Copied') })
    expect(screen.getByText('Copied')).toBeTruthy()
    act(() => { showToast('Exported', { type: 'success' }) })
    expect(screen.queryByText('Copied')).toBeNull()
    expect(screen.getByText('Exported')).toBeTruthy()
    act(() => { jest.advanceTimersByTime(2600) })
    expect(screen.queryByText('Exported')).toBeNull()
  })
})
