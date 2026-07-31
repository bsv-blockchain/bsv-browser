# Offline Transport Fixes — Design

**Date:** 2026-07-29
**Status:** Approved
**Scope:** the nearby rail only. Builds on the shipped 2026-07-28 offline
nearby payments work (`docs/superpowers/specs/2026-07-28-offline-nearby-payments-design.md`).
Handle and address rails stay online-only.

## The reported failures, and their verified causes

Device testing of the current branch found four behaviours. Each was traced to
code on 2026-07-29; every claim below is cited.

1. **A payer's transactions sit at `nosend` long after Wi-Fi returns.** Two
   independent causes:
   - **The QR send path never enqueues.** When `sendKind === 'qr'`,
     `executeSend` renders the payment QR and returns *before*
     `finalizeDelivery` (`components/pay/NearbyFlow.tsx:995-1008`); the
     AWDL-failure→QR fallback does the same (`:1010-1028`). No
     `offline_actions` row is ever written, and the release drain reads *only*
     `offline_actions` rows in `'queued'`/`'posting'`
     (`storage/methods/processOfflineActions.ts:77-78`). The transaction is
     invisible to every broadcast mechanism forever: `TaskSendWaiting` selects
     `unsent`/`sending`, and `TaskCheckNoSends` never sends
     (documented at `utils/localpay/build.ts:326-335`).
   - **The release trigger is one-shot with no retry.**
     `TaskSendOffline.checkNow` is cleared *before* the drain runs
     (`utils/monitor/TaskSendOffline.ts:31`), and its only setter is the
     reconnect listener (`context/WalletContext.tsx:1530-1535` — the comment at
     `TaskSendOffline.ts:16` claims a manual control that does not exist). If
     the first drain after reconnect hits a `serviceError` (likely during radio
     warm-up), or its own probe still reads `isInternetReachable === false`
     (NetInfo reachability lags reconnect), the run stops silently
     (`processOfflineActions.ts:80-83`, zero-progress runs return `''` at
     `TaskSendOffline.ts:34`) and nothing ever re-arms. One `serviceError`
     anywhere also stops the whole run, requeueing independent transactions
     behind it (`utils/offline/plan.ts:83`, `processOfflineActions.ts:185-195`).

2. **Android refuses to generate a QR for a large transaction.** The payment
   frame carries full AtomicBEEF (`utils/localpay/codec.ts:18-24`,
   `build.ts:74-77`) and the QR ceiling is `MAX_FRAME_QR_CHARS = 2200` chars ≈
   1,643 frame bytes (`codec.ts:156`, calibrated against
   react-native-qrcode-svg's measured throw point: 2,276 encodes, 2,343 throws,
   `codec.ts:139-150`). Oversize on a QR-only pair aborts the build with
   `local_pay_too_large` (`NearbyFlow.tsx:995-1004`). There is no chunking,
   animation, or fountain support anywhere in the codebase.

3. **Android↔Android is QR-only in both directions.** The transport package's
   only native implementation is iOS Swift AWDL
   (`packages/react-native-localpay-transport` — Nitro spec binds
   `{ ios: 'swift' }` at `src/specs/LocalPayTransport.nitro.ts:3`; no `android/`
   sources exist; `getLocalPayTransport()` returns null off-iOS,
   `src/index.ts:12-22`). Google Nearby Connections appears nowhere in the
   repo. Android↔iOS is additionally dead for any non-trivial transaction
   because of the QR ceiling above — AWDL is Apple-proprietary, so a
   cross-OS pair has no radio path even in principle.

4. **Offline-held transactions are indistinguishable in the transactions
   screen.** A held transaction renders the same green "Accepted" badge as a
   genuinely broadcast `unproven` one (`app/transactions.tsx:32-43`; receive
   holds leave the transaction at `unproven`,
   `storage/StorageExpoSQLite.ts:1410-1417`; payer holds promote to `unproven`,
   `utils/offline/payerHold.ts:78-79`). If the payer promotion failed, the row
   renders identical to a deliberate `noSend` awaiting signature. The
   authoritative held-state signal — the `offline_actions` table
   (`storage/methods/offlineActions.ts:7-23`) — is read by `/pay`
   (`app/pay.tsx:119`) but never by the transactions screen.

## Decisions locked during brainstorming

- **Fountain codec:** custom Luby-transform port on our own frame format, no
  new dependencies. Not BC-UR (interop with nothing we talk to), not
  sequential chunks (stalls on any missed frame).
