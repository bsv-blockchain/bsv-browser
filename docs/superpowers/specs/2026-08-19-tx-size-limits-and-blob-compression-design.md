# Compressed-at-rest R1-K1 transactions, size caps, and storage pressure

**Date:** 2026-08-19
**Status:** design, awaiting review
**Research:** two multi-agent sweeps (16 agents, ~2.8 M tokens) over the codec, storage, backup, disk/SQLite, GC schema, wallet boundary, toolbox byte consumers, broadcast boundaries and codec feasibility, plus five adversarial critics. Claims carry `file:line`; the ones the design rests on were spot-verified by hand.

## 1. Constraints (product owner, fixed)

- The R1-K1 script is stored **compressed everywhere it is stored**, including inside transaction `rawTx` and including the rows that feed broadcast. Full bytes exist only at the moment of handing a transaction to an external service.
- Compression/decompression ships everywhere. **Older builds are not a consideration.**
- **No migration or backfill** — no R1-K1 output exists in any production database, and no device is wedged.
- Expansion is a **generic wire-serialiser concern**, not a vault-task concern: expand-and-verify at the outbound boundary, assert everywhere else.
- **Vault transactions are refused while offline.** The offline queue is for small casual default-basket payments only.
- 100 MB is the network's transaction ceiling; nothing larger should be attempted.
- Low disk surfaces a typed error whose remedy is clearing old transaction data.

## 2. Three corrections to earlier assumptions in this design

**2.1 "Keep the stored transaction structurally normal, with compressed scripts in place" must be rejected.** I argued for it because a parseable blob lets structure-only consumers work without expanding. That property is exactly the hazard: in-place substitution with a rewritten length varint produces a **syntactically valid transaction with a wrong txid**, and nothing in the stack hashes stored bytes to notice. `processOfflineActions.ts:110-127` exists to prevent orphan cascades and cannot catch this, because nothing throws. Unexpanded bytes must be **unparseable**: the envelope's first byte is `0xfe`, a value no rawTx (`01|02 00 00 00`), BEEF (`01|02 00 be ef`) or AtomicBEEF (`01 01 01 01`) can begin with, and distinct from the compressed-*script* marker `0xff`.

**2.2 Vault outputs do have `scriptOffset`/`scriptLength`, and the slice path is live.** I claimed they would be null so the toolbox's re-slice never engages. The opposite is true: `maxOutputScript = 1024` ([StorageExpoSQLite.ts:98-102](../../../storage/StorageExpoSQLite.ts)), so a 959,632-byte script is *not* stored inline — the offsets are recorded instead, and `getRawTxOfKnownValidTransaction(txid, offset, length)` slices rawTx at them. Slicing an envelope returns wrong bytes **with no exception**, `Services.hashOutputScript` hashes them, the chain says "not a UTXO", and three writers persist `spendable = false` (`attemptToPostReqsToNetwork.js:472`, `StorageProvider.js:779`, `StorageProvider.js:856-861`). The vault balance vanishes from the wallet's own view with nothing in the logs. **The envelope must therefore serve `readRange(offset, length)` from its span list**, and the byte-compare test at the recorded offset is the single most important test in the programme.

**2.3 "Expand only at the broadcast boundary" is not implementable as one seam.** `mergeReqToBeefToShareExternally` reads bytes off the `findProvenTxReqs` row its caller already loaded (`StorageProvider.js:301-307`, `attemptToPostReqsToNetwork.js:82`) — and that same row read also feeds the monitor's destructive txid tripwire and `getSyncChunk`, both of which must keep seeing compressed bytes. There is no single choke point. The design is safe only as an **explicitly enumerated multi-seam boundary** (§4.3) with a runtime assert at the parse primitives.

## 3. What the toolbox actually does with stored bytes

