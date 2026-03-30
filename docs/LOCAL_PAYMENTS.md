# Local Payments (BLE P2P Transfer)

## Overview

Local Payments enables peer-to-peer BSV transfers between two nearby phones over Bluetooth Low Energy (BLE). One phone advertises as a **receiver** (peripheral mode), the other discovers and connects as a **sender** (central mode). The payment uses the same `createAction` / `internalizeAction` BEEF transaction format as the existing PeerPay flow, but the transaction data is chunked and transferred over BLE instead of MessageBox.

The feature is accessible from **Settings > Local Payments** in the wallet drawer.

## Architecture

### Hybrid BLE Library Approach

No single React Native BLE library supports both central and peripheral roles on both platforms. We use two libraries:

| Library                    | Role            | Used for                                                                 |
| -------------------------- | --------------- | ------------------------------------------------------------------------ |
| **`munim-bluetooth`**      | Peripheral only | Advertising, GATT server, receiving characteristic writes                |
| **`react-native-ble-plx`** | Central only    | Scanning, connecting, service discovery, reading/writing characteristics |

**Why not one library?**

- `react-native-ble-plx` and `react-native-ble-manager` are both central-only -- neither supports peripheral/advertising mode.
- `munim-bluetooth` supports both roles, but its iOS central implementation is severely incomplete (`discoverServices` resolves immediately with `[]`, `readCharacteristic` returns "Not implemented").
- On Android, `munim-bluetooth` central mode works but has scanning bugs (empty `serviceUUIDs` used `emptyList()` instead of `null`).

We patched `munim-bluetooth` via `patch-package` for the peripheral-mode gaps (iOS `didReceiveWrite` delegate, iOS/Android `characteristicValueChanged` event emission, Android scan filter fix). The patches live in `patches/munim-bluetooth+0.3.24.patch`.

### Identity Exchange via GATT Characteristic

The receiver's identity cannot be embedded in BLE advertising data (iOS `CBPeripheralManager` blocks `manufacturerData` in peripheral ads; Android ignores custom `localName`). Instead:

1. The receiver sets up a GATT service with three characteristics:
   - **Identity** (`B5A1E003-...`): Readable, contains the receiver's 33-byte compressed public key
   - **Write** (`B5A1E001-...`): Sender writes chunked payment data here
   - **Notify** (`B5A1E002-...`): Reserved for ACK/NAK responses

2. The sender scans for the service UUID (`B5A1E000-...`), connects, reads the identity characteristic, resolves the identity via `IdentityClient`, then disconnects before the user confirms.

### Payment Format

The payment uses the same format as `PeerPayClient` from `@bsv/message-box-client`:

```
createAction() -> BEEF transaction -> serialise BLEPaymentPayload -> chunk -> BLE writes -> reassemble -> internalizeAction()
```

Protocol ID: `[2, '3241645161d8']`

The `BLEPaymentPayload` structure:

```typescript
{
  version: 1,
  senderIdentityKey: string,      // 66-char hex compressed public key
  token: {
    customInstructions: {
      derivationPrefix: string,    // base64 nonce
      derivationSuffix: string     // base64 nonce
    },
    transaction: number[],         // AtomicBEEF bytes
    amount: number,                // satoshis
    outputIndex?: number           // defaults to 0
  }
}
```

### Chunking Protocol

BLE has a maximum write size (typically 200-512 bytes depending on MTU negotiation). The serialised payload is split into chunks:

- **Header**: 3 bytes per chunk (2-byte big-endian sequence number + 1-byte flags)
- **Chunk payload**: 200 bytes per chunk (conservative, works within most MTU sizes)
- **Maximum total payload**: 100 KB
- **First chunk** (flag `0x02`): Carries metadata -- total byte count, total chunk count, CRC32 checksum
- **Intermediate chunks** (flag `0x00`): Sequential data
- **Final chunk** (flag `0x01`): Last data chunk; receiver verifies CRC32 after reassembly

## UX Flow