- **Drain retry:** periodic while the queue is non-empty **and the device is
  online** — 10 s base, exponential backoff — plus a manual "Send now"
  control. Rationale: users won't keep the app open long; once network exists
  the first attempt almost always succeeds, so a short initial gap is safe.
- **Android transport:** Google Nearby Connections, accepting the GMS
  dependency and the runtime-permission set. GMS-less devices fall back to QR
  fountain.

## Part I — Transport ladder and session payload

### Session QR stays v1, gains two fields

The pairing payload (`bsvpay1:` + base64url JSON, `utils/localpay/session.ts:81-96`)
keeps `v: 1`. JSON decoding ignores unknown keys, and the capability check is a
bitmask test (`select.ts:15-18`), so both additions are backwards compatible
with already-shipped builds:

- **`CAP_NEARBY = 0x02`** joins `CAP_AWDL = 0x01` in the existing `c` bitmask
  (`session.ts:5`). A payee mints every cap its device supports at that moment
  (`session.ts:47`, `NearbyFlow.tsx:813-821`).
- **`o: 'ios' | 'android'`** — the operating system of the minting device.
  Metadata only: UX copy and diagnostics. Transport selection is driven by
  caps, which state what the device can actually *do*; the OS field must never
  enter `selectTransport`.

The plan must verify `decodeSession` tolerates unknown keys and added bits
(it should — bitmask + JSON — but this is the compatibility hinge).

### The ladder

`selectTransport` (`utils/localpay/transport/select.ts`) grows from a binary
AWDL-or-QR decision to:

1. session advertises `CAP_AWDL` ∧ `localSupportsAwdl()` → **`'awdl'`**
   (iOS↔iOS, unchanged, including the native probe at
   `HybridLocalPayTransport.swift:93-103`);
2. session advertises `CAP_NEARBY` ∧ `localSupportsNearby()` → **`'nearby'`**
   (Android↔Android);
3. otherwise → **`'qr'`** — static `bsvpayf1:` when the frame fits, fountain
   `bsvpayf2:` when it does not.

Cross-OS pairs land on rung 3 by construction. QR is also the terminal
fallback *at send time*: a radio dial failure or timeout drops automatically to
rendering the QR — no button press, no 20-second wait. The AWDL connect phase
gets a short (~4 s) timeout distinct from the overall
`SEND_TIMEOUT_MS = 20_000` (`utils/localpay/transport/awdl.ts:13`), so an iOS
device with its Wi-Fi radio off reaches the QR within seconds. The payee side
already degrades non-fatally when its listener fails
(`NearbyFlow.tsx:771-778`); Nearby advertising failure follows the same
pattern. The existing hold/abort money semantics of the fallback are unchanged
— only the trigger becomes automatic.

## Part II — Reconnect drain fixes and transaction badges

### Done becomes a real delivery decision (the stuck-payer fix)

Today the payer's Done button on the shown payment QR deliberately does
nothing (`NearbyFlow.tsx:1587-1605`): no broadcast, no abort, no queue row.
That is the dead end. New semantics — Done routes through the same
`finalizeDelivery` the AWDL ack path uses (`build.ts:263-346`):

- **Done, online** → positive-ack path → broadcast now.
- **Done, offline** → the existing hold path (`build.ts:306-323` →
  `holdSentPaymentOffline`, `payerHold.ts:58-80`): `offline_actions` row with
  `role = 'sent'`, transaction promoted to `unproven`, drained on reconnect.
- **Cancel** → decline path → abort the build, release the inputs (unchanged).

Broadcasting a frame the payee never scanned is safe *provided the QR can be
shown again*: a payee scanning after broadcast internalizes normally (the
forced broadcast finds the txid already in the mempool, which
`arcadeBroadcastProvider` already treats as success). To guarantee re-show
across app restarts, the frame bytes are persisted in a new **nullable
`framePayload` column on `offline_actions`**, written on the QR-path hold and
surfaced as a "show code again" affordance on the queued row. The AWDL-failure
fallback path gets the same Done/Cancel treatment, which closes the second
never-enqueued hole (`NearbyFlow.tsx:1010-1028`).

**Migration note:** `createTables.ts` is `CREATE TABLE IF NOT EXISTS` only,
which cannot add a column to existing installs. The column lands via a guarded
`ALTER TABLE` (check `PRAGMA table_info(offline_actions)` first) run in the
same migrate step. This is the first post-ship schema change to the table, so
the pattern set here is the pattern the table lives with.