| Site | Behaviour | Consequence for compressed storage |
|---|---|---|
| `TaskCheckForProofs.getProofs` (`monitor/tasks/TaskCheckForProofs.js:116-127`) | Re-hashes `proven_tx_reqs.rawTx`, compares to the stored `txid`, sets `status='invalid'` on mismatch and fails every notified transaction | **A live tripwire on a schedule.** Compressed reqs are invalidated minutes after a foreground test passes. `invalid` is not reversible by the app |
| `Beef.verifyBumpIndexLeaves` (`@bsv/sdk/.../Beef.js:974-985`, `BeefTx.js:83-87`) | Requires `hash256(rawTx)` to equal a level-0 BUMP leaf | **Un-patchable by subclassing.** Once mined, the chain commits to the real bytes, so a compressed `proven_txs.rawTx` fails `Beef.verify()` permanently — breaking `createAction` inputBEEF validation for every later vault spend |
| `Beef.verify(chainTracker)` at four entry points (`processAction.js:71-79`, `createAction.js:495-498`, signer + storage `internalizeAction`) | Transitively hashes rawTx | Four independent hard gates |
| `Services.applyRawTxResult` (`services/Services.js:471-483`) | Verifies **network-sourced** bytes against the requested txid, discards on mismatch | The natural **inbound** compress point |
| `getProvenOrRawTx`, `getRawTxOfKnownValidTransaction`, `mergeReqToBeefToShareExternally`, `getValidBeefForTxid`, `verifyKnownValidTransaction` | Return or merge stored bytes with **no hashing** | The whole read side is unguarded — which is why compression "works" in unit tests and fails in the monitor and the broadcaster |
| `EntityProvenTx.fromTxid` | Docstring claims it verifies `hash(rawTx) === txid`; **the body never hashes** | Compressed bytes propagate from `proven_tx_reqs` into `proven_txs` unchallenged, reaching the un-patchable gate above |
| `attemptToPostReqsToNetwork` → `mergeReqToBeefToShareExternally` → `services.postBeef` | The one path where stored bytes become network payload | `mergeReqToBeefToShareExternally` is **abstract** (`StorageProvider.d.ts:39-40`) and implemented in *our* [StorageExpoSQLite.ts:1220-1251](../../../storage/StorageExpoSQLite.ts) — so this seam needs an override, not a patch |
| `Arcade` provider (`services/providers/Arcade.js:229-237`) | Rebuilds Extended Format per txid | Worst case on the wire: EF re-embeds each input's **source** locking script, so spending one R1-K1 output puts ~960 KB into the HTTP body even when the spending transaction is small |

## 4. Part 1 — the compressed-at-rest programme

### 4.1 Envelope format (`services/vault/txEnvelope.ts`)

```
magic(1)=0xfe ‖ version(1)=0x01 ‖ flags(1) ‖ txid(32, internal order)
  ‖ origLength(4 BE) ‖ spanCount(1)
  ‖ spanCount × { offset(4 BE) ‖ recLen(2 BE) ‖ record }
  ‖ literalLen(4 BE) ‖ literal
```

A **span list**, not in-place substitution (§2.1). Expansion is a pure splice, so byte-exactness does not depend on reasoning about varint canonicality — and a rawTx carrying a deliberately non-canonical script-length varint must round-trip to the *original* txid rather than being normalised. That is a required test case.

**Self-verifying expansion:** expand → `hash256` → compare to the recorded `txid`. At ~960 KB saved per span, 32 bytes of txid is free, and it converts every silent corruption into a loud, attributable failure.

**Refuse to expand** when spans overlap, are out of ascending order, or `Σ(span lengths) + literalLen ≠ origLength`.

### 4.2 Span discovery must be structural, never a byte search

Region `0x02` (the preimage scriptCode) is a **byte-for-byte suffix** of region `0x01` (the locking script) — `PREIMAGE_SCRIPT_CODE_OFFSET = 60` ([templateCodec.ts:114](../../../services/vault/templateCodec.ts)) — so any sliding-window matcher yields overlapping ambiguous spans. Walk the transaction instead:

`version(4)` → varint `nIn` → per input `{ skip 36, read varint L; candidate iff L === 959,871 with the framing canary 0x40@0 / 0x21@65 / 0x20@99 / 0x4e@132 / f5 a4 0e 00@133-136 / 0x00@959,870 and inner scriptCode varint fe 54 a4 0e 00@241-245, then take the span at inner offset 246, length 959,572; skip L+4 }` → varint `nOut` → per output `{ skip 8, read varint L; candidate iff L === 959,632; skip L }` → skip 4 and assert the cursor lands exactly on the buffer end.

Use **one** varint reader for discovery and validation: `Transaction.fromReaderInternal` uses `readVarIntNum()` while `BeefTx.scanRawTransaction` uses `readVarIntNum(false)`, and they disagree on `0xff`-prefixed high-bit counts.

The canary rejects a non-match in ~20 byte reads; a genuine candidate pays the full 959 K-byte compare (~5.85 ms on V8, extrapolating to 0.4-1.0 s of blocked JS thread for a 21-instance transaction on Hermes). **Set a size ceiling above which compression is skipped rather than attempted, and yield between candidates.**

### 4.3 The boundary, enumerated

**Compression (write) — five hooks plus three assertions:** `insertProvenTxReq` (:476), `updateProvenTxReq` (:594), `insertTransaction` (:559), `updateTransaction` (:654), `insertOutput`/`updateOutput` (:522/:624, step B6); write-side envelope assertions in `sqlInsert` (:381), `sqlUpdate` (:403), `sqlUpdateComposite` (:429).

**Expansion (read) — seven functions, and only these:**

| # | Site | Why |
|---|---|---|
| E1 | `getProvenOrRawTx` ([:1220](../../../storage/StorageExpoSQLite.ts)) | Feeds BEEF assembly and signing |
| E2 | `getRawTxOfKnownValidTransaction` ([:1235](../../../storage/StorageExpoSQLite.ts)) | Range reads → served by `readRange`, never by slicing the envelope |
| E3 | `findOutputs` script loop ([:785-789](../../../storage/StorageExpoSQLite.ts)) | Before `validateOutputScript`, never after |
| E4 | `findTransactions` ([:864-868](../../../storage/StorageExpoSQLite.ts)) | |
| E5 | `mergeReqToBeefToShareExternally` (new override) | The single convergence point for every broadcaster, including the toolbox's own `ArcadeBeef` |
| E6 | `getBeefForTransaction.js:121,129` (patch) | Reached from `createAction.js:251` and `:783` with a fan-out of 8 — the site the first census missed |
| E7 | `TaskCheckForProofs.js:117` (patch) | Expand **before** `doubleSha256BE`, and split the outcome: an *unexpandable* blob must **not** become `status='invalid'` (irreversible, cascades) — only successfully-expanded bytes that hash wrong are genuinely invalid |

Plus `StorageProvider.js:513,533` and `createAction.js:558`.

**Type-level enforcement is impossible** — a branded type is erased the moment bytes cross into `node_modules` (`StorageProvider.d.ts:39-40` declares `Promise<number[] | undefined>`). So: an `assertExpanded` guard at the top of `Transaction.fromBinary`, `fromBinaryView`, `Beef.mergeRawTx` and `BeefTx.scanRawTransaction` (**both** `dist/cjs` and `dist/esm`) that throws naming the txid when it sees `0xfe`. One patch covers eight-plus parse sites and turns any missed seam into a loud failure. Add a test asserting the guard is *present*, not merely that the patch applied — and make CI fail hard when any patch in `patches/` does not apply, because `patch-package` failures in `postinstall` are easy to miss and a dropped patch degrades to silent wrong behaviour.

### 4.4 Template version registry — required, not optional

`describeVaultTemplate()` returns descriptors for exactly one `TEMPLATE_VERSION` and `referenceBytesFor` refuses every other ([templateCodec.ts:331-378](../../../services/vault/templateCodec.ts)). So **the first change to the vendored artifact makes every stored envelope permanently unexpandable** — in `proven_tx_reqs`, `transactions`, `proven_txs` and every backup at once. "No migration needed" silently converts into "migration impossible", and the victim is the current build's own data written by yesterday's binary.