```
                    SENDER                              RECEIVER
                    ------                              --------
                                                   1. Tap "Request Payment"
                                                   2. GATT service created
                                                   3. Advertising starts
                                                   4. Waiting for sender...

1. Tap "Send Payment"
2. Wait for BLE PoweredOn
3. Scan for BSV_PAYMENT_SERVICE_UUID
4. Device found -> connect
5. Read identity characteristic
6. Resolve identity via IdentityClient
7. Disconnect
8. Show receiver identity card
9. Select receiver
10. Enter amount
11. Tap "Send"
12. createAction() builds TX
13. Serialise + chunk payload
14. Connect to receiver
15. Write chunks sequentially          ->    Receive chunks
16. Wait for processing                      Reassemble + verify CRC32
                                             Persist to pending queue
                                             Attempt internalizeAction()
17. "Payment Sent" screen                    "Payment Received" screen
                                             Snackbar: success or saved
```

## Persistence and Auto-Internalization

Received payments are **persisted before internalization** to guard against data loss from app crashes, network failures, or the device being offline.

### Storage

Pending payments are stored in the wallet's existing `key_value_store` SQLite table under the key `ble_pending_payments`. Each entry includes the full `BLEPaymentPayload`, status tracking, and timestamps.

Statuses: `pending` | `processing` | `completed` | `failed`

### Auto-Internalization Triggers

1. **Immediately on receive**: After a BLE transfer completes, the payload is persisted, then `processPendingPayments()` is called. If the device is online and the wallet is ready, internalization happens instantly.

2. **On wallet build**: When the wallet finishes building on a subsequent app open (`WalletContext.tsx`), any unprocessed payments in the queue are internalized.

3. **On connectivity restored**: A `NetInfo` listener in `WalletContext.tsx` triggers `processPendingPayments()` whenever the device transitions from offline to online.

### Offline Mode

If the device is offline when a payment arrives:

- The payload is persisted to the pending queue
- A snackbar shows "Payment saved -- will be added to wallet when back online"
- When connectivity returns (or on next app open), the payment is automatically internalized

### Notification System

- **In-screen snackbar** (`local-payments.tsx`): Shows success/info/error messages during active BLE sessions. Tap to dismiss, no auto-timeout.
- **Global snackbar** (`_layout.tsx`): Shows notifications for payments processed in the background (e.g. on app open after receiving offline). Visible regardless of which screen the user is on.

## File Reference

### New Files

| File                                   | Purpose                                                                                                     |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `utils/ble/constants.ts`               | GATT UUIDs, chunk protocol flags, timeouts, PeerPay constants                                               |
| `utils/ble/types.ts`                   | `TransferState`, `BLEPaymentPayload`, `PeerDisplayIdentity`, `ChunkMetadata`                                |
| `utils/ble/chunking.ts`                | CRC32, `chunkPayload()`, `ChunkReassembler`, ACK builders, hex/base64 conversions                           |
| `utils/ble/peripheral.ts`              | `setupAndAdvertise()`, `processIncomingChunk()`, `teardownPeripheral()` (munim-bluetooth, lazy-loaded)      |
| `utils/ble/central.ts`                 | `extractIdentityKeyFromDevice()`, scanning helpers (partially superseded by direct ble-plx usage in screen) |
| `utils/ble/pendingPayments.ts`         | `savePendingPayment()`, `processPendingPayments()`, `getUnprocessedPayments()`                              |
| `hooks/useBLETransfer.ts`              | Orchestration hook (may be unused -- screen manages state directly)                                         |
| `patches/munim-bluetooth+0.3.24.patch` | iOS `didReceiveWrite` delegate, iOS/Android event emission, Android scan filter fix                         |

### Modified Files

| File                            | Changes                                                                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `app.json`                      | BLE permissions (iOS plist + Android manifest), `react-native-ble-plx` plugin config                                             |
| `app/_layout.tsx`               | Registered `local-payments` screen, `BLENotificationSnackbar` component                                                          |
| `app/settings.tsx`              | "Local Payments" menu row with bluetooth icon                                                                                    |
| `app/local-payments.tsx`        | Main screen (~600 lines). Role select, scan, identity resolution, amount entry, chunked transfer, auto-internalization, snackbar |
| `context/WalletContext.tsx`     | Background pending payment processing on wallet build + connectivity restore, `bleNotification` context field                    |
| `context/i18n/translations.tsx` | 21 new translation keys across 10 languages                                                                                      |
| `package.json`                  | `munim-bluetooth`, `react-native-nitro-modules`, `react-native-ble-plx`, `@react-native-community/netinfo`, `patch-package`      |

