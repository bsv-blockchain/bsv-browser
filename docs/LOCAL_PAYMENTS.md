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
- **MTU negotiation**: On Android, auto-negotiated to 512 in munim-bluetooth after connect, emitted as `mtuChanged` event. On iOS, reads `device.mtu` from ble-plx with a 185-byte floor. Chunk sizes adapt to the negotiated MTU.

### Android Sender → iOS Receiver — Implemented Fixes (Needs Testing)

Three root-cause fixes have been implemented. A rebuild and test is required to confirm.

**Fix 1: Service-add race condition** — iOS `CBPeripheralManager.add(_:)` is asynchronous. Previously `startAdvertising()` was called immediately after `setServices()`, before `didAddService` fired. Android centrals connecting during this window found an empty GATT database. The fix: JS now waits for the `serviceAdded` event (emitted from `handlePeripheralManagerDidAddService`) before calling `startAdvertising()`, plus a 500ms stabilization delay.

**Fix 2: Dynamic identity characteristic** — Previously the identity characteristic was created with `CBMutableCharacteristic(value: data)` (static). Some Android OEM BLE stacks require an active peripheral response even for static reads. The fix: `characteristicValueCache` stores the identity key natively; the characteristic is now created with `value=nil`; all reads are served explicitly through `didReceiveRead` from the cache.

**Fix 3: Android central library switch** — `react-native-ble-plx`'s `discoverAllServicesAndCharacteristics()` hangs indefinitely on Android when connecting to an iOS peripheral. The fix: Android now uses `munim-bluetooth` for ALL central operations (scan, connect, discoverServices, readCharacteristic, writeCharacteristic). ble-plx is iOS-only.

**To verify**: Run with Xcode console open (filter `[BLE-DIAG]`). The event timeline should show:

1. `[BLE-DIAG] AddService SUCCESS` before `[BLE-DIAG] PeripheralManager didStartAdvertising`
2. `[BLE-DIAG] PeripheralManager didReceiveRead` firing when Android connects

### Untested

- **Android→iOS full transfer** (see above — fixes implemented, needs native rebuild + test)
- **Receiver-side `internalizeAction`**: The auto-internalization flow is wired up but hasn't completed successfully end-to-end.
- **Offline receive + background retry**: The `NetInfo` listener and wallet-build retry in `WalletContext.tsx` are implemented but untested.

## Architecture

### Hybrid BLE Library Approach

No single React Native BLE library supports both central and peripheral roles on both platforms. We use two libraries:

| Library                    | Platform | Role       | Used for                                                                  |
| -------------------------- | -------- | ---------- | ------------------------------------------------------------------------- |
| **`munim-bluetooth`**      | Both     | Peripheral | Advertising, GATT server, receiving characteristic writes                 |
| **`munim-bluetooth`**      | Android  | Central    | Scanning, connecting, service discovery, reading identity, writing chunks |
| **`react-native-ble-plx`** | iOS only | Central    | Scanning, connecting, service discovery, reading identity, writing chunks |

**Why two central libraries?**

- `react-native-ble-plx`'s `discoverAllServicesAndCharacteristics()` hangs indefinitely on Android when the peripheral is iOS `CBPeripheralManager`. munim-bluetooth uses the native `BluetoothGatt` API directly and does not have this issue.
- `munim-bluetooth`'s iOS central implementation is stubs (`discoverServices` resolves with `[]`, `readCharacteristic` rejects "Not implemented"). ble-plx is retained for iOS central.
- On Android, `munim-bluetooth` central mode required two patches: scan filter fix (`emptyList()` → `null`) and auto-MTU negotiation after connect.

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

- **iOS sender** (ble-plx): `writeCharacteristicWithResponseForService` (acknowledged writes, 30ms pacing)
- **Android sender** (munim-bluetooth): `writeCharacteristic` with `writeWithoutResponse` (unacknowledged writes, 100ms pacing)

