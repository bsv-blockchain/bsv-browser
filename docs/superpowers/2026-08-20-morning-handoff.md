# Morning handoff — 2026-08-20

## What to upload

Two store artifacts, built from `claude/vault-expansion-boundary` (which contains the whole PR stack: #136 → #137 → #138 plus the BEEF work). Both were archived from the identical working tree, so the two binaries carry the same code.

- **iOS** → `build-1787200068859.ipa` — 39.2 MB, version **1.6.0 build 165**, `org.bsvassociation.browser`, team `SV8SWTHA2H`. Upload with Transporter, not `eas submit` — see the note below.
- **Android** → `build-1787199672574.aab` — 112.3 MB, **versionCode 91** (EAS auto-increment).

Both were verified after building, not just reported as "successful", because on this project a build has succeeded before while silently missing a whole native module:

| Check | iOS | Android |
|---|---|---|
| YubiKey native module linked | `HybridYubiKeyPiv` + `YubiKitManager` present in the binary; pods `YubiKeyPiv`, `YubiKit` | `libYubiKeyPiv.so` in all four ABIs |
| Localpay transport linked | `HybridLocalPayTransport` present | `libLocalPayTransport.so` in all four ABIs |
| No banned Bluetooth key | no `NSBluetooth*` key at all | n/a |
| NFC kept | `com.apple.developer.nfc.readersession.formats` entitlement + `NFCReaderUsageDescription` present | n/a |
| Release signing | `get-task-allow = false`, distribution-signed | n/a |
| 16 KB page alignment | n/a | first LOAD segment `2**14` on every lib |

**Transporter, not Deliver.** Past experience on this project: `ITMS-90683` appears at Deliver and demands a `NSBluetoothAlwaysUsageDescription` key that must NOT be added, and Transporter's own Verify step does not catch it. If it appears again, the answer is still not to add the key.

## What these builds are for

Physical verification of four programmes that are complete in code and unverified on hardware. Every one of them is test-green; none has run on a phone.

### 1. Vault: adopt a YubiKey already enrolled elsewhere

The original report. Your Android phone plus the iPhone that already holds the vault key.

- Vault → enrol on the Android phone with the same YubiKey. Expect **"This YubiKey is already set up"** with *Use the key already on this YubiKey* — not the old dead-end error.
- Adopt, then confirm the vault opens and shows the same balance the iPhone sees **once storage has synced** — the two devices have separate local SQLite, so an unsynced Android install can legitimately show an empty vault with a correctly adopted key.
- Deposit indices start high on the adopted device by design (random, ≥ 2^20), so the two phones cannot hand out the same address.

### 2. Backup: restore on import, and the cursor advancing

This is the acceptance criterion for the whole compression programme, and it is an observation rather than an assertion.

- Fresh install → **Import Existing Wallet** with a phrase that has a backup. Expect a progress line ("Restoring your wallet history — n of m") and history present afterwards.
- Then, on a wallet with a **funded vault**: make a deposit and a withdrawal, leave the app foregrounded a few minutes, and check that the backup **cursor advances** rather than sticking. Before this work a single vault deposit wedged the log permanently.
- Leave it running long enough for **two `TaskCheckForProofs` sweeps** and confirm no req reaches `status='invalid'`. That transition is irreversible and cascades, so it is the one to watch.

### 3. Size caps and the vault input cap

- From a page: an oversize `createAction` should be refused with a clean error (code 6), not a crash.
- A withdrawal from a vault holding **more than 6 UTXOs** should move part of the vault and say so ("Moved part of your vault. n more deposits remain"), leaving the rest spendable. Repeat it and the vault should drain, consolidating each pass.
- Turn airplane mode on and try a vault transfer: expect **"Vault transfers need a connection"**, and no YubiKey prompt.

### 4. Storage pressure

- Settings → Settings → Data & Security → **Storage** shows database size, free space and what is reclaimable. Safe to run; it clears validation data the wallet no longer needs and never touches balances or history.

## What is deliberately OFF in these builds

`COMPRESS_PROVEN_TX_RAWTX` in `storage/methods/expandStored.ts` is `false`. That column is the merkle evidence, and `Beef.verifyBumpIndexLeaves` binds `hash256(rawTx)` to a chain-committed BUMP leaf inside `@bsv/sdk` where no subclass can intercept it — so a bug there is unrepairable locally, unlike every other column, which can be refetched. Flip it only after (2) above has passed on a device. It is one line and reversible; rows written while it was on stay readable if it goes back off.

## Known gaps, none of them silent

- **No mining harness.** Every representation-agnostic site passes green on compressed bytes; the failures that would matter live in the monitor, the UTXO prober and the broadcaster, and no current test drives them that far. This is why the device pass above is the real gate.
- **Peer sync would need a capability flag.** `storageUrl` is `'local'`, so the only sync consumer is our own encrypted backup. If BRC-38 peer storage is ever enabled, envelopes would replicate with no signal and a mixed fleet would re-push forever — the comment on `getSyncChunk` says so.
- **Adjacent memory holes remain open**, and a size cap does not close them: no rate limit or in-flight guard in the dispatcher, the response side (`buildWalletResponseScript` double-stringifies a multi-MB `listOutputs` into `injectJavaScript`), the ungated localpay radio send with its per-byte base64 encoder, and the 402 path that puts an AtomicBEEF into an HTTP header where intermediaries cap at 8–16 KiB.
- **Offline queue lifecycle.** `processOfflineActions` still has no attempt cap, no expiry and no local terminal state that releases a reservation. Vault transfers can no longer enter it (that gate shipped), so this is now default-basket-only — but a stuck row still freezes coins with only a devLog to show it.

## PR state

| PR | What | Status |
|---|---|---|
| [#136](https://github.com/bsv-blockchain/bsv-browser/pull/136) | Template registry, cross-checked against `@bsv/templates` | open, review required |
| [#137](https://github.com/bsv-blockchain/bsv-browser/pull/137) | `Uint8Array` codec core | open, stacked on #136 |
| [#138](https://github.com/bsv-blockchain/bsv-browser/pull/138) | Expansion boundary, compress-on-write, BEEF containers, sync form | open, stacked on #137 |
| [go-private-backup-cache#3](https://github.com/bsv-blockchain/go-private-backup-cache/pull/3) | 413 before auth, `GET /v1/limits` | open, rationale corrected |

The org ruleset requires a review on each, which I cannot satisfy. #132, #133, #134, #135 and server #4 are merged.

## Numbers worth knowing

| | |
|---|---|
| Vault locking script | 959,632 bytes → **51** compressed |
| Preimage scriptCode | 959,572 → **31** |
| A deposit's rawTx | ~960 KB → **under 1 KB** |
| A withdrawal-shaped BEEF, 2 vault inputs | 2.8 MB → **under 2 KB** |
| `inputBEEF` per vault input | ~1.83 MB — why containers mattered more than rawTx |
| Backup server blob cap | 1 MiB, published at `GET /v1/limits` |
| Peak RSS per payload byte | ~20× central, 30× planning (Hermes v0.14.1) |
