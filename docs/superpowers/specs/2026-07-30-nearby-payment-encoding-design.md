# Nearby payment encoding: frame v2 and an always-fountain QR

Date: 2026-07-30
Branch: `feat/offline-nearby-payments`

## Problem

Two encodings cross the wire for a nearby payment: the payee's `Session` QR
(`bsvpay1:`) and the payer's `PaymentFrame`. Both carry a field that is either
redundant or unverifiable.

1. `PaymentFrame.amount` is a satoshi count the payer asserts, while the figure
   that actually moves is the `satoshis` of the AtomicBEEF output at
   `outputIndex`. `internalizeAction` credits the output, not the field, so the
   field is at best display copy (as the comment at `NearbyFlow.tsx:577` already
   says) and at worst a lie the payee renders as a receipt.

2. Nothing checks that the output at `outputIndex` locks to a key the payee can
   spend. A frame with correct derivation nonces, a correct `amount`, and an
   output paying a third party is accepted, acked `ok` — which releases the
   payer's transaction for broadcast — shown as "Received X", and only fails
   later inside `processPending`, where `internalizeAction` rejects it. The
   payment is broadcast, the payee has nothing, and both screens said it worked.

3. The frame QR has two formats: a single `bsvpayf1:` symbol below
   `MAX_FRAME_QR_CHARS` (2200), and `@bsv/air-gap` fountain parts above it. The
   threshold exists only because the static path predates the fountain path.
   Carrying both means every frame-rendering call site has a size gate, the
   scanner accepts two shapes, and frames too large for one symbol — anything
   multi-input — are refused before render rather than transmitted.

## Non-goals

- **`Session` encoding is unchanged.** Dropping `p`/`x` (letting the payer pick
  its own derivation nonces, as `bsvPaymentHandler.ts:158` does) was considered
  and rejected: the `p`/`x` equality test at `NearbyFlow.tsx:602-616` is the
  *entire* frame-to-session binding. Without it a stray payment QR credits a
  stranger's payment against the live request and burns it, and the genuine
  payer is then told `already_paid`. Any replacement (frame-carried
  `sessionId`, or an HMAC over the frame keyed by the session PSK) is a bigger
  change than the saving justifies. Not doing it.
- **`Ack` is unchanged**, including the `DeclineReason` set. New failures map
  onto existing reasons.
- No change to AWDL/Nearby socket framing, PSK handshake, or `instanceName`.

## Design

### 1. `PaymentFrame` v2 — `amount` deleted

`FRAME_VERSION` 1 → 2. New layout (`utils/localpay/codec.ts`):

```
[1]    version (2)
[33]   senderIdentityKey, raw compressed pubkey
[v]    outputIndex                (LEB128 varint)
[v]+n  derivationPrefix           (varint length + UTF-8)
[v]+n  derivationSuffix
[v]+n  transaction                (AtomicBEEF)
```

`PaymentFrame.amount` is removed from the interface, `encodeFrame`, and
`decodeFrame`. The saving is 2–3 bytes; the point is that a field which cannot
be verified against the transaction no longer exists to be trusted.

`decodeFrame`'s minimum length stays 34 bytes (version + pubkey) and the
`unsupported frame version` guard now rejects 1.

### 2. `verifyFramePayment` — where the figure comes from

New module `utils/localpay/verify.ts`, one export:

```ts
verifyFramePayment(
  wallet: DerivingWallet,
  frame: PaymentFrame,
  originator: string
): Promise<{ satoshis: number }>
```

Steps, in order:

1. `Transaction.fromAtomicBEEF(frame.transaction)`. A parse failure throws.
2. Bounds-check `frame.outputIndex` against `tx.outputs.length`.
3. Derive the payee's own expected script:
   `wallet.getPublicKey({ protocolID: PEERPAY_PROTOCOL_ID, keyID: \`${frame.derivationPrefix} ${frame.derivationSuffix}\`, counterparty: frame.senderIdentityKey, forSelf: true })`
   → `new P2PKH().lock(PublicKey.fromString(pk).toAddress()).toHex()`.
4. Compare to `tx.outputs[outputIndex].lockingScript.toHex()`. Mismatch throws.
5. Return that output's `satoshis`, validated with `isRequestableAmount`.

`forSelf: true` with `counterparty: senderIdentityKey` is the payee-side mirror
of the payer's derivation in `build.ts:104-112`; step 4 is therefore a proof
that this output is spendable by this device, which is what makes the satoshi
count in step 5 worth reading.

Errors are distinguished so the caller can pick a decline reason: a dedicated
`FrameVerifyError` with `kind: 'unparseable' | 'not_mine'`.

### 3. Settle path

`settleReceived` (`components/pay/NearbyFlow.tsx:556`) calls
`verifyFramePayment` before the binding decision at :602, and the derived
`satoshis` replaces every read of `frame.amount`:

- binding check: `session.amount !== undefined && satoshis !== session.amount`
  (unchanged semantics, but now against the real output)
- `setSettledAmount(satoshis)` (:718)
- `setReceivedOverlay({ amount: satoshis, ... })` (:764)

Decline mapping, within the existing reason set:

| verify failure | reason | rationale |
| --- | --- | --- |
| `unparseable` | `decode_failed` | the bytes did not yield a transaction |
| `not_mine` | `session_mismatch` | the frame is not a payment to this device |
| amount vs `session.amount` | `session_mismatch` | unchanged |

