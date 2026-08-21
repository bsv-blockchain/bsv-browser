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
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' }
}))

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }))

// The re-show modal renders <QRCode> directly (unlike the six cell components
// below, which are mocked wholesale) — react-native-qrcode-svg ships ESM and
// isn't in this repo's transformIgnorePatterns, so it needs the same
// bare-string stub the icons package gets above.
jest.mock('react-native-qrcode-svg', () => 'QRCode')

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children
}))

// `t` returns the key, so every assertion below names the key it depends on.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } })
}))

// `storage` starts undefined: the queue effect below reads `storage?.sqliteDb`
// and returns early when it's absent, so most tests never touch the queue —
// only the ones that explicitly set mockStorage exercise it.
let mockStorage: { sqliteDb: unknown } | undefined
const mockRunMonitorTask = jest.fn().mockResolvedValue('')
jest.mock('@/context/WalletContext', () => ({
  useWallet: () => ({
    walletBuilding: false,
    walletBuilt: true,
    storage: mockStorage,
    txStatusVersion: 0,
    walletUserId: null,
    runMonitorTask: mockRunMonitorTask
  })
}))

// Without this, the real hook pulls in NetInfo, which has no native module
// under Jest and crashes the process with an unhandled rejection.
let mockOnline = true
jest.mock('@/hooks/useOnline', () => ({ useOnline: () => mockOnline }))

const mockParams: Record<string, string> = {}
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), navigate: jest.fn(), canGoBack: () => true },
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
import { resetProofNudgeForTests } from '@/utils/pay/proofNudge'
import type { OfflineActionRow } from '@/storage/methods/offlineActions'

// Lowercase hex: validatePeerPayURI's compressed-key regex is case-sensitive,
// so an uppercase key is rejected as malformed.
const KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

const draw = () =>
  render(
    <ThemeProvider>
      <PayScreen />
    </ThemeProvider>
  )

// A minimal OfflineActionRow, letting each test override only what it checks.
const offlineRow = (overrides: Partial<OfflineActionRow>): OfflineActionRow => ({
  offlineActionId: 1,
  created_at: '2026-07-28T00:00:00.000Z',
  updated_at: '2026-07-28T00:00:00.000Z',
  userId: 1,
  txid: 'a'.repeat(64),
  seq: 1,
  role: 'received',
  senderIdentityKey: null,
  receivedVia: null,
  status: 'queued',
  rejectedReason: null,
  poisonedByTxid: null,
  framePayload: null,
  ...overrides
})