### Retry machinery

`TaskSendOffline` keeps `checkNow` and gains a periodic trigger:

- fires when `checkNow`, **or** when the queue is believed non-empty ∧ the
  cached online flag is true ∧ `now ≥ nextDueAt`;
- backoff: 10 s base, doubling per zero-progress run, capped at 5 min;
- backoff resets on: an offline→online transition, a new enqueue, and the
  manual control;
- **"Send now"** button on the `/pay` offline notice
  (`components/pay/OfflineNotice.tsx`) sets `checkNow` and resets backoff —
  making the comment at `TaskSendOffline.ts:16` true at last;
- app foreground-resume sets `checkNow` when the queue is non-empty (the
  current resume handler never does, `WalletContext.tsx:1538-1556`) —
  belt-and-braces for NetInfo events missed while backgrounded.

"Queue believed non-empty" is a cheap static signal maintained by the enqueue
helpers and corrected by each drain (a drain that finds zero rows clears it);
the online flag is maintained by the existing `subscribeOnline` listener. The
monitor already ticks every 5 s (`Monitor.js` `taskRunWaitMsecs`), so a 10 s
period needs no monitor changes. This mirrors the periodic fallback already
patched in for `TaskCheckForProofs` (`WalletContext.tsx:959-971`).

### Failure isolation

`planRelease` outcomes change from run-global to per-root: a `serviceError` or
stall on one transaction stops **only its own subtree** (descendants requeue
with it); independent roots continue posting in the same run. The
children-first cascade ordering rules from the 2026-07-28 spec are untouched.
`stalledOn` — today a log string nobody reads
(`processOfflineActions.ts:53-56`) — surfaces on the offline notice row so a
permanently stuck ancestor is visible instead of silently blocking.

### Transaction badges

`app/transactions.tsx` already holds `storage` (`:50`) and re-fetches on
`txStatusVersion` (`:84`). In `fetchActions`, additionally call
`findOfflineActions(storage.sqliteDb, { status: ['queued','posting','rejected'], userId })`
(`offlineActions.ts:70-87` — note `app/pay.tsx:119` omits `userId` today; both
call sites become userId-scoped), build a txid→row map, and let it override
`getStatusInfo`:

| queue state | badge | colour |
| --- | --- | --- |
| `queued` | "Offline · queued" | info (new, distinct from green/warning) |
| `posting` | "Offline · sending" | info |
| `rejected` | "Offline · rejected" + reason | error |

`sent` rows are excluded — a settled transaction must show its normal status.
The override wins over the raw `nosend`/`unproven` rendering, which also fixes
the failed-payer-promotion edge (held tx stuck at `nosend`) rendering as
"Not sent". The drain bumps `txStatusVersion` when it moves rows so badges
clear without a manual refresh (the setter wiring is verified in the plan; the
reader could not confirm it exists). New strings land in all five locales in
`context/i18n/translations.tsx`. No toolbox labels are involved: the
`localpay` label marks the rail and survives the drain, so it cannot carry
held state; the queue table is the live signal.

## Part III — QR fountain

### Wire format

Single-frame payments are untouched: `bsvpayf1:` + base64url(frame), guarded
by `frameQrOrNull` (`NearbyFlow.tsx:244-251`). When `frameToQr` exceeds
`MAX_FRAME_QR_CHARS`, the sender emits **`bsvpayf2:`** parts instead of
aborting:

```
bsvpayf2: + base64url( header ‖ payload )
header  = seq u32 ‖ K u16 ‖ msgLen u32 ‖ crc32 u32   (14 bytes)
payload = XOR of the source blocks selected by seed(seq)
```

The message (the exact `bsvpayf1` frame bytes) is split into K fixed-size
blocks of **1,200 bytes** (last block zero-padded; `msgLen` recovers the true
length). A part is then 1,214 bytes → ~1,620 base64url chars + 9-char prefix ≈
**1,630 chars**, comfortably under the 2,200 ceiling with margin for the
library's measured throw point. `crc32` is over the whole message and is
implemented locally (~30 lines) — no dependency.

### Codec

`utils/localpay/fountain.ts`, pure TypeScript, no platform imports:

