## Why

When a PeerPay payment is sent, `PeerPayClient.sendPayment()` does two things in sequence: it calls `createAction()` to build and broadcast the transaction, then calls `sendMessage()` to deliver the payment token (containing `derivationPrefix`, `derivationSuffix`, and the AtomicBEEF) to the recipient's MessageBox inbox. If the app crashes or loses connectivity between those two steps, the transaction is on-chain but the recipient never receives the token — meaning they cannot derive the key to claim the funds. The derivation data is ephemeral (lives only in memory during `createPaymentToken()`), so once the app crashes it is unrecoverable — unless it was stored before the send was attempted.

This was observed in practice: transaction `KDECl7dExHPjqMF8` (txid `08deafc5…`) was broadcast successfully but the payment token was never delivered to the recipient's inbox. The customInstructions on the output (which holds the encrypted derivation data) had to be manually recovered from the wallet database backup to reconstruct and resend the token.

## What Changes

- **PeerPay Outbox**: before calling `sendMessage()`, serialize the full payment token (including `transaction` bytes, `derivationPrefix`, `derivationSuffix`, `amount`, and `recipient`) into a persistent outbox stored in the wallet's `key_value_store` table under the key `peerpay_outbox`.
- **Delivery status tracking**: each outbox entry has a status of `unsent` or `sent`. The entry is marked `sent` only after `sendMessage()` returns successfully. Entries persist indefinitely until manually dismissed by the user.
- **Outbox UI on the Payments page**: a new "Outgoing" section surfaces `unsent` entries (and optionally all entries) with a manual **Retry** button per entry and a **Dismiss** button to remove a sent or permanently failed entry.
- **Decompose `sendPayment()`**: instead of calling `client.sendPayment()` (which bundles create + send atomically), call `client.createPaymentToken()` then persist to outbox, then call `client.sendMessage()` — so the outbox write happens in the crash-vulnerable gap.

## Capabilities

### New Capabilities

- `peerpay-outbox`: Persistent queue of outbound PeerPay payment tokens stored in `key_value_store`. Survives app crashes and restarts. Entries remain until manually dismissed.

### Modified Capabilities

- `payments-send-flow`: The outbound send flow in `app/payments.tsx` is decomposed into token creation → outbox persist → message delivery, replacing the single `client.sendPayment()` call.
- `payments-ui-outgoing`: The Payments page gains an "Outgoing" section listing outbox entries with their delivery status, a Retry button for `unsent` entries, and a Dismiss button.

## Impact

- **Screens**: `app/payments.tsx` (decompose send flow, add Outgoing section UI)
- **Utils**: new `utils/peerpay/outbox.ts` (outbox read/write/update, mirroring `utils/ble/pendingPayments.ts` pattern)
- **Storage**: `key_value_store` table (new key `peerpay_outbox`) — no schema changes needed
- **Dependencies**: no new external dependencies