## Native Dependencies

This feature introduces native code that requires a **full native rebuild** (not just a Metro restart). The following native dependencies are involved:

| Dependency                        | iOS                     | Android                    | Purpose                     |
| --------------------------------- | ----------------------- | -------------------------- | --------------------------- |
| `munim-bluetooth`                 | CoreBluetooth (patched) | Android BLE APIs (patched) | Peripheral mode             |
| `react-native-ble-plx`            | CoreBluetooth           | Android BLE APIs           | Central mode                |
| `react-native-nitro-modules`      | C++ bridge              | JNI bridge                 | Runtime for munim-bluetooth |
| `@react-native-community/netinfo` | SystemConfiguration     | ConnectivityManager        | Online/offline detection    |

### Rebuild Commands

```bash
# iOS
npx expo prebuild --platform ios --clean
npx expo run:ios --device

# Android
npx expo prebuild --platform android --clean
npx expo run:android --device
```

The `--clean` flag ensures the native projects are regenerated from scratch, picking up all new native modules and the `patch-package` postinstall patches.

**When is a rebuild needed?**

- After adding/removing any native dependency (`npm install` of a package with native code)
- After modifying `patches/munim-bluetooth+0.3.24.patch`
- After changing `app.json` plugin config (e.g. BLE permissions)

**When is a rebuild NOT needed?**

- Changes to JS/TS files only (Metro hot-reload is sufficient)
- Changes to translations, styles, or React component logic

## Platform-Specific Notes

### iOS

- `CBPeripheralManager` only allows `localName` and `serviceUUIDs` in advertising packets. `manufacturerData` is silently dropped. The device's hardware Bluetooth name appears instead of any custom `localName`.
- After a BLE connect/disconnect cycle, iOS may assign a new `CBPeripheral` UUID to the same physical device. The sender deduplicates by identity key (not device ID) to handle this.
- The `munim-bluetooth` patch adds `peripheralManager(_:didReceiveWrite:)` delegate handling and `characteristicValueChanged` event emission on iOS.

### Android

- `munim-bluetooth`'s `startScan()` was patched to pass `null` instead of `emptyList()` for unfiltered scans, as Android BLE requires `null` to scan without a UUID filter.
- `setServices()` on Android can create duplicate GATT service instances. The sender walks all service instances to find the identity characteristic.
- Android 12+ requires runtime permissions: `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT`, `BLUETOOTH_ADVERTISE`.
- `munim-bluetooth`'s native module is loaded lazily (via `require()` at first use) instead of statically. A static import caused Hermes bytecode compilation to evaluate the module graph in an order that broke `@bsv/sdk` class definitions ("Cannot read property 'prototype' of undefined").
- `ble-plx` returns characteristic values as base64. Identity key decoding: `atob(base64) -> raw bytes -> hex string` (66 chars).

### Both Platforms

- The first scan after `BleManager` creation may encounter the Bluetooth adapter in `Unknown` state. The code waits for `PoweredOn` via `onStateChange()` before scanning, with a 6-second timeout.
- `react-native-ble-plx` normalises UUIDs to lowercase internally; comparisons use `.toLowerCase().includes(...)`.

## Known Limitations

- **No encryption**: The BLE transfer is unencrypted. A future enhancement could add ECDH key exchange via the `@bsv/sdk` `Peer` class.
- **No automatic role switching**: Users must manually choose Send or Receive. A future version could allow both roles simultaneously.
- **Single transfer per session**: After a transfer completes, the user returns to role selection. Batch transfers are not supported.
- **Range**: BLE effective range is typically 5-15 metres depending on device hardware and environment.
