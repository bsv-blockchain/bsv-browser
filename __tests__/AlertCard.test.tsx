jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}))

import React from 'react'
import { render, fireEvent, act } from '@testing-library/react-native'
import { AlertHost, showAlert } from '@/components/ui/AlertCard'
import { ThemeProvider } from '@/context/theme/ThemeContext'

const host = () => render(<ThemeProvider><AlertHost /></ThemeProvider>)

describe('showAlert', () => {
  it('renders title/message and resolves pressed button key', async () => {
    const screen = host()
    let result!: Promise<string>
    act(() => {
      result = showAlert({
        title: 'Delete Certifier?',
        message: 'Apps will no longer resolve identities.',
        buttons: [
          { text: 'Cancel', style: 'cancel', key: 'cancel' },
          { text: 'Delete', style: 'destructive', key: 'delete' },
        ],
      })
    })
    expect(screen.getByText('Delete Certifier?')).toBeTruthy()
    expect(screen.getByText('Apps will no longer resolve identities.')).toBeTruthy()
    fireEvent.press(screen.getByText('Delete'))
    await expect(result).resolves.toBe('delete')
  })

  it('defaults to a single OK button resolving "ok"', async () => {
    const screen = host()
    let result!: Promise<string>
    act(() => { result = showAlert({ title: 'Heads up' }) })
    fireEvent.press(screen.getByText('OK'))
    await expect(result).resolves.toBe('ok')
  })
})