describe('PayScreen', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockParams)) delete mockParams[k]
    mockOnline = true
    mockStorage = undefined
    resetProofNudgeForTests()
    mockRunMonitorTask.mockClear()
  })

  it('renders the three counterparty rows for the Pay direction', () => {
    const { getByText } = draw()
    expect(getByText('pay_cell_nearby_pay')).toBeTruthy()
    expect(getByText('pay_cell_handle_pay')).toBeTruthy()
    expect(getByText('pay_cell_address_pay')).toBeTruthy()
  })

  it('titles the screen with the direction it was opened in, with no switcher', () => {
    // The direction is chosen before arriving (Pay vs Get paid on the wallet
    // screen), so the title carries it and the old segmented switcher is gone —
    // re-offering the choice would ask a question the user just answered.
    const { getByText, queryByText } = draw()
    expect(getByText('pay_direction_pay')).toBeTruthy()
    expect(queryByText('pay_direction_receive')).toBeNull()
  })

  it('titles the screen Get paid and lists the receive rows for ?direction=get', () => {
    mockParams.direction = 'get'
    const { getByText, queryByText } = draw()
    expect(getByText('pay_direction_receive')).toBeTruthy()
    expect(queryByText('pay_direction_pay')).toBeNull()
    expect(getByText('pay_cell_nearby_get')).toBeTruthy()
    expect(getByText('pay_cell_handle_get')).toBeTruthy()
    expect(getByText('pay_cell_address_get')).toBeTruthy()
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

  it('disables the handle and address cells while offline, leaving nearby alone', () => {
    mockOnline = false
    const { getByLabelText } = draw()
    // `t` returns the key, and PayCellRow's label is `${title}. ${subtitle}`.
    expect(getByLabelText('pay_cell_nearby_pay. pay_cell_nearby_pay_sub').props.accessibilityState.disabled).toBe(false)
    expect(getByLabelText('pay_cell_handle_pay. pay_offline_needs_internet').props.accessibilityState.disabled).toBe(
      true
    )
    expect(getByLabelText('pay_cell_address_pay. pay_offline_needs_internet').props.accessibilityState.disabled).toBe(
      true
    )
  })

  it('leaves every cell enabled while online', () => {
    const { getByLabelText } = draw()
    expect(getByLabelText('pay_cell_handle_pay. pay_cell_handle_pay_sub').props.accessibilityState.disabled).toBe(false)
    expect(getByLabelText('pay_cell_address_pay. pay_cell_address_pay_sub').props.accessibilityState.disabled).toBe(
      false
    )
  })

  it('shows a rejected received payment through the attributed notice, not the sent one', async () => {
    // A held transaction can be rejected regardless of which side of it this
    // device was on (processOfflineActions.ts:rejectOne runs for any held
    // row). A 'sent' row has no senderIdentityKey/receivedVia — those are only
    // ever populated on the receiving side (storage/StorageExpoSQLite.ts
    // holdReqsOffline, and utils/localpay/pending.ts's processPending, which
    // backfills them after the fact) — so rendering it through the "who
    // handed you this" copy would misreport the payer's own failed payment as
    // a fraud someone else committed against them.
    const rows = [
      offlineRow({
        txid: 'aa'.repeat(32),
        role: 'received',
        status: 'rejected',
        senderIdentityKey: '02'.padEnd(66, 'c'),
        receivedVia: 'awdl'
      }),
      offlineRow({ txid: 'bb'.repeat(32), role: 'sent', status: 'rejected' })
    ]
    mockStorage = {
      sqliteDb: { getAllAsync: async () => rows, runAsync: async () => undefined, getFirstAsync: async () => undefined }
    }
    const { findByText, queryAllByText } = draw()
    await findByText('pay_offline_rejected_title')
    expect(queryAllByText('pay_offline_rejected_title')).toHaveLength(1)
  })

  it('shows the payer their own rejected payment through a distinct, unattributed notice', async () => {
    const rows = [offlineRow({ txid: 'bb'.repeat(32), role: 'sent', status: 'rejected' })]
    mockStorage = {
      sqliteDb: { getAllAsync: async () => rows, runAsync: async () => undefined, getFirstAsync: async () => undefined }
    }
    const { findByText, queryByText } = draw()
    await findByText('pay_offline_sent_rejected_title')
    // Never the received-side "who handed you this" copy for the user's own send.
    expect(queryByText('pay_offline_rejected_title')).toBeNull()
  })

  it('counts a queued payment toward the banner regardless of which side sent it', async () => {
    const rows = [
      offlineRow({ txid: 'cc'.repeat(32), role: 'received', status: 'queued' }),
      offlineRow({ txid: 'dd'.repeat(32), role: 'sent', status: 'posting' })
    ]
    mockOnline = false
    mockStorage = {
      sqliteDb: { getAllAsync: async () => rows, runAsync: async () => undefined, getFirstAsync: async () => undefined }
    }
    const { findByText } = draw()
    await findByText('pay_offline_queued')
  })

  it('surfaces a still-queued payment while online, not only while offline', async () => {
    // A queue that will never drain (a foreign ancestor no service accepts, a
    // row whose request has gone) is recorded only in the monitor's log string,
    // so /pay is the one place the user can learn about it.
    const rows = [offlineRow({ txid: 'ee'.repeat(32), role: 'received', status: 'queued' })]
    mockOnline = true
    mockStorage = {
      sqliteDb: { getAllAsync: async () => rows, runAsync: async () => undefined, getFirstAsync: async () => undefined }
    }
    const { findByText, queryByText } = draw()
    await findByText('pay_offline_pending_title')
    // Not the offline card: the device has signal.
    expect(queryByText('pay_offline_title')).toBeNull()
  })

  it('keeps the grid working when the queue read itself fails', async () => {
    // The banner is advisory, never load-bearing (see app/pay.tsx's queue
    // effect). A broken read must not take the rest of the screen down with it.
    mockStorage = {
      sqliteDb: {
        getAllAsync: async () => {
          throw new Error('database is locked')
        },
        runAsync: async () => undefined,
        getFirstAsync: async () => undefined
      }
    }
    const { findByText } = draw()
    await findByText('pay_cell_nearby_pay')
  })
})
