# Local Payments over AWDL — Design

**Date:** 2026-07-27
**Status:** Proposed
**Supersedes:** the BLE implementation on branch `bluetooth` (tip `5fc72a7`, removed from `master` by `ed454e9`)

## Summary

Phone-to-phone BSV payments between nearby devices, without exchanging identity handles.

Two transports behind one interface:

- **AWDL** (iOS↔iOS) — Bonjour + TCP over Apple's peer-to-peer Wi-Fi, no infrastructure required. Fast path.
- **QR** (any platform pair) — a single static QR carrying the signed transaction. Fallback and the only path involving Android.

Both are bootstrapped by the same QR code, so there is one user-facing flow.

## Why not BLE

BLE was the previous implementation and is now unavailable. `com.apple.developer.web-browser` prohibits `NSBluetoothAlwaysUsageDescription`, while ITMS-90683 demands that exact key whenever CoreBluetooth appears in the binary — linkage-triggered, not usage-triggered. Confirmed empirically at both gates on 2026-07-27, with an appeal to Developer Relations already exhausted. The minimum surface (central-only, no `CBPeripheralManager`) was tested and still rejected. AccessorySetupKit does not escape it: its own API is typed in `CBUUID`, and it has no advertising role.

See `memory/project_web_browser_entitlement.md` for the full record.

AWDL carries no such exposure. `NSLocalNetworkUsageDescription` and `NSBonjourServices` are not on the prohibited list, and no entitlement is required.

## Non-goals

- **Android as an AWDL peer.** AWDL is Apple-proprietary. Android participates via QR only.
- **Offline / chained unconfirmed spends.** Separate tech spike. This design assumes both devices have connectivity.
- **Bluetooth, in any form.**
- **Background operation.** Foreground only.

## Architecture

Four layers. Only the first is platform-specific.

```
┌─────────────────────────────────────────────┐
│ app/local-payments.tsx        screen + flow │
├─────────────────────────────────────────────┤
│ utils/localpay/                             │
│   session.ts   pairing, sessionId, PSK      │
│   codec.ts     binary payload encode/decode │
│   pending.ts   persist → internalize → retry│
├─────────────────────────────────────────────┤
│ LocalPaymentTransport  (interface)          │
│   ├── AwdlTransport   iOS only              │
│   └── QrTransport     all platforms         │
├─────────────────────────────────────────────┤
│ modules/local-pay-transport/  Expo module   │
│   Swift: NWListener / NWBrowser / TLS-PSK   │
└─────────────────────────────────────────────┘
```

### Transport interface

```ts
interface LocalPaymentTransport {
  readonly kind: 'awdl' | 'qr'
  /** Payee: begin accepting a payment for this session. */
  receive(session: Session, signal: AbortSignal): Promise<PaymentFrame>
  /** Payer: deliver a payment for this session. */
  send(session: Session, frame: PaymentFrame, signal: AbortSignal): Promise<Ack>
}
```

Transport selection is a pure function of the scanned QR and the local platform: AWDL when both sides support it, QR otherwise. No negotiation round trip.

## Pairing

The payee mints a session and renders it as a QR:

| Field | Bytes | Purpose |
|---|---|---|
| `v` | 1 | format version |
| `caps` | 1 | bitfield; bit 0 = payee accepts AWDL |
| `sessionId` | 16 | random; becomes the Bonjour instance name |
| `psk` | 32 | random; TLS pre-shared key |
| `identityKey` | 33 | payee compressed pubkey |
| `amount` | ~5 | varint satoshis |
| `derivationPrefix` | ~16 | BRC-29 nonce |
| `derivationSuffix` | ~16 | BRC-29 nonce |

≈ 120 bytes → a small static QR, instant to scan.

`sessionId` is rendered as base32 for the Bonjour instance name (`bsvpay-<26 chars>`), keeping it within DNS-SD label limits.

## AWDL path

**Payee** starts an `NWListener`:
- Bonjour service `_bsvpay._tcp`, instance name from `sessionId`
- `NWParameters.includePeerToPeer = true`
- TLS via `sec_protocol_options_add_pre_shared_key(psk, sessionId)`

**Payer** runs an `NWBrowser` for `_bsvpay._tcp`, filters to the exact instance name, connects with identical PSK parameters, and completes the handshake.

Then: payer sends one length-prefixed `PaymentFrame`; payee validates, persists, replies with an `Ack`; both tear down.

### Security

The PSK does the work. Only a device that physically saw the QR can complete the handshake, which gives mutual authentication and channel encryption from the OS — no hand-rolled crypto, and no plaintext BEEF on the air. This closes the "no encryption on the link" hole the BLE implementation shipped with.

Replay is bounded by `sessionId` being single-use: the payee stops listening after the first successful transfer and refuses a `sessionId` it has already settled.

**Threat not covered:** an attacker who photographs the QR before the payer scans it can impersonate the payer. They can only *send* money to the payee, so this is not a theft vector. Noted rather than mitigated.

## QR path

Used whenever either device is not iOS.

The payer builds and signs the transaction, then renders the `PaymentFrame` as a second static QR. The payee scans it.

Payload is the signed **AtomicBEEF** plus routing fields — the same encoding the AWDL path uses.

