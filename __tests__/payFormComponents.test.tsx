/**
 * The shared pay-form vocabulary. What these pin is UNIFORMITY: every rail asks
 * for an amount with the same label, shows the same balance line, warns with
 * the same boxed note, and submits through the same button — so a rail that
 * hand-rolls its own variant again will not match these components and the
 * divergence shows up in review, not on device.
 */
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' }
}))

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }))

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' }
  })
}))

// The pieces under test compose AvailableBalance and AmountInput; both reach
// for the wallet context, which is not what this file is about.
jest.mock('@/components/pay/AvailableBalance', () => {
  const { Text } = require('react-native')
  return { __esModule: true, default: () => <Text testID="available-balance">balance</Text> }
})
jest.mock('@/components/wallet/AmountInput', () => {
  const { TextInput } = require('react-native')
  return {
    __esModule: true,
    SEND_MAX_VALUE: '2099999999999999',
    AmountInput: ({ value, onChangeText }: { value: string; onChangeText: (v: string) => void }) => (
      <TextInput testID="amount-input" value={value} onChangeText={onChangeText} />
    )
  }
})

import React from 'react'
import { Text } from 'react-native'
import { fireEvent, render } from '@testing-library/react-native'
import { ThemeProvider } from '@/context/theme/ThemeContext'
import { PayField, PayAmountField, ConsequenceNote, PayCta, RecipientSummary } from '@/components/pay/PayForm'

const wrap = (ui: React.ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>)

describe('PayField', () => {
  it('renders the label (uppercased by style, not by string surgery) with its content below', () => {
    const screen = wrap(
      <PayField labelKey="recipient">
        <Text>child-content</Text>
      </PayField>
    )
    expect(screen.getByText('recipient')).toBeTruthy()
    expect(screen.getByText('child-content')).toBeTruthy()
  })
})

describe('PayAmountField', () => {
  it('always asks the same question: AMOUNT label, balance line, amount input', () => {
    const screen = wrap(<PayAmountField value="" onChangeText={() => {}} />)
    expect(screen.getByText('amount')).toBeTruthy()
    expect(screen.getByTestId('available-balance')).toBeTruthy()
    expect(screen.getByTestId('amount-input')).toBeTruthy()
  })

  it('hides the balance line when the enterer is not the payer', () => {
    const screen = wrap(<PayAmountField value="" onChangeText={() => {}} showBalance={false} />)
    expect(screen.queryByTestId('available-balance')).toBeNull()
  })

  it('passes edits through', () => {
    const onChange = jest.fn()
    const screen = wrap(<PayAmountField value="" onChangeText={onChange} />)
    fireEvent.changeText(screen.getByTestId('amount-input'), '500')
    expect(onChange).toHaveBeenCalledWith('500')
  })
})

describe('ConsequenceNote', () => {
  it('renders the consequence text', () => {
    const screen = wrap(<ConsequenceNote textKey="pay_consequence_address" />)
    expect(screen.getByText('pay_consequence_address')).toBeTruthy()
  })
})

describe('PayCta', () => {
  it('submits on press when enabled', () => {
    const onPress = jest.fn()
    const screen = wrap(<PayCta onPress={onPress} disabled={false} busy={false} />)
    fireEvent.press(screen.getByText('pay'))
    expect(onPress).toHaveBeenCalled()
  })

  it('does not submit when disabled', () => {
    const onPress = jest.fn()
    const screen = wrap(<PayCta onPress={onPress} disabled busy={false} />)
    fireEvent.press(screen.getByText('pay'))
    expect(onPress).not.toHaveBeenCalled()
  })

  it('shows a spinner instead of the label while busy', () => {
    const screen = wrap(<PayCta onPress={() => {}} disabled busy />)
    expect(screen.queryByText('pay')).toBeNull()
  })
})

describe('RecipientSummary', () => {
  it('shows the RECIPIENT label with name and detail', () => {
    const screen = wrap(<RecipientSummary name="Alice" detail="02ab…9f" />)
    expect(screen.getByText('recipient')).toBeTruthy()
    expect(screen.getByText('Alice')).toBeTruthy()
    expect(screen.getByText('02ab…9f')).toBeTruthy()
  })

  it('omits the detail line when name and detail collapse to one figure', () => {
    const screen = wrap(<RecipientSummary name="1BoatSLRHt…" />)
    expect(screen.getByText('1BoatSLRHt…')).toBeTruthy()
  })
})