Replace the single artifact with an **append-only version-keyed registry**, return a descriptor per entry, and add a CI test hashing the serialised entry list against a committed golden digest so no historical entry can be removed or mutated.

### 4.5 Sequencing

**B0 — make `noRawTx`/`noScript` real (ship first, no codec).** `sqlFind` always emits `SELECT *` ([:334](../../../storage/StorageExpoSQLite.ts)), so every BLOB is read and `Array.from`-expanded (~8× heap under Hermes) then discarded post-hoc. Add a column list and emit a projection. Five callers already ask for the cheap path and pay full price ([:1499](../../../storage/StorageExpoSQLite.ts), [listActionsSql.ts:89](../../../storage/methods/listActionsSql.ts), [processOfflineActions.ts:342](../../../storage/methods/processOfflineActions.ts), [payerHold.ts:80](../../../utils/offline/payerHold.ts), [WalletContext.tsx:1937](../../../context/WalletContext.tsx)). This shrinks the number of sites that ever see bytes, de-risking everything after it.

**B1 — codec to `Uint8Array` end to end**, with `number[]` adapters at the edge; replace `Array.from(reference)` with `reference.slice()`. Must land whole: a partial migration costs 24 ms per `Array.from` and 2× hash cost at every crossing.

**B2 — the envelope** (§4.1-4.2), with `readRange`.

**B3 — install the expansion boundary while still writing uncompressed.** E1-E7 plus the patches, all dispatching through `classify(blob)` with a fall-through raw path. Ships as a behavioural no-op. Also remove `ArcadeBeef` from `postBeefServices`: `Services` registers it first (`Services.js:86-88`) and [WalletContext.tsx:800-803](../../../context/WalletContext.tsx) removes four other providers but not that one, so the toolbox's hex-in-JSON poster is still the primary broadcaster.

**B4 — compress `proven_tx_reqs.{rawTx,inputBEEF}` and `transactions.inputBEEF`.** This alone fixes the backup wedge, `TaskSendWaiting`'s 8-second full-BLOB re-read of up to 100 rows, and the offline drain's merge loop. **Primary success criterion for the whole programme:** after a real deposit and withdrawal on device, `estimateEncodedBytes` clears `MAX_BLOB_BYTES` and the backup cursor *advances*.

**B5 — compress `proven_txs.rawTx` last, behind its own flag.** That row *is* the merkle evidence (`BLOB NOT NULL`, [createTables.ts:31](../../../storage/schema/createTables.ts)) and `Beef.verifyBumpIndexLeaves` is the un-patchable gate. Verification: spend a vault output whose source is a compressed `proven_txs` row and assert `beef.verify()` at `createAction.js:495` passes.

**B6 — sync-chunk `outputs.lockingScript`, gated on a capability flag.** `getSyncChunk` calls `findOutputs` without `noScript`, so `validateOutputScript` puts a full ~960 KB script into the chunk for a column the origin device stores as NULL. Separately, `storage/portable/index.js:58-63` base64s byte columns verbatim and neither `getSyncChunk` nor `processSyncChunk` inspects them, so envelopes replicate to peer storage with no signal — and byte-for-byte entity diffs mean a mixed fleet sees every record as changed and re-pushes forever. **Sync must be gated on a declared capability, not assumed.**

### 4.6 Backup envelope versioning

`utils/backup/codec.ts` has no version field of any kind. Put the codec version **plus the registry digest** in the backup envelope, check it before `processSyncChunk` ([restore.ts:80](../../../utils/backup/restore.ts)), and refuse the **whole** restore — never partially apply — on an unknown version. Binary magic inside the plaintext, before encryption; never a JSON envelope (an old build parses it, `isEmptyChunk` reads it as the completion sentinel, and `restoreOnImport` returns `restored: true, chunks: 0` — a healthy-looking wallet with no history), and never a marker outside the ciphertext (fails inside `wallet.decrypt` indistinguishably from the wrong-seed case).