- **Encoder:** for `seq < K`, part = block `seq` verbatim (systematic prefix —
  a receiver that catches one clean cycle decodes with zero overhead). For
  `seq ≥ K`, an xorshift RNG seeded by `seq` draws a degree from a
  robust-soliton table and selects that many distinct blocks to XOR. The
  encoder is an infinite generator; parts are computed lazily.
- **Decoder:** standard peeling. Degree-1 parts fill blocks directly; each
  arriving part is XOR-reduced against known blocks, and each newly solved
  block re-reduces pending parts. Progress = solved/K. On K solved: trim to
  `msgLen`, check crc32 — mismatch discards the assembly and keeps collecting
  (never crashes the scanner). Decoder state is keyed to `(K, msgLen, crc32)`
  and resets when they change or the session changes.

Both halves are deterministic given `seq`, so encoder and decoder are testable
against each other in jest with lossy, duplicated, and out-of-order part
streams. Sanity ceiling: a message above 64 KB still refuses with a clear
message — at that size QR transfer time is unreasonable and something upstream
is wrong (the air-gap payload target is ~400 bytes).

### Sender UI

`executeSend`'s too-large abort (`NearbyFlow.tsx:995-1004`) is replaced by the
animated renderer: a timer advances `seq` at **~5 fps** through the lazy
encoder, rendering each part in the existing `<QRCode ecl="M">` element (the
`onError` backstops stay). Copy: "Keep the camera pointed — animated code."
The same renderer serves the AWDL/Nearby failure fallback, so iOS with radios
off animates when necessary. Done/Cancel semantics from Part II apply
identically — the fountain is still the QR transport, one-way, no ack; the
`Unsettled` retry mechanics (`NearbyFlow.tsx:189-199`) carry over. For
re-show-after-restart, `framePayload` stores the message bytes; the fountain
re-encodes from them.

### Receiver

`components/QRScanner.tsx` gains a continuous mode used when a `bsvpayf2:`
part is recognised: the 1,500 ms re-arm lock (`SCAN_LOCK_DELAY_MS`,
`QRScanner.tsx:27,67-75`) is bypassed for parts (dedupe by `seq`), and the
existing `renderBottom` hook (`:32`, currently unused by NearbyFlow) shows
"n / K blocks". Static `bsvpayf1:` scans and all other QR kinds keep today's
behaviour. On completion the assembled bytes enter `frameFromQr` →
`settleReceived` exactly as a static scan (`NearbyFlow.tsx:832-854`) — the
money path is unchanged and needs no new tests beyond the assembly boundary.

## Part IV — Android Nearby Connections

### Native module

`packages/react-native-localpay-transport` grows a Kotlin backend beside the
Swift one: the Nitro spec widens to `{ ios: 'swift', android: 'kotlin' }`
(`LocalPayTransport.nitro.ts:3`), and `nitro.json` gains the android
autolinking entry (the `androidNamespace`/`androidCxxLibName` scaffolding
already sits there unfilled). The TS surface — `isSupported()`, listen,
send, `confirmFrame(accepted, reason)` — is identical across platforms, so
`NearbyFlow`'s ack machinery (`ConfirmDelivery`, `types.ts:43-61`; typed
`DeclineReason`, `types.ts:22-41`) runs verbatim over Nearby. The dependency
is `com.google.android.gms:play-services-nearby`.

### Protocol mapping

- **Roles:** payee **advertises**, payer **discovers** — mirroring the AWDL
  listener/dialer split.
- **Strategy:** `P2P_POINT_TO_POINT` (1:1, highest bandwidth; payments are
  strictly pairwise).
- **Addressing:** fixed app-level serviceId; per-session discrimination via
  `endpointInfo = instanceName` — the existing `bsvpay-<base32(sessionId)>`
  naming (`session.ts:145-159`) reused unchanged. The payer connects only to
  the endpoint whose info matches its scanned session.
- **Session binding:** Nearby encrypts its link but knows nothing of our
  pairing. First payload in each direction is
  `HMAC-SHA256(psk, sessionId ‖ roleByte)` — the role byte prevents
  reflection. Wrong or missing proof → disconnect, payee stays advertising.
  Only then do the payment frame and ack payloads flow. Nearby's own payload
  framing replaces AWDL's 4-byte length prefix; the 8 MiB sanity cap carries
  over as an app-level check.
- **Timeouts:** discovery+connect budget ~4 s before the automatic QR
  fallback, matching the iOS dial budget; ack confirm window mirrors the AWDL
  60 s (`HybridLocalPayTransport.swift:64`).

