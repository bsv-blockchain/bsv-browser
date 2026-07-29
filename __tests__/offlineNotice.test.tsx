// Same convention as __tests__/payScreen.test.tsx and __tests__/Toast.test.tsx:
// @expo/vector-icons pulls in expo-font, which ships ESM and is not covered by
// this repo's transformIgnorePatterns exceptions, so every test that renders
// an Ionicons-using component mocks the module to a bare string component.
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }))

// Unlike payScreen.test.tsx and payReceivedOverlay.test.tsx, this file does NOT
// mock react-i18next: the assertions below match on real English copy ("2",
// "02cccc", "rejected"), not on translation keys, so the real i18n instance —
// initialised as a side effect of importing translations.tsx — has to be
// running. That module also detects a device locale; in this Jest environment
// no locale is found, so it falls back to 'en', which is what these tests need.
import '@/context/i18n/translations'

import React from 'react'
import { render } from '@testing-library/react-native'
import OfflineNotice from '@/components/pay/OfflineNotice'

const row = (txid: string) => ({
  offlineActionId: 1,
  created_at: '2026-07-28T00:00:00.000Z',
  updated_at: '2026-07-28T00:00:00.000Z',
  userId: 1,
  txid,
  seq: 1,
  role: 'received' as const,
  senderIdentityKey: '02'.padEnd(66, 'c'),
  receivedVia: 'awdl',
  status: 'rejected' as const,
  rejectedReason: 'the network rejected the transaction as invalid',
  poisonedByTxid: txid,
  framePayload: null
})

// A payer's own held payment can be rejected too, but it carries no attribution
// — there is no counterparty to blame for a transaction the user sent themselves.
const sentRow = (txid: string) => ({
  ...row(txid),
  offlineActionId: 2,
  seq: 2,
  role: 'sent' as const,
  senderIdentityKey: null,
  receivedVia: null
})

describe('OfflineNotice', () => {
  it('renders nothing when online with an empty queue', () => {
    const { toJSON } = render(<OfflineNotice online queued={0} rejected={[]} />)
    expect(toJSON()).toBeNull()
  })

  it('says it is offline', () => {
    const { getByText } = render(<OfflineNotice online={false} queued={0} rejected={[]} />)
    expect(getByText(/offline/i)).toBeTruthy()
  })

  it('reports the queued count while offline', () => {
    const { getByText } = render(<OfflineNotice online={false} queued={2} rejected={[]} />)
    expect(getByText(/2/)).toBeTruthy()
  })

  // The drain can stall permanently (a foreign ancestor no service accepts, a
  // row whose request has vanished) and records that nowhere the user can see.
  // Going blank the moment signal returns would make a stuck payment look
  // exactly like a settled one.
  it('still reports a non-empty queue once back online', () => {
    const { getByText } = render(<OfflineNotice online queued={3} rejected={[]} />)
    expect(getByText(/3/)).toBeTruthy()
  })

  it('never says a queued payment has settled, online or off', () => {
    const { getByText } = render(<OfflineNotice online queued={1} rejected={[]} />)
    // The negation is the load-bearing part of the copy: "not reached the
    // network yet", never "received" or "settled".
    expect(getByText(/not reached the network yet/i)).toBeTruthy()
    expect(getByText(/nothing is settled until/i)).toBeTruthy()
  })

  it('does not double up the queue count on the offline card', () => {
    // Offline, the offline card already carries the count; a second card saying
    // the same thing is noise.
    const { queryByText } = render(<OfflineNotice online={false} queued={2} rejected={[]} />)
    expect(queryByText(/not reached the network yet/i)).toBeNull()
  })

  it('shows a rejection with its sender even when back online', () => {
    const { getByText } = render(<OfflineNotice online queued={0} rejected={[row('aa'.repeat(32))]} />)
    expect(getByText(/02cccc/i)).toBeTruthy()
    expect(getByText(/rejected/i)).toBeTruthy()
  })

  it('renders nothing online with an empty queue and no rejections of either kind', () => {
    const { toJSON } = render(<OfflineNotice online queued={0} rejected={[]} sentRejected={[]} />)
    expect(toJSON()).toBeNull()
  })

  it('shows a distinct notice for a payment the user sent that could not be delivered, unattributed', () => {
    const { getByText, queryByText } = render(
      <OfflineNotice online queued={0} rejected={[]} sentRejected={[sentRow('bb'.repeat(32))]} />
    )
    expect(getByText(/could not be delivered/i)).toBeTruthy()
    // There is no counterparty to name for the user's own failed send — this
    // must never borrow the received-side "who handed it over" copy.
    expect(queryByText(/handed over/i)).toBeNull()
  })
})