Generic gzip of the serialised chunk (1.28 MB → ~12.6 KB measured) is now **optional**: B4 fixes the wedge at the source. Keep it as a later independent win, and either way retire `estimateEncodedBytes` as the cap gate — its contract is to *underestimate*, so it refuses exactly the chunks compression makes fit.

## 5. Part 2 — WalletInterface size caps

Measured on shipped Hermes v0.14.1: peak RSS ≈ **20× N** central, **30× N** planning (native intake 7-16 N + JSON string 3.6-4.0 N retained for the whole call + `number[]` 4.0 N + GC slack + `Uint8Array` 1.0 N + SQLite copies 2.0 N).

**100 MB cannot be a memory cap.** At 20-30× that is a 2-3 GB peak — above the jetsam limit of every iPhone with ≤4 GB — and the failure is an uncatchable `LLVM ERROR: OOM`, so there is no degrade path. 100 MB stays the *network* ceiling; the *memory* ceiling is separate. Under the stated 800 MB transient budget the arithmetic supports ~27 MB per call; under 300 MB, ~10 MB.

**Recommended page-facing aggregate: 4 MB per call** (2 MB on `low` tier via [getDeviceTier()](../../../utils/deviceTier.ts)). The largest legitimate page payload today is a 65,536-byte localpay AtomicBEEF and a ~25-byte P2PKH script, so 4 MB is ~60× observed traffic.

| Field | Cap | Warn |
|---|---|---|
| aggregate per call | 4 MB (2 MB low) | 1 MB |
| single output `lockingScript` | 100 KB | 25 KB |
| sum of output `lockingScript` | 500 KB | — |
| `outputs` / `inputs` array length | 1,000 | — |
| declared `inputs[i].unlockingScriptLength` | 100,000 | — |
| sum of declared `unlockingScriptLength` | 500,000 | — |
| `signAction` spend `unlockingScript` | 100 KB | — |
| `inputBEEF` | 2 MB | 256 KB |
| `internalizeAction` `args.tx` | 1 MB | 64 KB |
| `customInstructions` per output | 4 KB | — |

The declared `unlockingScriptLength` cap cannot be substituted by a byte cap: the SDK only cross-checks it against a *supplied* script (`validationHelpers.js:372-375`), so a page can declare 959,871 per input with a near-empty payload and make the wallet fund a ~1 MB-per-input transaction. Also refuse a page-supplied `lockingScript` whose first byte is `0xff` — provably unspendable, and it closes the decoder-poisoning path.

**Placement:** a `capWalletArgs` Proxy shaped like [guardVaultAccess](../../../services/vault/guard.ts), composed at each external call site — [app/index.tsx:729](../../../app/index.tsx), [pair.tsx:92](../../../app/pair.tsx), [connections.tsx:123,137,175](../../../app/connections.tsx). Exempt the vault **by call site**, not by originator string: the vault calls `permissionsManager` directly and never enters the dispatcher. A cap in `guardVaultAccess`, `SimpleWalletManager`, `WalletPermissionsManager` or the toolbox breaks the vault outright. Refuse as `sendErrorToWebView(msg.id, '<field> exceeds the <N>-byte limit', 6)` to match `WERR_INVALID_PARAMETER`.

**Pre-parse ceiling** before [app/index.tsx:1192](../../../app/index.tsx): 32,000,000 chars when `data.startsWith('{"type":"FILE_DOWNLOAD_BLOB"')`, else 8,000,000. Comment it as a damage limiter — 7-16 N is already spent natively by then, and closing it fully needs a `react-native-webview` patch.

### 5.1 The app's own payload is the bigger risk

`spendVaultOutputs` spends **every** vault output with no input cap ([transfers.ts:402-412](../../../services/vault/transfers.ts)), and `toEF()` re-embeds each input's source locking script, so even the leanest binary path is ~188 MB at 20 inputs *regardless of storage encoding*. Compression at rest does not bound what leaves the device.

