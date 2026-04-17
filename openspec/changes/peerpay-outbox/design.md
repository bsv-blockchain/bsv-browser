## Context

`PeerPayClient.sendPayment()` is an atomic black-box: it calls `createPaymentToken()` (which runs `createAction()` and generates ephemeral derivation nonces) then immediately calls `sendMessage()` to deliver the token to the recipient's MessageBox inbox. The payment token — containing `derivationPrefix`, `derivationSuffix`, and the full AtomicBEEF — exists only in memory between those two steps. A crash or network failure there leaves the transaction on-chain but the recipient with no way to claim the output.

The fix is to persist the token into the wallet's `key_value_store` table _before_ attempting `sendMessage()`. On success, the entry is marked `sent`. It stays there until the user explicitly dismisses it. The UI surfaces undelivered entries with a Retry button.

The `storage` object (`StorageExpoSQLite`) is already exposed via `WalletContext` (`storage: StorageExpoSQLite | null`) and has `getKeyValue` / `setKeyValue` methods. The pattern mirrors `utils/ble/pendingPayments.ts` exactly.

`PeerPayClient` exposes `createPaymentToken()` and `sendMessage()` as separate public methods, so the send flow can be decomposed without forking the library.

## Goals / Non-Goals

**Goals:**

- Persist the full payment token before delivery is attempted
- Mark entry `sent` only after `sendMessage()` succeeds
- Surface `unsent` entries in the Payments UI with a per-entry Retry button
- Show all outbox entries (sent and unsent) with a Dismiss button to remove them
- Entries persist indefinitely until explicitly dismissed

**Non-Goals:**

- Automatic background retry (manual only)
- Handling the reverse failure (token delivered, tx never broadcast) — requires `noSend` flow, a separate change
- Deduplication of MessageBox messages on the server (unknown whether the server is idempotent on messageId; we do not assume it is)

## Decisions

### 1. Storage: `key_value_store` under key `peerpay_outbox`

**Choice**: Store the outbox as a JSON array in `key_value_store` under the key `peerpay_outbox`, identical to how `utils/ble/pendingPayments.ts` stores `ble_pending_payments`.

**Rationale**: No schema migration needed. `getKeyValue`/`setKeyValue` are already available. The outbox will be a small array (typically 0–5 entries at any time) so a single JSON blob is fine.

### 2. Outbox entry shape

```ts
interface OutboxEntry {
  id: string // `${timestamp}_${recipientKey.slice(0, 8)}`
  createdAt: string // ISO 8601
  recipient: string // recipient identity key (hex compressed pubkey)
  token: {
    customInstructions: { derivationPrefix: string; derivationSuffix: string }
    transaction: number[] // full AtomicBEEF bytes
    amount: number // satoshis
  }
  messageBoxUrl: string // the host used at creation time
  status: 'unsent' | 'sent'
  lastAttemptAt?: string // ISO 8601, updated on each retry attempt
  lastError?: string // error message from last failed attempt
}
```

The `transaction` bytes are stored in full. This avoids any dependency on re-fetching the BEEF from the wallet on retry.

### 3. Send flow decomposition

**Current** (`app/payments.tsx:206–210`):

```
sendPayment(client, recipientKey, amount)
  └─ client.sendPayment({ recipient, amount })
       ├─ createPaymentToken()  →  tx on-chain, token in memory
       └─ sendMessage()         →  token delivered (or crash here)
```

**New**:

```
handleSend()
  ├─ token = await client.createPaymentToken({ recipient, amount })
  ├─ id = await saveOutboxEntry(storage, { recipient, token, messageBoxUrl })
  ├─ try sendMessage({ recipient, messageBox: 'payment_inbox', body: JSON.stringify(token) })
  │    └─ on success: await markOutboxSent(storage, id)
  └─ on error: entry stays 'unsent', UI notifies user
```

The `sendPayment` helper function at line 206 is replaced by an inline sequence in `handleSend`. The `PeerPayClient` instance is used for both `createPaymentToken` and `sendMessage`.

### 4. Retry flow

When the user taps Retry on an `unsent` entry:

```
handleRetry(entry)
  ├─ update lastAttemptAt
  ├─ try sendMessage({ recipient, messageBox: 'payment_inbox', body: JSON.stringify(entry.token) })
  │    └─ on success: markOutboxSent(storage, entry.id)
  └─ on error: update lastError, show toast
```

The token body is re-serialized from the stored entry as-is. The `messageId` derived by `MessageBoxClient.sendMessage` is HMAC-deterministic from the body, so retrying with the same token produces the same `messageId`. Whether the server deduplicates on `messageId` is unknown, but the worst case is the recipient sees the message twice — they can only internalize it once (the wallet enforces this via the output being spent).

### 5. UI: Outgoing section on the Payments page

A new collapsible "Outgoing" section appears above the incoming payments list, rendered only when the outbox is non-empty. Each entry shows:

- Recipient identity key (truncated, same style as incoming sender display)
- Amount via `<AmountDisplay>`
- Status badge: `unsent` → warning color "Not delivered"; `sent` → success color "Delivered"
- For `unsent`: **Retry** button (calls `handleRetry`)
- For all entries: **Dismiss** button (removes from outbox, calls `removeOutboxEntry`)

The outbox is loaded from storage on component mount and refreshed after each send / retry / dismiss.

### 6. New utility file: `utils/peerpay/outbox.ts`

Mirrors `utils/ble/pendingPayments.ts`:

```
STORAGE_KEY = 'peerpay_outbox'

saveOutboxEntry(storage, { recipient, token, messageBoxUrl }) → Promise<string>   // returns id
markOutboxSent(storage, id) → Promise<void>
updateOutboxEntry(storage, id, patch) → Promise<void>
removeOutboxEntry(storage, id) → Promise<void>
getOutboxEntries(storage) → Promise<OutboxEntry[]>
```

All functions read the full array, mutate, and write back — same pattern as the BLE pending payments module.

## Risks / Trade-offs

- **[MessageBox duplicate delivery]**: Retrying delivers the same messageId. The recipient's wallet will attempt `internalizeAction` again on the same tx, which should be idempotent at the wallet level (the output is already spent or claimed). Risk is low.
- **[Large token storage]**: The AtomicBEEF for a typical PeerPay tx is ~500–2000 bytes. Even with 10 unresolved entries that's ~20 KB in a single JSON blob in key_value_store. Acceptable.
- **[key_value_store not exposed to payments.tsx currently]**: `storage` is already in `WalletContextValue` and destructurable from `useWallet()`. No context changes needed.
- **[`createPaymentToken` vs `sendPayment` split]**: `createPaymentToken` is a public method on `PeerPayClient` per the published types. This is stable API surface.