> **Amended during implementation.** This section originally specified a bare rawtx on the QR path, with the payee fetching ancestors by txid at internalize time, giving a ~350–450 byte frame. That is not what shipped, and the shipped behaviour is the correct one: a bare rawtx makes the payee's `internalizeAction` depend on network reachability at exactly the moment two devices may have chosen a local hand-off *because* connectivity is poor. Carrying ancestry keeps the receive side offline-capable and keeps one encoding across both transports.
>
> The cost is size: AtomicBEEF grows with input count, so a multi-input payment can exceed what a symbol will hold. `MAX_FRAME_QR_CHARS` (2,200 chars, `utils/localpay/codec.ts`) is the ceiling; the payer checks against it before rendering and reports `local_pay_too_large` rather than handing an oversize payload to the encoder, which would otherwise throw out of render. A single-input payment fits comfortably (v40 byte-mode holds 2,331 B at EC level M).

There is no ACK on this path. The payer's QR stays on screen until dismissed; the payee's snackbar is the receipt.

**Deliberately not doing:** broadcasting the transaction before handoff to shrink the QR to a bare txid. It would commit funds before the payee has received anything.

## Payload

PeerPay-shaped, so the receive side stays a standard `internalizeAction`. Protocol ID `[2, '3241645161d8']`.

```
PaymentFrame {
  version: u8
  senderIdentityKey: 33 bytes
  amount: varint
  outputIndex: varint
  derivationPrefix: len-prefixed bytes
  derivationSuffix: len-prefixed bytes
  transaction: len-prefixed bytes   // AtomicBEEF, on both transports
}
```

Binary, length-prefixed. **Not** JSON with `transaction` as `number[]` — that was a ~3.3× inflation in the BLE version and the origin of its 100 KB ceiling.

## Money safety

Unchanged in principle from the BLE implementation, which got this part right.

A received frame is persisted **before** any internalize attempt, so neither a crash nor a dead network can lose money that already crossed. `utils/localpay/pending.ts` lifts from `utils/ble/pendingPayments.ts` (211 lines, transport-agnostic, duck-typed).

- Storage: wallet `key_value_store`, key `localpay_pending`
- Statuses: `pending` → `processing` → `completed` | `failed`
- Retry triggers: on receive, on wallet build at next app open, on NetInfo offline→online

`internalizeAction` requires an online chainTracker (`@bsv/wallet-toolbox-mobile/.../internalizeAction.js:96` — `ab.verify(await wallet.getServices().getChainTracker(), false)`), so settlement is always deferred behind connectivity regardless of transport.

## Native module

`modules/local-pay-transport/`, authored with the Expo Modules API (Swift) to match Expo 55 / RN 0.83.6 / New Architecture.

Surface:
```
advertise(instanceName, psk) -> events: ready | connected | frame | error | closed
browseAndConnect(instanceName, psk, timeoutMs) -> connection handle
send(handle, bytes) / close(handle)
```

~400–500 lines Swift plus a TS wrapper. All public API — `Network`, `Security`. Nothing the App Store binary scan takes an interest in.

## Configuration

`app.json`:
- `NSBonjourServices`: `["_expo._tcp", "_bsvpay._tcp"]`
- `NSLocalNetworkUsageDescription`: replace the Expo Dev Launcher default currently shipping (*"Expo Dev Launcher uses the local network to discover and connect to development servers on your computer"*) with a real user-facing string. **This is worth fixing on its own merits** — shipping dev-tooling copy as a purpose string is a 5.1.1 exposure independent of this feature.

No entitlement. No background modes.

## Reuse and disposal

**Reuse from `bluetooth` @ `5fc72a7`:** `pendingPayments.ts`, the `WalletContext` retry hooks and NetInfo transition, the global snackbar in `_layout.tsx`, the screen's UI and i18n (242 lines of translations), token construction.

**Discard:** `utils/ble/chunking.ts` (TCP is a stream; QR is one frame), `central.ts`, `peripheral.ts`, `constants.ts`, `types.ts`, `hooks/useBLETransfer.ts` (453 lines the screen never used), `patches/munim-bluetooth+0.3.24.patch`, and both BLE libraries.

## Testing

- **Unit:** codec round-trip incl. malformed and truncated input; session mint/parse; pending-payment state machine incl. crash-mid-processing.
- **Integration:** two iOS devices, AWDL, airplane-mode-with-Wi-Fi-on and both-on-the-same-network; iOS↔Android over QR in both directions.
- **Failure paths that must be exercised, not assumed:** Local Network permission denied; payer walks out of range mid-transfer; payee backgrounds the app mid-transfer; duplicate `sessionId` replay; payee offline at receipt then internalizing on reconnect.

## Risks

| Risk | Severity | Handling |
|---|---|---|
| Local Network permission denied — feature is dead | high | Explicit UX, not a silent failure. Detect and offer a route to Settings. |
| AWDL flakiness when both devices are also on infrastructure Wi-Fi | high | Device testing before commitment; QR fallback is always available |
| Expo module + New Arch integration | medium | Public API only; spike the module before the screen |
| Guideline 3.1.1 — QR codes and crypto wallets as unlock mechanisms | low | Don't present this as unlocking content. Existing `handle402()` engages that far more directly. |
| iOS-only fast path is a two-tier experience | low | Accepted; QR keeps Android functional |

## Open questions

1. Should the payee be able to raise a request with **no amount** (payer chooses)? The BLE version required an amount up front.
2. Retention policy for `completed` entries in the pending store.
3. Does the QR path need a payee→payer confirmation QR, or is the snackbar sufficient?