**Add an input cap of 6 per withdrawal (hard ceiling 8)**, re-vaulting the remainder, with a legible "consolidate the vault first" refusal **before** `signAction` ([:577](../../../services/vault/transfers.ts)) — today the only bound is a 30 s AbortSignal, and the failure lands *after* the point-of-no-abort comment at `:563`, where an OOM strands a signed transaction whose inputs nothing releases. The cap sits inside all three constraints: measured memory (~110-150 MB at 6 vs ~350 MB at 20), Arcade's 10 MB `MaxTxSizePolicy` (~10 inputs), and its 32 MiB single-tx endpoint (~18 inputs).

### 5.2 Vault refused while offline

Gate `depositToVault` and `withdrawFromVault` on the app's online signal with a typed `VaultError`. This is also what makes the offline-queue assertion exhaustive: no vault row can reach `offline_actions`, so the drain's in-memory `Beef` ([processOfflineActions.ts:129-132](../../../storage/methods/processOfflineActions.ts)) and the localpay serialisers only ever see default-basket traffic, and "a `0xfe` blob here is a bug" becomes a testable invariant rather than a hope.

### 5.3 Boundaries compression does not help

- **402 paid-GET** puts the whole AtomicBEEF into an HTTP *header* as base64 ([bsvPaymentHandler.ts:232-250](../../../utils/webview/bsvPaymentHandler.ts)), where intermediaries cap headers at 8-16 KiB.
- **peerpay/MessageBox** hands a token to a third-party wallet with no R1-K1 codec, and persists `transaction: number[]` indefinitely.
- **localpay radio** send at [NearbyFlow.tsx:1105](../../../components/pay/NearbyFlow.tsx) has **no size gate** while both QR branches do, and `socket.ts:15-19` base64s one byte at a time. Today vault-funded frames are refused as `local_pay_too_large`; anything that makes them fit will send them, and `verify.ts:86-93` compares locking-script hex for equality so a codec mismatch declines as `not_mine`. Gate the radio send and fix the encoder before B4.

Because vault change lands in the **default basket** and BEEF/EF require every input's source transaction in full, an ordinary payment can drag a full withdrawal ancestor across any of these with no vault operation in the session. Scoping this work to `services/vault/*` would leave live paths uncovered.

## 6. Part 3 — disk pressure and reclaiming space

**Free space:** `import { Paths } from 'expo-file-system'` then `Paths.availableDiskSpace` — a synchronous getter. `getFreeDiskStorageAsync` from the bare specifier **throws at runtime** (verified, [legacyWarnings.ts:105-109](../../../node_modules/expo-file-system/src/legacyWarnings.ts)); the only valid async form is the `expo-file-system/legacy` subpath. Guard the read — the native getter is `Int64?` and returns nil on failure while TypeScript claims `number`, so an unguarded comparison fails *open*.

**Absolute thresholds only** — `Paths.totalDiskSpace` returns free space on iOS, so any percentage never fires. Warn under 200 MB; block non-essential writes under 50 MB.

**Classify by message text, not code.** Every SQLite failure carries `code === 'ERR_INTERNAL_SQLITE_ERROR'`. Match unanchored on the sqlite text (`/database or disk is full/i`, `/disk I\/O error/i`) and **exclude** `/database is locked/i`. Do not parse a numeric code — Android appends it as a raw control character (`NativeDatabaseBinding.cpp:196`). New `storage/errors.ts` modelled on [services/vault/types.ts:6-82](../../../services/vault/types.ts). Hook both the pre-write gate and the classifier into `transaction()` ([:147-170](../../../storage/StorageExpoSQLite.ts)); pre-emptive checking is required because `withExclusiveTransactionAsync` awaits ROLLBACK inside its catch *before* recording the error, so a rollback failing under disk pressure destroys the diagnosis. Surface with `showAlert`, not `showToast`. **WAL is not enabled**; the companion is a transient `-journal`.