Android's write-with-response to an iOS peripheral hangs on some BLE stacks. `writeWithoutResponse` with 100ms pacing is reliable.

### MTU Negotiation

- **Android**: munim-bluetooth auto-requests MTU 512 in `onConnectionStateChange` after connect. The negotiated value is emitted as a `mtuChanged` event. The JS sender awaits this event (5s timeout, falls back to 23) to determine chunk payload size.
- **iOS**: ble-plx `device.mtu` is read after `discoverAllServicesAndCharacteristics`. Floor is 185 bytes.

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
- `peripheralManager(_:didReceiveRead:)` → serves reads from `owner.characteristicValueCache` first, then falls back to `characteristic.value`
- `peripheralManager(_:central:didSubscribeTo:)` → logs subscription + central MTU
- All methods log with `[BLE-DIAG]` prefix

**`characteristicValueCache: [CBUUID: Data]`**: Class property on `HybridMunimBluetooth`. Populated by `setServices` for read-only characteristics. `setServices` creates `CBMutableCharacteristic` with `value=nil` for all read-only chars so that CoreBluetooth routes all reads through `didReceiveRead`. The cache entry provides the actual identity bytes.

**`handlePeripheralManagerDidAddService`**: Emits `serviceAdded` JS event when service registration succeeds. JS receiver waits for this event before calling `startAdvertising()`.

**`handlePeripheralManagerDidReceiveWrite`**: Processes write requests, converts data to hex, emits `characteristicValueChanged` event to JS. Updates `mutableChar.value` and responds with `.success`.

**`MunimBluetoothEventEmitter`**: Added `emitCharacteristicValueChanged` and `emitServiceAdded` methods. `"serviceAdded"` added to `supportedEvents()`.

### Android Changes

**Scan filter fix**: `startScan()` with empty `serviceUUIDs` now passes `null` instead of `emptyList()`. Android requires `null` for unfiltered scans.

**Write event emission**: `onCharacteristicWriteRequest` callback emits `characteristicValueChanged` event with hex-encoded value, service UUID, characteristic UUID, and device address.

**Auto-MTU negotiation**: After `onConnectionStateChange` → `STATE_CONNECTED`, automatically calls `gatt.requestMtu(512)`. The `onMtuChanged` callback emits a `mtuChanged` event with `{ deviceId, mtu }`. JS listens for this event to get the negotiated MTU value for chunk sizing. `pendingMtuRequests` map handles cleanup on disconnect.

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

1. **Native rebuild + test Android→iOS**: `npx expo prebuild --clean && npx expo run:ios --device && npx expo run:android --device`. Check Xcode console `[BLE-DIAG]` logs when Android connects. The event order `AddService SUCCESS` → `startAdvertising` → `didReceiveRead` should now be observed.
2. **Run Transport Test A** (identity-only): Tap the debug icon (top-right), then `A: Identity Read`. This exercises only the GATT read path without wallet code. Should return a 33-byte identity hex.
3. **Run Transport Test B+C**: Once A passes, run `B: Write 16B` and `C: 1KB Chunked` to validate the full transfer path.
4. **End-to-end internalization test**: Verify the full receive → persist → internalize → snackbar flow works in both directions.
5. **Remove diagnostic logging**: Once Android→iOS is confirmed stable, strip `[BLE-DIAG]` logging from the patch for production.
6. **Implement notify ACK/NAK protocol**: Use the reserved notify characteristic for receiver-side acknowledgements (ACK_RECEIVED / ACK_PERSISTED / NAK_CRC). This turns the transfer from fire-and-forget to a proper transport.
7. **QR identity bootstrap fallback**: If GATT identity read remains flaky on certain device combinations, add a QR code fallback — receiver shows QR with identity key, sender scans it, then uses BLE only for payload transfer.
8. **Clean up unused code**: Remove `hooks/useBLETransfer.ts` and `utils/ble/central.ts` if confirmed unused.