### Permissions and capability

`localSupportsNearby()` = Android ∧ GMS available (GoogleApiAvailability) —
cached like `supportsAwdl`. The runtime set (`BLUETOOTH_ADVERTISE`,
`BLUETOOTH_CONNECT`, `BLUETOOTH_SCAN`, `NEARBY_WIFI_DEVICES` on API 33+, fine
location on ≤ API 30, plus manifest entries) is requested lazily on entering
the nearby flow. Deny → the payee mints without `CAP_NEARBY` / the payer's
ladder falls to QR; no error state, no nagging. GMS absent → `isSupported()`
false, same silent fallback. This satisfies the requirement that Android with
radios on but no internet uses Nearby, while a device with all radios off ends
at QR fountain — Nearby cannot advertise without radios, so the ladder's
failure fallback produces exactly that behaviour without explicit
radio-state detection.

## Error handling summary

- Every radio failure lands on the QR fountain; there is no dead end and no
  manual step on the failure path.
- Drain: per-subtree stop; `stalledOn` visible on the offline notice; a
  zero-progress run schedules the next backoff attempt instead of going
  silent.
- Fountain: CRC mismatch = keep collecting; decoder never throws into render;
  > 64 KB refuses plainly.
- Nearby: HMAC mismatch = silent disconnect + keep advertising; permission
  denial and missing GMS degrade to QR with no error surface.

## Testing

**Unit (jest, on the existing suite):**

- fountain: encode/decode roundtrip; lossy subsets (drop every 2nd, 3rd part);
  out-of-order and duplicated parts; systematic-prefix-only decode; CRC
  corruption discards and recovers; block-size boundary (exact multiple,
  1-byte remainder); 64 KB refusal;
- ladder truth table: caps × platform × local support × radio failure →
  transport, including auto-fallback transitions;
- drain: backoff schedule (10 s doubling to 5 min cap), reset events
  (reconnect, enqueue, manual), online gating, one-shot `checkNow`
  compatibility;
- failure isolation: two independent roots, one poisoned — the other posts in
  the same run; cascade ordering unchanged;
- Done/Cancel state machine: {online, offline} × {done, cancel} → broadcast /
  hold+row+framePayload / abort;
- `offline_actions` `ALTER TABLE` migration from a pre-`framePayload`
  database;
- badge mapping: queued/posting/rejected shown, `sent` excluded, userId
  scoping, override-beats-raw-status;
- session v2: decode with unknown `o` field and unknown cap bits on the old
  decoder shape.

**Device matrix:**

1. iOS↔iOS AWDL regression (existing flow untouched);
2. iOS payer, Wi-Fi radio off → automatic QR within ~4 s, animated when large;
3. Android↔Android, both offline, radios on → Nearby end-to-end with ack;
4. Android↔Android with GMS unavailable or permissions denied → fountain;
5. Android→iOS and iOS→Android with a deliberately huge multi-input
   transaction → fountain both directions;
6. payer QR-path send while offline, Done → row queued, badge shows
   "Offline · queued", reconnect → broadcast within ~10 s, badge clears;
7. reconnect with flaky signal: first drain fails → backoff retries succeed
   without user action; "Send now" forces an immediate attempt;
8. kill app after QR-path Done, relaunch → "show code again" re-renders the
   fountain from `framePayload`, payee scans and internalizes.

## Phasing

One spec, three independently landable phases, in order:

1. **Drain fixes + badges** — pure TS, fixes the stuck-money bug. Ships
   alone if needed.
2. **QR fountain + ladder + session v2 + iOS auto-fallback** — TS + UI.
   Unlocks all cross-OS pairs.
3. **Android Nearby** — Kotlin native + EAS build + two physical Android
   devices for validation.

## Non-goals

- LAN/mDNS infrastructure-Wi-Fi transport (viable — the wire protocol is
  platform-neutral — but out of scope).
- iOS Nearby Connections interop: no iOS SDK exists.
- BLE anywhere: CoreBluetooth is banned from BSVBrowser.app (ITMS-90683).
- A reverse-ack QR for the fountain path (payee→payer). The QR transport
  stays one-way; `Unsettled` mechanics stand in.
- Any cryptographic defence against double-spending offline payments beyond
  the existing attribution records.
- Changes to handle/address rails or to the header store.