**Reclaiming: the requested rule must not ship as stated.** "Drop the oldest transactions whose outputs are all spent" fails on three verified grounds: spent-ness is **reversible** (`releaseInputsAllocatedToFailedTransaction` restores `spendable = 1`, so pruning inside that window strands the coin with `ignoreServices: true` and no network recovery); proven-ness does not close the transitively-required ancestry (`storageProviderHelpers.js:49-66`); and the backup delta protocol has **no deletes**, so pruning looks harmless in testing and then the next generation rotation snapshots the pruned database — the loss surfaces weeks later on another device during a recovery.

- **E1 (ship): a read-only report.** Rows and reclaimable bytes per table per rule, plus which guard excluded each near-miss. Predicted answer: nearly all of it is `transactions.inputBEEF` plus duplicated vault blobs, in which case E2 plus Part 1 is the whole feature.
- **E2 (ship): null exactly one column** — `transactions.inputBEEF`. Nothing reads it for BEEF (`getProvenOrRawTx` reads `proven_txs` then `proven_tx_reqs`), which is why it is the safe target. Predicate: `status='completed' AND provenTxId IS NOT NULL AND proven height ≤ tip-100 AND no non-completed proven_tx_req for the txid AND no queued/posting offline_action AND updated_at < cutoff`. Deliberately **no spent-ness term**. Needs raw `db.runAsync` — `updateTransaction` cannot write NULL until `sqlUpdate`'s undefined-skip is fixed (verified, [:412-417](../../../storage/StorageExpoSQLite.ts)).
- **E3 (defer): `proven_txs.rawTx` nulling** — only behind all eight exclusion clauses, and I would still argue against it.
- **Never triggered by low disk.** On a nearly full volume the rollback journal for a large UPDATE can itself fail with `SQLITE_FULL`, and with no WAL and no `auto_vacuum` the file does not shrink, so the user sees zero benefit. Manual action, gated on a verified recent backup, refused outright on a wallet wedged by the oversize bail.
- **Bound the offline queue** regardless: `processOfflineActions.ts:128-138` turns any failure into `blocked` and requeues forever with no attempt cap, no expiry and no local terminal state — reservations are never released. Give rows an attempt/age budget with a user-visible terminal state that **releases** the reservation.

## 7. Independent wins to ship before any codec wiring

Each shrinks the blast radius and stands alone:

- Push offset/length into SQL (`SELECT substr(rawTx, ?, ?)`) at [:1235-1250](../../../storage/StorageExpoSQLite.ts).
- Stop `Array.from`-ing large BLOBs to `number[]` at [:206-213](../../../storage/StorageExpoSQLite.ts) — ~8× Hermes heap reduction on every row read.
- **Cap the `history` column.** Provider error notes capture full EF/rawTx hex (`Arcade.js:110,137,149,195`; `WhatsOnChain.js:161,206`), `transferNotesToReqHistories` copies them verbatim into `proven_tx_reqs.history` untruncated, and `addHistoryNote`'s dedup does full string equality against every existing note. One failing vault broadcast writes multi-megabyte hex into a TEXT column and the second failure compares megabyte strings — quadratic, and triggered exactly when things go wrong. Cap note values at ~256 chars. This is a direct violation of "stored compressed everywhere" that no rawTx codec touches.
- Replace `abortReservingOutpoints`' 25-page × 200-action `includeInputs` scan ([transfers.ts:255-266](../../../services/vault/transfers.ts)) with a direct query over `outputs.spentBy`, and populate the declared-but-never-written `outputs.sequenceNumber` so `listActionsSql`'s per-action `Transaction.fromBinary` disappears.
- `exportTransactionsAsCsv` does an unbounded `findProvenTxs({ partial: {} })` reading every rawTx and merklePath in the wallet to build a txid→height map ([exportTransactions.ts:48-54](../../../utils/exportTransactions.ts)). Make it `SELECT txid, height`.
- Destructure `const { data, url } = event.nativeEvent` in a thin wrapper so the event is not captured across every await — releases 3.6-4.0 N for the whole call.
- Retune `releaseTemplateCache` guidance: `ensureTemplateCache` is ~40 ms on desktop V8 without `node:crypto` and plausibly 120-330 ms on Hermes, not the "sub-frame" the comment claims. With the codec wired, cache-warm state becomes a latency precondition for broadcast and for every vault-basket `listOutputs`, so release only on a real memory-pressure signal.

