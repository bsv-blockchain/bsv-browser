/**
 * Render-level coverage for the Pay screen. The point is not the pixels: it is
 * that the grid renders both directions, that a cell opens, and that a deep
 * link preselects one — the three things a broken route would silently lose.
 *
 * Mocking follows the convention __tests__/PresenceRow.test.tsx and
 * __tests__/Toast.test.tsx establish: expo-haptics, @expo/vector-icons and
 * react-native-safe-area-context are stubbed (none of them survive
 * transformIgnorePatterns / the test renderer), while the REAL ThemeProvider
 * wraps the tree so the screen reads real tokens. On top of that, this screen
 * also reads i18n and the wallet, so react-i18next resolves `t` to the key
 * itself — which is what the assertions below match on — and WalletContext is
 * reduced to the two fields the screen consumes. The six cell components are
 * mocked to host-component names so the assertions can look for a cell by type
 * without dragging a camera, a MessageBox client or a QR renderer into a unit
 * test.
 */
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}))

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }))

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}))

// `t` returns the key, so every assertion below names the key it depends on.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

jest.mock('@/context/WalletContext', () => ({
  useWallet: () => ({ walletBuilding: false, walletBuilt: true }),
}))

const mockParams: Record<string, string> = {}
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => mockParams,
  useFocusEffect: () => {}
}))

jest.mock('@/components/pay/NearbyFlow', () => 'NearbyFlow')
jest.mock('@/components/pay/HandleSend', () => 'HandleSend')
jest.mock('@/components/pay/HandleReceive', () => 'HandleReceive')
jest.mock('@/components/pay/AddressSend', () => 'AddressSend')
jest.mock('@/components/pay/AddressReceive', () => 'AddressReceive')

import React from 'react'
import { render } from '@testing-library/react-native'
import PayScreen from '@/app/pay'
import { ThemeProvider } from '@/context/theme/ThemeContext'

// Lowercase hex: validatePeerPayURI's compressed-key regex is case-sensitive,
// so an uppercase key is rejected as malformed.
const KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

const draw = () => render(<ThemeProvider><PayScreen /></ThemeProvider>)

describe('PayScreen', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockParams)) delete mockParams[k]
  })

  it('renders the three counterparty rows for the Pay direction', () => {
    const { getByText } = draw()
    expect(getByText('pay_cell_nearby_pay')).toBeTruthy()
    expect(getByText('pay_cell_handle_pay')).toBeTruthy()
    expect(getByText('pay_cell_address_pay')).toBeTruthy()
  })

  it('opens the handle cell when a deep link names it', () => {
    mockParams.cell = 'pay-handle'
    const { UNSAFE_getByType } = draw()
    expect(UNSAFE_getByType('HandleSend' as never)).toBeTruthy()
  })

  it('opens the handle cell for a peerpay link and forwards the key', () => {
    mockParams.peerpay = `peerpay:${KEY}?sats=1000`
    const { UNSAFE_getByType } = draw()
    const cell = UNSAFE_getByType('HandleSend' as never)
    expect(cell.props.initialIdentityKey).toBe(KEY)
    expect(cell.props.initialSats).toBe(1000)
  })

  it('opens the nearby payee cell for the get-nearby link', () => {
    mockParams.cell = 'get-nearby'
    const { UNSAFE_getByType } = draw()
    expect(UNSAFE_getByType('NearbyFlow' as never).props.role).toBe('payee')
  })

  it('ignores an unknown cell param and shows the grid', () => {
    mockParams.cell = 'nonsense'
    const { getByText } = draw()
    expect(getByText('pay_cell_nearby_pay')).toBeTruthy()
  })
})
