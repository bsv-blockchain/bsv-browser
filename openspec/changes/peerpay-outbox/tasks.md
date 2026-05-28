## 1. Create `utils/peerpay/outbox.ts`

- [x] 1.1 Create `utils/peerpay/outbox.ts`. Define the `OutboxEntry` interface:

  ```ts
  export interface OutboxEntry {
    id: string
    createdAt: string
    recipient: string
    token: {
      customInstructions: { derivationPrefix: string; derivationSuffix: string }
      transaction: number[]
      amount: number
    }
    messageBoxUrl: string
    status: 'unsent' | 'sent'
    lastAttemptAt?: string
    lastError?: string
  }
  ```

  Define `OUTBOX_KEY = 'peerpay_outbox'`. Define the private `StorageLike` interface requiring `getKeyValue` and `setKeyValue` (same shape as `utils/ble/pendingPayments.ts`).

- [x] 1.2 Implement `getOutboxEntries(storage): Promise<OutboxEntry[]>` — reads the JSON array from `key_value_store`, returns `[]` on missing or parse error.

- [x] 1.3 Implement private `writeEntries(storage, entries): Promise<void>` — serializes and writes the array back.

- [x] 1.4 Implement `saveOutboxEntry(storage, { recipient, token, messageBoxUrl }): Promise<string>` — generates `id = \`${Date.now()}_${recipient.slice(0, 8)}\``, pushes a new entry with `status: 'unsent'`and`createdAt: new Date().toISOString()`, writes, returns `id`.

- [x] 1.5 Implement `markOutboxSent(storage, id): Promise<void>` — finds entry by id, sets `status: 'sent'`, writes.

- [x] 1.6 Implement `updateOutboxEntry(storage, id, patch: Partial<OutboxEntry>): Promise<void>` — finds entry by id, merges patch, writes. Used to update `lastAttemptAt` and `lastError` on failed retries.

- [x] 1.7 Implement `removeOutboxEntry(storage, id): Promise<void>` — filters out entry by id, writes.

## 2. Decompose the Send Flow in `app/payments.tsx`

- [x] 2.1 Add `PaymentToken` to the import from `@bsv/message-box-client`. Add `OutboxEntry` import from `@/utils/peerpay/outbox`. Add `storage` to the `useWallet()` destructure at line ~766.

- [x] 2.2 Add outbox state and loader near the other `useState` declarations (around line 802):

  ```ts
  const [outboxEntries, setOutboxEntries] = useState<OutboxEntry[]>([])
  const [loadingOutbox, setLoadingOutbox] = useState(false)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  ```

- [x] 2.3 Add `loadOutbox` callback:

  ```ts
  const loadOutbox = useCallback(async () => {
    if (!storage) return
    setLoadingOutbox(true)
    try {
      setOutboxEntries(await getOutboxEntries(storage))
    } finally {
      setLoadingOutbox(false)
    }
  }, [storage])
  ```

  Call `loadOutbox()` in the existing `useEffect` that auto-fetches when configured (around line 886), alongside `fetchPayments()`.

- [x] 2.4 Replace the `sendPayment` helper call in `handleSend` (line ~984) with the decomposed sequence:
  1. `const token = await client.createPaymentToken({ recipient: recipientKey, amount: sats })`
  2. `const id = await saveOutboxEntry(storage, { recipient: recipientKey, token, messageBoxUrl })`
  3. `await loadOutbox()` (so UI shows the new entry immediately as `unsent`)
  4. `await client.sendMessage({ recipient: recipientKey, messageBox: 'payment_inbox', body: JSON.stringify(token) })`
  5. `await markOutboxSent(storage, id)`
  6. `await loadOutbox()` (refresh to show `sent`)

  If step 4 or 5 throws, catch and show the existing `sendResult` error toast — the entry remains `unsent` in the outbox, which the user can retry.

  Remove the now-unused standalone `sendPayment(client, recipientKey, sendAmount)` helper function at lines 206–211.

- [x] 2.5 Add `handleRetry` callback:

  ```ts
  const handleRetry = useCallback(
    async (entry: OutboxEntry) => {
      const client = peerPayClientRef.current
      if (!client || !storage) return
      setRetryingId(entry.id)
      await updateOutboxEntry(storage, entry.id, { lastAttemptAt: new Date().toISOString() })
      try {
        await client.sendMessage({
          recipient: entry.recipient,
          messageBox: 'payment_inbox',
          body: JSON.stringify(entry.token)
        })
        await markOutboxSent(storage, entry.id)
        toast.success('Payment delivered successfully')
      } catch (err: any) {
        await updateOutboxEntry(storage, entry.id, { lastError: err?.message || 'unknown error' })
        toast.error(`Retry failed: ${err?.message || 'unknown error'}`)
      } finally {
        setRetryingId(null)
        await loadOutbox()
      }
    },
    [storage, loadOutbox]
  )
  ```

- [x] 2.6 Add `handleDismiss` callback:
  ```ts
  const handleDismiss = useCallback(
    async (id: string) => {
      if (!storage) return
      await removeOutboxEntry(storage, id)
      await loadOutbox()
    },
    [storage, loadOutbox]
  )
  ```

## 3. Add Outgoing Section to Payments UI

- [x] 3.1 In the JSX of `app/payments.tsx`, add an "Outgoing" section rendered above the incoming payments list, conditional on `outboxEntries.length > 0`. Use the same `GroupedSection` / `View` pattern already used for incoming payments.

- [x] 3.2 Render a row per `OutboxEntry`:
  - Recipient key truncated (first 8 + `…` + last 4 chars), same style as sender display in incoming rows
  - `<AmountDisplay>{entry.token.amount}</AmountDisplay>`
  - Status badge:
    - `unsent` → `colors.warning` background, label `t('payment_not_delivered')`
    - `sent` → `colors.success` background, label `t('payment_delivered')`
  - `lastError` shown in a smaller line below the status badge when present
  - For `unsent`: **Retry** button, disabled + spinner when `retryingId === entry.id`
  - All entries: **Dismiss** button (uses `handleDismiss`)

- [x] 3.3 Show a section header "Outgoing" (translatable key `t('outgoing_payments')`) above the rows, using the same header style as the existing incoming payments section header.

- [x] 3.4 When `loadingOutbox` is true and `outboxEntries.length === 0`, render a small `ActivityIndicator` in place of the section (same pattern as `loadingPayments`).

## 4. Add i18n Keys

- [x] 4.1 Add the following keys to all language blocks in `translations.tsx`:
  - `outgoing_payments`: "Outgoing" (and equivalents)
  - `payment_not_delivered`: "Not delivered" (and equivalents)
  - `payment_delivered`: "Delivered" (and equivalents)

## 5. Verification

- [x] 5.1 Run TypeScript compilation (`npx tsc --noEmit`) and confirm no type errors in `utils/peerpay/outbox.ts` or `app/payments.tsx`.
- [x] 5.2 Confirm no remaining references to the removed standalone `sendPayment` helper function.
- [ ] 5.3 Manually verify: send a payment with network connectivity (runtime) → entry appears as `unsent` then transitions to `sent` → Dismiss removes it.
- [ ] 5.4 Manually verify: simulate a delivery failure (bad messageBoxUrl) (runtime) → entry stays `unsent` → Retry with correct URL → entry transitions to `sent`.