## 8. Testing — the suite must mine

Every representation-agnostic site (`classifyReqStatus`, `verifyKnownValidTransaction`, `arraysEqual` entity diffs, `getSyncChunk`, the portable round trip) **passes green on compressed bytes**. A test that does not drive `mockchain/MockMiner.js` far enough to mine proves nothing.

Required:

1. `hash256(expand(compress(rawTx))) === recorded txid` for the real mined mainnet fixture, a synthetic 1-in/2-out withdrawal with a re-vault output, and a rawTx with a **non-canonical** script-length varint.
2. `readRange` at a vault output's exact recorded `scriptOffset`/`scriptLength`, byte-compared against the original — plus a variant with `maxOutputScript` set below 51 so the slice path runs for a compressed row (today vault outputs are the only consumers of that path).
3. Mine, then re-run `TaskCheckForProofs` and `Beef.verify` against the stored row.
4. Spend a vault output whose source is a compressed `proven_txs` row; assert `beef.verify()` at `createAction.js:495` passes.
5. An end-to-end signing test against a compressed-at-rest source validated through the **Spend VM**, not a mocked wallet — `transfers.ts:512-517` rebuilds the prevout script independently, and the R1K1 template prefers supplied `lockingScript` over `input.sourceTransaction`, so a compressed script reaching inputBEEF produces an invalid signature with **nothing thrown**.
6. `0xfe` cannot begin a valid rawTx, BEEF or AtomicBEEF; `0xfe` and `0xff` never conflated.
7. `assertExpanded` guards present in the patched SDK; CI fails hard on any `patches/` mis-apply.
8. `matchesTemplate` is **not** an ownership oracle: a counterparty can mint a genuine R1-K1-shaped output committing to their own key and hand it in via `internalizeAction` from an arbitrary web origin. Basket membership plus `customInstructions` must remain the only authority — as a test, not a comment.
9. Per-output `try/catch` in `findOutputs` so one corrupt envelope cannot take down `listOutputs`, the vault screen and backup wallet-wide; `getRawTxOfKnownValidTransaction` must distinguish "no such transaction" from "stored but unexpandable".

Storage has no test harness today (`StorageExpoSQLite` is validated only on device). Extract the envelope, the predicate and the write plan into pure modules behind thin interfaces (the [offlineActions.ts:40-44](../../../storage/methods/offlineActions.ts) pattern) and test against `node:sqlite` with a schema built by `createTables`.

## 9. Order of work

1. **§7 independent wins** + B0 (`noRawTx`/`noScript`) + `history` cap. No codec, all upside.
2. **Part 2 caps** including the vault input cap and the offline gate — highest severity, self-contained.
3. **B1-B3** codec to `Uint8Array`, the envelope, the boundary installed as a no-op.
4. **B4** compress `proven_tx_reqs` + `transactions.inputBEEF` → the backup cursor advances. Primary success criterion.
5. **Part 3** disk guard, typed errors, E1 report.
6. **B5** `proven_txs.rawTx`, then **B6** sync chunks with the capability flag.
7. **E2** `inputBEEF` nuller, if the report justifies it.

## 10. Open items needing device measurement

- The 7-16 N native-intake term is reasoned from RN/RNW source, **not measured on device**. An RSS sampler around one 1 MB `internalizeAction` on both platforms settles it.
- Baseline RSS with 1-3 warm tabs and a built wallet on a low-tier device — every transient budget is meaningless without it, and [deviceTier.ts:56-70](../../../utils/deviceTier.ts) already records this app being process-terminated for memory it considered normal.
- Hermes cost of `ensureTemplateCache` and of the full 959 K-byte compare (the 0.4-1.0 s figure is extrapolated from V8).
- `new File(dbPath).size` on Android.
- Whether the 4 bytes-per-element `number[]` figure survives an RN/Hermes bump.
