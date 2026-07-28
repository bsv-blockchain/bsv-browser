/**
 * The receipt's one load-bearing property: it does not go away by itself.
 *
 * A toast was the previous treatment and it can be missed entirely — phone face
 * down, in a pocket, not being looked at when it fires. This overlay exists so
 * that "did the money arrive?" is never a question, which only holds if nothing
 * but an explicit acknowledgement can close it. That is what these tests pin.
 *
 * Mocking follows __tests__/payScreen.test.tsx: haptics and i18n stubbed, `t`
 * resolving to the key so assertions name what they depend on. Celebration is
 * mocked to a host component that reports its mark landing on demand, so the
 * staged reveal can be driven without waiting on real animation timing.
 */
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' }
}))

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) => (opts?.count ? `${key}:${opts.count}` : key),
    i18n: { language: 'en' }
  })
}))

// The amount is rendered by AmountDisplay, which reaches for wallet settings and
// an exchange rate. Neither is what this file is about, so it becomes plain text.
jest.mock('@/components/wallet/AmountDisplay', () => {
  const { Text } = require('react-native')
  return {
    __esModule: true,
    default: ({ children }: { children: number }) => <Text>{`sats:${children}`}</Text>
  }
})

let mockMarkDone: (() => void) | undefined
jest.mock('@/components/ui/Celebration', () => {
  const { View } = require('react-native')
  return {
    __esModule: true,
    default: ({ onDone }: { onDone?: () => void }) => {
      mockMarkDone = onDone
      return <View testID="celebration" />
    }
  }
})

const mockConfirmation = jest.fn()
jest.mock('@/hooks/useConfirmationSound', () => ({
  sounds: { confirmation: () => mockConfirmation(), release: jest.fn() }
}))

import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { ThemeProvider } from '@/context/theme/ThemeContext'
import ReceivedOverlay from '@/components/pay/ReceivedOverlay'

function draw(props: { amount: number; count?: number; onDismiss: () => void }) {
  return render(
    <ThemeProvider>
      <ReceivedOverlay {...props} />
    </ThemeProvider>
  )
}

beforeEach(() => {
  mockMarkDone = undefined
  mockConfirmation.mockClear()
})

describe('ReceivedOverlay', () => {
  it('states that a payment was received, and shows the figure', () => {
    draw({ amount: 5000, onDismiss: jest.fn() })
    expect(screen.getByText('local_pay_received')).toBeTruthy()
    expect(screen.getByText('sats:5000')).toBeTruthy()
  })

  it('says the money is in the wallet, not merely that something happened', () => {
    draw({ amount: 5000, onDismiss: jest.fn() })
    expect(screen.getByText('local_pay_added')).toBeTruthy()
  })

  it('names the count when one event credited several payments', () => {
    draw({ amount: 9000, count: 3, onDismiss: jest.fn() })
    expect(screen.getByText('local_pay_added_multiple:3')).toBeTruthy()
  })

  it('never dismisses itself — not on mount, not after the mark lands', () => {
    const onDismiss = jest.fn()
    draw({ amount: 5000, onDismiss })
    expect(onDismiss).not.toHaveBeenCalled()
    act(() => {
      mockMarkDone?.()
    })
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('withholds the acknowledgement until the mark has landed', () => {
    draw({ amount: 5000, onDismiss: jest.fn() })
    // Nothing is pending — this is staging, so the button does not appear during
    // the beat that exists to deliver the news.
    expect(screen.queryByLabelText('done')).toBeNull()
    act(() => {
      mockMarkDone?.()
    })
    expect(screen.getByLabelText('done')).toBeTruthy()
  })

  it('dismisses only when acknowledged', () => {
    const onDismiss = jest.fn()
    draw({ amount: 5000, onDismiss })
    act(() => {
      mockMarkDone?.()
    })
    fireEvent.press(screen.getByLabelText('done'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('sounds the confirmation tone', () => {
    jest.useFakeTimers()
    try {
      draw({ amount: 5000, onDismiss: jest.fn() })
      act(() => {
        jest.advanceTimersByTime(500)
      })
      expect(mockConfirmation).toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })
})
