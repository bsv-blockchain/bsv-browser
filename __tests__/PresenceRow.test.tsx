jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}))

// @expo/vector-icons reaches expo-font, which this repo's transformIgnorePatterns
// does not transform. Stubbed the same way Celebration.test.tsx stubs react-native-svg.
jest.mock('@expo/vector-icons', () => {
  const React = require('react')
  const { View } = require('react-native')
  return { Ionicons: (props: object) => React.createElement(View, props) }
})

import React from 'react'
import { render } from '@testing-library/react-native'
import PresenceRow, { type PresenceState } from '@/components/localpay/PresenceRow'
import { ThemeProvider } from '@/context/theme/ThemeContext'
import { lightColors } from '@/context/theme/tokens'

const draw = (state: PresenceState, label = 'status', peer?: string | null) =>
  render(
    <ThemeProvider>
      <PresenceRow state={state} label={label} peer={peer} />
    </ThemeProvider>
  )

const ALL: PresenceState[] = ['qr', 'ready', 'waiting', 'linked', 'paid']

describe('PresenceRow', () => {
  it('renders every state without crashing', () => {
    ALL.forEach(s => expect(() => draw(s)).not.toThrow())
  })

  it('shows the label it is given', () => {
    const { getByText } = draw('waiting', 'Waiting for a nearby device')
    expect(getByText('Waiting for a nearby device')).toBeTruthy()
  })

  it('shows the peer name when identity resolved', () => {
    const { getByText } = draw('linked', 'Encrypted link open', 'Alice')
    expect(getByText('Alice')).toBeTruthy()
  })

  it('shows no name when identity did not resolve', () => {
    const { queryByText } = draw('linked', 'Encrypted link open', null)
    expect(queryByText('·')).toBeNull()
  })

  it('announces label and peer as one string', () => {
    const { getByLabelText } = draw('paid', 'Payment confirmed', 'Alice')
    expect(getByLabelText('Payment confirmed. Alice')).toBeTruthy()
  })

  // ── The colour reservation ──
  //
  // Green on this screen means confirmed money. If it ever leaks onto a state
  // that is merely optimistic — "linked", "ready" — then green stops meaning
  // anything and the success moment stops landing.
  it('uses the success accent on `paid` and on nothing else', () => {
    const green = (state: PresenceState) => {
      const { getByText } = draw(state, 'x')
      const style = getByText('x').props.style.flat()
      return style.some((s: { color?: string } | undefined) => s?.color === lightColors.success)
    }
    expect(green('paid')).toBe(true)
    ALL.filter(s => s !== 'paid').forEach(s => expect(green(s)).toBe(false))
  })

  // The QR hand-off has no live link. It must never borrow the emphasis the
  // proven-peer states get, or it would read as a connection that is not there.
  it('keeps the no-link state visually demoted', () => {
    // Later entries win in an RN style array, so fold rather than find.
    const weightOf = (state: PresenceState) => {
      const { getByText } = draw(state, 'x')
      return getByText('x')
        .props.style.flat()
        .reduce(
          (acc: string | undefined, s: { fontWeight?: string } | undefined) => s?.fontWeight ?? acc,
          undefined
        )
    }
    expect(weightOf('linked')).toBe('600')
    expect(weightOf('paid')).toBe('600')
    expect(weightOf('qr')).toBe('400')
    expect(weightOf('ready')).toBe('400')
    expect(weightOf('waiting')).toBe('400')
  })
})
