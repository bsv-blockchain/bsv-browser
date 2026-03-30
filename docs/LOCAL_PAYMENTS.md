# Local Payments (BLE P2P Transfer)

## Overview

Local Payments enables peer-to-peer BSV transfers between two nearby phones over Bluetooth Low Energy (BLE). One phone advertises as a **receiver** (peripheral mode), the other discovers and connects as a **sender** (central mode). The payment uses the same `createAction` / `internalizeAction` BEEF transaction format as the existing PeerPay flow, but the transaction data is chunked and transferred over BLE instead of MessageBox.

The feature is accessible from **Settings > Local Payments** in the wallet drawer.

## Current Status

### Working

- **iOS sender → Android receiver**: Full end-to-end flow works — scan, identity read, identity resolution, amount entry, transaction build, chunked BLE transfer, reassembly, and internalization.
- **Persistence & auto-internalization**: Received payments are persisted to SQLite before internalization. If the device is offline, payments queue and auto-internalize when connectivity returns or on next app open.
- **Global snackbar notifications**: Background-processed payments show a notification regardless of which screen the user is on.
- **BLE permissions**: Requested once on screen open (permission gate phase), not repeatedly per action.
- **Lazy native module loading**: `munim-bluetooth` is loaded via `require()` at first use, preventing Android/Hermes module graph crashes.
- **MTU negotiation**: Sender negotiates MTU after connecting. On Android, explicit `requestMTU(512)`. On iOS, reads `device.mtu` with a 185-byte floor. Chunk sizes adapt to the negotiated MTU.

### Broken — Android Sender → iOS Receiver

**Symptom**: Android finds the iOS peripheral via BLE scan, connects successfully, but `discoverAllServicesAndCharacteristics()` from `react-native-ble-plx` hangs indefinitely. After ~13 seconds the iOS peripheral drops the connection (BLE supervision timeout) or ble-plx reports "Operation timed out".

**Current mitigation**: An 8-second timeout on `discoverAllServicesAndCharacteristics` triggers a fallback path that attempts `readCharacteristicForDevice` directly by known UUIDs. This fallback has not yet been confirmed working.

**What's been tried** (none of these fixed the Android→iOS service discovery hang):

- `refreshGatt: 'OnConnected'` connection option on Android
- Stopping the scan before connecting (to free the BLE radio)
- Retrying the connection after failure
- Timeout + fallback to direct characteristic read
- Various combinations of the above

**What hasn't been tried yet**:

- Checking the `[BLE-DIAG]` native iOS logs (Xcode console) to see if the iOS side even sees the connection and service discovery request from Android
- Using `munim-bluetooth` for central mode on Android instead of `react-native-ble-plx` (munim-bluetooth's Android central implementation does work)
- Testing with a different Android device to rule out device-specific BLE stack bugs
- Adding a `didReceiveRead` delegate to the `PeripheralManagerDelegateProxy` (this was added in the latest diagnostic patch but hasn't been tested yet — it may fix the issue if iOS needs an explicit read handler for the identity characteristic)

**Root cause hypothesis**: The iOS `CBPeripheralManager` GATT server may not be responding to Android's service discovery requests. This could be because:

1. The GATT service wasn't fully registered by the time Android connects (race condition between `setServices` + `startAdvertising` and Android's scan + connect)
2. A `CBPeripheralManager` configuration issue prevents iOS from responding to the Android BLE stack's specific service discovery format
3. The identity characteristic's static value (set via `CBMutableCharacteristic(value: data)`) may not be accessible to Android centrals without an explicit `didReceiveRead` delegate handler

The diagnostic patch (`[BLE-DIAG]` log prefix) is currently active and includes:

- Detailed logging for all `PeripheralManagerDelegateProxy` callbacks
- A `didReceiveRead` handler that explicitly serves reads from cached characteristic values
- Logging for service addition success/failure
- Logging for advertising state
- Central subscribe/unsubscribe events with MTU info

### Untested

- **Receiver-side `internalizeAction`**: The auto-internalization flow is wired up but hasn't completed successfully end-to-end because the Android→iOS transfer path is blocked.
- **Offline receive + background retry**: The `NetInfo` listener and wallet-build retry in `WalletContext.tsx` are implemented but untested.

## Architecture

### Hybrid BLE Library Approach

No single React Native BLE library supports both central and peripheral roles on both platforms. We use two libraries:

| Library                    | Role            | Used for                                                                 |
| -------------------------- | --------------- | ------------------------------------------------------------------------ |
| **`munim-bluetooth`**      | Peripheral only | Advertising, GATT server, receiving characteristic writes                |
| **`react-native-ble-plx`** | Central only    | Scanning, connecting, service discovery, reading/writing characteristics |

**Why not one library?**

- `react-native-ble-plx` and `react-native-ble-manager` are both central-only — neither supports peripheral/advertising mode.
- `munim-bluetooth` supports both roles, but its iOS central implementation is severely incomplete (`discoverServices` resolves immediately with `[]`, `readCharacteristic` returns "Not implemented").
- On Android, `munim-bluetooth` central mode works but has scanning bugs (empty `serviceUUIDs` used `emptyList()` instead of `null`).

We patched `munim-bluetooth` via `patch-package` for the peripheral-mode gaps. The patches live in `patches/munim-bluetooth+0.3.24.patch`.

### Identity Exchange via GATT Characteristic

The receiver's identity cannot be embedded in BLE advertising data (iOS `CBPeripheralManager` blocks `manufacturerData` in peripheral ads; Android ignores custom `localName`). Instead:

1. The receiver sets up a GATT service with three characteristics:
   - **Identity** (`B5A1E003-...`): Readable, contains the receiver's 33-byte compressed public key
   - **Write** (`B5A1E001-...`): Sender writes chunked payment data here
   - **Notify** (`B5A1E002-...`): Reserved for ACK/NAK responses

2. The sender scans for the service UUID (`B5A1E000-...`), connects, reads the identity characteristic, resolves the identity via `IdentityClient`, then disconnects before the user confirms.

### Payment Format

Uses the same format as `PeerPayClient` from `@bsv/message-box-client`:

```
createAction() → BEEF transaction → serialise BLEPaymentPayload → chunk → BLE writes → reassemble → internalizeAction()
```

Protocol ID: `[2, '3241645161d8']`

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

The serialised payload is split into chunks sized to the negotiated BLE MTU:

- **Header**: 3 bytes per chunk (2-byte big-endian sequence number + 1-byte flags)
- **Chunk payload**: `min(MTU - 3 - 3, 200)` bytes per chunk (adapts to negotiated MTU)
- **Maximum total payload**: 100 KB
- **First chunk** (flag `0x02`): Carries metadata — total byte count, total chunk count, CRC32 checksum
- **Intermediate chunks** (flag `0x00`): Sequential data
- **Final chunk** (flag `0x01`): Last data chunk; receiver verifies CRC32 after reassembly

`chunkPayload()` accepts an optional `payloadSizePerChunk` parameter. The sender computes this from the negotiated MTU.

### Write Mode

The sender uses platform-specific write modes:

- **iOS sender**: `writeCharacteristicWithResponseForService` (acknowledged writes, 30ms pacing)
- **Android sender**: `writeCharacteristicWithoutResponseForService` (unacknowledged writes, 100ms pacing)

Android's `writeWithResponse` to an iOS peripheral hangs on some BLE stacks — the ble-plx Promise never resolves. `writeWithoutResponse` with pacing delays works reliably.

## UX Flow

```
                    SENDER                              RECEIVER
                    ------                              --------
[Permission gate: Bluetooth access requested on screen open]

                                                   1. Tap "Request Payment"
                                                   2. Wait for BT powered on
                                                   3. GATT service created
                                                   4. Advertising starts
                                                   5. Waiting for sender...

1. Tap "Send Payment"
2. Scan for BSV_PAYMENT_SERVICE_UUID
3. Device found → connect
4. Discover services + read identity char
5. Resolve identity via IdentityClient (5s timeout)
6. Disconnect
7. Show receiver identity card
8. Select receiver
9. Enter amount
10. Tap "Send"
11. createAction() builds TX
12. Connect to receiver, negotiate MTU
13. Serialise + chunk payload (MTU-aware)
14. Write chunks sequentially             →    Receive chunks
15. Wait for processing                        Reassemble + verify CRC32
                                               Persist to pending queue
                                               Attempt internalizeAction()
16. "Payment Sent" screen                      "Payment Received" screen
                                               Snackbar: success or saved
```

## Persistence and Auto-Internalization

Received payments are **persisted before internalization** to guard against data loss.

### Storage

Pending payments are stored in the wallet's `key_value_store` SQLite table under the key `ble_pending_payments`. Each entry includes the full `BLEPaymentPayload`, status tracking, and timestamps.

Statuses: `pending` | `processing` | `completed` | `failed`

### Auto-Internalization Triggers

1. **Immediately on receive**: After BLE transfer completes, payload is persisted, then `processPendingPayments()` is called if online.
2. **On wallet build**: When the wallet finishes building on subsequent app opens (`WalletContext.tsx`), unprocessed payments are internalized.
3. **On connectivity restored**: A `NetInfo` listener in `WalletContext.tsx` triggers `processPendingPayments()` when the device transitions from offline to online.

### Notification System

- **In-screen snackbar** (`local-payments.tsx`): Shows success/info/error messages during active sessions. Tap to dismiss.
- **Global snackbar** (`_layout.tsx`): Shows notifications for payments processed in the background. Reads `bleNotification` from `WalletContext`.

## File Reference

### New Files

| File                                   | Purpose                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `utils/ble/constants.ts`               | GATT UUIDs, chunk protocol flags, timeouts, PeerPay constants                                                 |
| `utils/ble/types.ts`                   | `TransferState`, `BLEPaymentPayload`, `PeerDisplayIdentity`, `ChunkMetadata`                                  |
| `utils/ble/chunking.ts`                | CRC32, `chunkPayload()`, `ChunkReassembler`, ACK builders, hex/base64 conversions                             |
| `utils/ble/peripheral.ts`              | `processIncomingChunk()`, `teardownPeripheral()` (munim-bluetooth, lazy-loaded via `require()`)               |
| `utils/ble/central.ts`                 | `extractIdentityKeyFromDevice()`, scanning helpers (partially superseded by direct ble-plx usage in screen)   |
| `utils/ble/pendingPayments.ts`         | `savePendingPayment()`, `processPendingPayments()`, `getUnprocessedPayments()`, `updatePaymentStatus()`       |
| `hooks/useBLETransfer.ts`              | Orchestration hook (unused — screen manages state directly, candidate for removal)                            |
| `patches/munim-bluetooth+0.3.24.patch` | iOS `didReceiveWrite`/`didReceiveRead` delegates, event emission, Android scan filter fix, diagnostic logging |

### Modified Files

| File                            | Changes                                                                                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.json`                      | BLE permissions (iOS plist + Android manifest), `react-native-ble-plx` plugin config                                                                           |
| `app/_layout.tsx`               | Registered `local-payments` screen, `BLENotificationSnackbar` component                                                                                        |
| `app/settings.tsx`              | "Local Payments" menu row with bluetooth icon                                                                                                                  |
| `app/local-payments.tsx`        | Main screen (~700 lines). Permission gate, role select, scan, identity resolution, amount entry, chunked transfer, auto-internalization, snackbar, debug panel |
| `context/WalletContext.tsx`     | Background pending payment processing on wallet build + connectivity restore, `bleNotification`/`clearBleNotification` context fields, `NetInfo` listener      |
| `context/i18n/translations.tsx` | 21 new translation keys across 10 languages                                                                                                                    |
| `package.json`                  | `munim-bluetooth`, `react-native-nitro-modules`, `react-native-ble-plx`, `@react-native-community/netinfo`, `patch-package`                                    |

## Native Dependencies & Rebuilds

| Dependency                        | iOS                     | Android                    | Purpose                     |
| --------------------------------- | ----------------------- | -------------------------- | --------------------------- |
| `munim-bluetooth`                 | CoreBluetooth (patched) | Android BLE APIs (patched) | Peripheral mode             |
| `react-native-ble-plx`            | CoreBluetooth           | Android BLE APIs           | Central mode                |
| `react-native-nitro-modules`      | C++ bridge              | JNI bridge                 | Runtime for munim-bluetooth |
| `@react-native-community/netinfo` | SystemConfiguration     | ConnectivityManager        | Online/offline detection    |

### Rebuild Commands

```bash
# Both platforms
npx expo prebuild --clean
npx expo run:ios --device
npx expo run:android --device

# Single platform
npx expo prebuild --platform ios --clean && npx expo run:ios --device
npx expo prebuild --platform android --clean && npx expo run:android --device
```

`--clean` ensures native projects are regenerated from scratch, picking up `patch-package` postinstall patches.

**Rebuild needed when**: native dependency added/removed, `patches/` modified, `app.json` plugin config changed.

**Rebuild NOT needed when**: JS/TS-only changes (Metro hot reload sufficient).

## The `munim-bluetooth` Patch

The patch (`patches/munim-bluetooth+0.3.24.patch`) modifies both iOS and Android native code.

### iOS Changes

**`PeripheralManagerDelegateProxy`** — added delegate methods:

- `peripheralManager(_:didReceiveWrite:)` → forwards to `handlePeripheralManagerDidReceiveWrite`
- `peripheralManager(_:didReceiveRead:)` → serves reads from characteristic's cached value (diagnostic build)
- `peripheralManager(_:central:didSubscribeTo:)` → logs subscription + central MTU (diagnostic build)

**`handlePeripheralManagerDidReceiveWrite`**: Processes write requests, converts data to hex, emits `characteristicValueChanged` event to JS. Updates `mutableChar.value` and responds to each request with `.success`.

**`handlePeripheralDidUpdateValue`**: Emits `characteristicValueChanged` event for central-mode characteristic notifications.

**`MunimBluetoothEventEmitter`**: Added `emitCharacteristicValueChanged` method.

**Diagnostic logging** (current build): All `PeripheralManagerDelegateProxy` methods log with `[BLE-DIAG]` prefix. `setServices` logs characteristic details. Service addition success/failure logged.

### Android Changes

**Scan filter fix**: `startScan()` with empty `serviceUUIDs` now passes `null` instead of `emptyList()`. Android requires `null` for unfiltered scans.

**Write event emission**: `onCharacteristicWriteRequest` callback emits `characteristicValueChanged` event with hex-encoded value, service UUID, characteristic UUID, and device address.

### Important Notes on the Patch

- **Do NOT regenerate the patch with `npx patch-package munim-bluetooth`** unless you're certain `node_modules/munim-bluetooth` only contains the changes you want. Previous regeneration accidentally included central-mode rewrites (discoverServices, readCharacteristic, writeCharacteristic with async delegate handling) that broke Android→iOS connections. The central-mode code in `munim-bluetooth` is intentionally left as-is (broken stubs) because we use `react-native-ble-plx` for all central operations.
- The safe workflow: edit the `.patch` file directly, or make targeted edits to `node_modules` then regenerate, but verify the diff before committing.

## Platform-Specific Notes

### iOS

- `CBPeripheralManager` only allows `localName` and `serviceUUIDs` in advertising packets. `manufacturerData` is silently dropped. The device's hardware Bluetooth name appears instead of any custom `localName`.
- After a BLE connect/disconnect cycle, iOS may assign a new `CBPeripheral` UUID to the same physical device. The sender deduplicates by identity key (not device ID) to handle this.
- The `isBluetoothEnabled()` call before `setServices`/`startAdvertising` prevents a crash when `CBPeripheralManager` state is 0 (unknown/resetting).
- iOS sender uses `writeCharacteristicWithResponseForService` (acknowledged writes). This is reliable for iOS→Android transfers.

### Android

- `munim-bluetooth`'s native module is loaded lazily (via `require()` at first use in `peripheral.ts`) instead of statically. A static import caused Hermes to evaluate the module graph before `@bsv/sdk` classes finished initialising, producing "Cannot read property 'prototype' of undefined".
- Android 12+ requires runtime permissions: `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT`, `BLUETOOTH_ADVERTISE`. These are requested once on screen open.
- `ble-plx` returns characteristic values as base64. Identity key decoding: `atob(base64) → raw bytes → hex string` (66 chars).
- Android sender uses `writeCharacteristicWithoutResponseForService` with 100ms pacing. `writeWithResponse` to an iOS peripheral causes ble-plx Promises to hang on some Android BLE stacks.
- `device.mtu` after `requestMTU(512)` returns the negotiated value. Chunk sizes adapt accordingly.

### Both Platforms

- The `BleManager` from `react-native-ble-plx` is created lazily on first use and destroyed on screen unmount. The ref is set to `null` after destroy so a fresh instance is created on remount.
- `IdentityClient.resolveByIdentityKey` has a 5-second timeout via `Promise.race`. If it hangs, the receiver entry shows "Unknown" but remains tappable.
- Permissions are requested once on screen open via a `permission_gate` phase. If denied, the screen shows an error and doesn't proceed to role selection.

## Known Limitations

- **No encryption**: BLE transfer is unencrypted. Future enhancement: ECDH key exchange via `@bsv/sdk` `Peer` class.
- **No automatic role switching**: Users must manually choose Send or Receive.
- **Single transfer per session**: After completion, user returns to role selection.
- **Range**: BLE effective range is typically 5-15 metres depending on hardware and environment.
- **Android→iOS sender broken**: Service discovery hangs (see "Current Status" above).

## Next Steps

1. **Diagnose Android→iOS with native logs**: Run with the diagnostic patch and check Xcode console for `[BLE-DIAG]` lines when Android connects. This will reveal whether iOS sees the connection at all, whether service discovery requests arrive, and whether the `didReceiveRead` handler fires.
2. **Test `didReceiveRead` handler**: The diagnostic patch added an explicit read handler. If the identity characteristic was being created with `value: nil` (despite the code intending to set it), this handler will serve the read and may fix the issue.
3. **Consider `munim-bluetooth` for Android central**: Since `munim-bluetooth`'s Android central implementation works (unlike iOS), it could replace `react-native-ble-plx` on Android for the identity read step. This would bypass the ble-plx service discovery hang entirely.
4. **Remove diagnostic logging**: Once the Android→iOS issue is resolved, strip `[BLE-DIAG]` logging and regenerate the patch for production.
5. **End-to-end internalization test**: Verify the full receive → persist → internalize → snackbar flow works in both directions.
6. **Clean up unused code**: Remove `hooks/useBLETransfer.ts` and `utils/ble/central.ts` if confirmed unused.