All three occur before `settlingRef` latches and before any write, so all three
remain provable "queued nothing" declines — the payer may release its inputs.
`not_mine` and the amount disagreement stay non-terminal and do not mark the
session spent, exactly as the nonce mismatch does today: the request stays live
so the genuine payer can still complete.

Where `verifyFramePayment` throws on the QR path (`confirm === undefined`) the
existing `fail('generic', ...)` handling applies; there is no socket to ack over.

### 4. QR wire: always `@bsv/air-gap`, 1 KiB blocks

`FRAME_BLOCK_BYTES = 1024`, exported from `utils/localpay/codec.ts` and
re-exported by the `nearby` rail. `estimatePartCharLength(1024)` is 1404
characters — one byte per character in QR byte mode, inside the 2331-byte
capacity of a version-40 symbol at error-correction level M, with ~40%
headroom for an off-axis scanner.

- `PaymentQrDisplay` loses its static branch. It always builds
  `new AirGapEncoder(frameBytesFromQr(frameQr), { blockBytes: FRAME_BLOCK_BYTES })`
  and animates at the existing `FRAME_MS` (200 ms) with the existing
  `SEQ_WRAP_CYCLES` wrap. A frame of ≤1024 bytes is a single source block, so
  `partAt(seq)` yields the same string for every `seq` and a typical ~400-byte
  payment still renders as a visually static QR. No special case is needed for
  it, and none is added.
- `MAX_FRAME_QR_CHARS` is **deleted**. The bound becomes air-gap's own
  `MAX_MESSAGE_BYTES` (64 KiB), enforced by the encoder constructor. The send
  path already gates on that value (`NearbyFlow.tsx:1062`, `:1105`), so those
  call sites are untouched; the encoder's own throw, surfaced through
  `PaymentQrDisplay`'s existing `onError`, remains the backstop. The only
  `MAX_FRAME_QR_CHARS` reader left is the animation-hint condition at `:1693`,
  which becomes "more than one source block":
  `frameBytesFromQr(paymentQr).length > FRAME_BLOCK_BYTES`.
- `onFrameScanned` loses its bare-envelope branch (`NearbyFlow.tsx:902-919`).
  Frames arrive as air-gap parts only.
- `frameFromQr` is deleted — with the scan branch gone it has no caller, and
  leaving a second accepted frame format in the codec is precisely the "second
  implementation" the nearby rail's doc comment exists to prevent.
- `frameToQr` and `frameBytesFromQr` stay. `bsvpayf1:` is demoted from a QR wire
  format to the persistence envelope for `offline_actions.framePayload`, which
  the payer's re-show path (`app/pay.tsx:306`, `OfflineNotice.tsx:147`) reads
  back and hands to `PaymentQrDisplay`. Their doc comments say so.

### 5. Compatibility

- **Wire:** a v1 frame from an older dev build is refused with
  `unsupported frame version 1` → `decode_failed`. The branch is unreleased, so
  no external peer exists; two devices must be on the same build, which they
  already must be for the `caps` bitfield to mean anything.
- **`PendingPayment` on disk:** serialized as JSON of the frame object
  (`pending.ts:32-40`), so an already-queued v1 entry simply carries an extra
  `amount` key that nothing reads. `processPending` uses `outputIndex`,
  nonces, `senderIdentityKey` and `transaction` only — untouched.
- **`offline_actions.framePayload` on disk:** re-shown by rendering the string,
  never by decoding it, so stored v1 payloads keep displaying. They would be
  refused by a v2 receiver, which is correct: that payment's inputs are stale.
- No schema migration.

## Testing

Extend the existing suites; no new harness.

- `__tests__/localpayCodec.test.ts` — v2 round-trip; `amount` absent from the
  decoded shape; a v1 byte string rejected with the version message; trailing
  bytes and truncation still rejected; `FRAME_BLOCK_BYTES` asserted against
  `estimatePartCharLength(FRAME_BLOCK_BYTES) <= 2331` so a future block-size
  change cannot silently exceed a version-40 M symbol.
- `__tests__/localpayVerify.test.ts` (new) — with a stub wallet whose
  `getPublicKey` returns a known key: the happy path returns the output's
  `satoshis`; an output locking to a different script throws `not_mine`;
  garbage `transaction` bytes throw `unparseable`; `outputIndex` past the end
  throws; a zero-satoshi output is refused.
- `__tests__/localpayAirGap.test.ts` — a sub-1 KiB frame produces
  `blockCount === 1` and an identical part for several `seq` values; a >1 KiB
  frame round-trips encoder → decoder → `decodeFrame`.
- `__tests__/payScreen.test.tsx` / existing NearbyFlow coverage — a frame whose
  output pays a stranger is declined `session_mismatch` and writes nothing; the
  settled figure shown comes from the transaction, not from any frame field.

## Files touched

| file | change |
| --- | --- |
| `utils/localpay/codec.ts` | `FRAME_VERSION` 2, drop `amount`, add `FRAME_BLOCK_BYTES`, delete `MAX_FRAME_QR_CHARS` and `frameFromQr` |
| `utils/localpay/verify.ts` | new — `verifyFramePayment`, `FrameVerifyError` |
| `utils/localpay/build.ts` | stop writing `amount` into the frame (it still validates and uses `amount` to size the output) |
| `utils/pay/rails/nearby.ts` | re-export surface follows the codec |
| `components/pay/PaymentQrDisplay.tsx` | always-fountain, fixed block size |
| `components/pay/NearbyFlow.tsx` | verify in settle, satoshis from the tx, drop the bare-QR scan branch and the size gates |
| `__tests__/localpay*.test.ts` | as above |
