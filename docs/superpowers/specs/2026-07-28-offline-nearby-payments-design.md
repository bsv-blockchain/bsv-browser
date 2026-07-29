# Offline Nearby Payments — Design

**Date:** 2026-07-28
**Status:** Approved, not yet implemented
**Scope:** the nearby rail only (`pay-nearby`, `get-nearby`). Handle and address rails stay online-only.

## The scene

Two people are on an underground train with no signal. One pays the other over
AWDL or QR. Both wallets must accept, record, and — critically — be able to
*re-spend* that money before either device sees the network again. When the
train surfaces, every transaction that accumulated underground reaches the
network, in dependency order, from whichever device gets signal first.

The payee must be able to do this from a **zero balance**: receive, then spend
what it just received, offline, repeatedly, growing a chain of unbroadcast
transactions that each carry their predecessors as BEEF.

## What already works

`utils/localpay/*` is device-proven (210 tests, tagged `v1.5.6`): session
minting, frame build, AWDL and QR transports, ack semantics, the pending queue,
and a NetInfo-triggered drain at `context/WalletContext.tsx:1233`. The payment
frame already carries **AtomicBEEF**, not a bare rawtx (`utils/localpay/build.ts:75`),
so full ancestry already crosses the air gap. None of that changes.

## What blocks offline operation today

Verified in `node_modules` on 2026-07-28.

1. **BEEF verification needs a chain tracker.** `Beef.verify` calls *only*
   `chainTracker.isValidRootForHeight(root, height)` — once per distinct block
   height in the beef (`@bsv/sdk/dist/cjs/src/transaction/Beef.js:702-707`). It
   never calls `currentHeight`. The signer verifies with `allowTxidOnly = false`
   on the internalize path (`signer/methods/internalizeAction.js:96`) and storage
   verifies with `true` on the createAction path
   (`storage/methods/createAction.js:495`). Both currently resolve roots over
   HTTP.

2. **`internalizeAction` force-broadcasts synchronously.** For any txid the
   wallet has not seen, `storage/methods/internalizeAction.js:536` calls
   `shareReqsWithWorld(..., isDelayed = false)`. Offline that yields
   `serviceError`, which triggers `restoreSpentInputs()` and a
   `WERR_REVIEW_ACTIONS` throw (`Wallet.js:856`). The internalize aborts. This is
   the gate on receiving anything at all offline.

3. **Chained offline spends break on broadcast.** `services/arcadeBroadcastProvider.ts:58`
   posts **EF**, which carries input scripts but not parent transactions. A child
   posted before its unbroadcast parent is a missing-inputs rejection →
   `invalidTx` → the transaction is marked `failed` and its outputs are torn
   down. Order is not currently guaranteed.

4. **Offline time burns broadcast attempts.** `TaskSendWaiting` retries `sending`
   reqs every 5 minutes and increments `attempts` on each `serviceError`
   (`storage/methods/attemptToPostReqsToNetwork.js` → `updateReqsFromAggregateResults`).
   Past `unprovenAttemptsLimitMain = 144` with `wasBroadcast === false`,
   `applyProofTimeout` sets the req **`invalid`**
   (`storage/schema/entities/EntityProvenTxReq.js:426-433`). Roughly twelve hours
   offline is enough.

A fee lookup is *not* a blocker: `createAction` uses `storage.feeModel`
(`storage/methods/createAction.js:61`), which is local.

## Architecture

### The two independent status levers

Output spendability filters on **`transactions.status` only**.
`proven_tx_reqs.status` never enters the query — confirmed at
`storage/StorageExpoSQLite.ts:742` (the `txStatus` subquery), `:1278`
(`allocateChangeInput` accepts `completed`, `unproven`, and `sending`), and
`storage/methods/listOutputsSql.ts:86`. So the two columns can be set
independently to mean two different things:

| column | value | meaning |
| --- | --- | --- |
| `transactions.status` | `unproven` | outputs are **spendable now** |
| `proven_tx_reqs.status` | `nosend` | broadcast is **held** |

`nosend` is the correct hold because every monitor task already ignores it:
`TaskSendWaiting` selects `unsent`/`sending`; `TaskCheckForProofs` selects
`callback`/`unmined`/`sending`/`unknown`/`unconfirmed`; `TaskFailAbandoned`
sweeps *transactions* in `unprocessed`/`unsigned`; and `TaskCheckNoSends` reads
`nosend` rows but is explicitly barred from counting attempts against them
(`countsAsAttempt && req.status !== 'nosend'`). It is also releasable —
`readyToSendStatuses` includes `nosend` (`storage/storageProviderHelpers.js:14`),
which is what makes `options.sendWith` work on it.

**Therefore: an offline transaction is `transactions.status = 'unproven'` plus
`proven_tx_reqs.status = 'nosend'`.** Spendable immediately, broadcast later,
no attempt burn, no auto-invalidation. This resolves blocker 4 by construction.

### The payer-side wrinkle this exposes

`buildPaymentFrame` passes `noSend: true`, which `determineReqTxStatus`
(`storage/methods/processAction.js:150`) maps to transaction status **`nosend`** —
not `unproven`. Since `allocateChangeInput` excludes `nosend`, a payer's change
from a first offline payment is not selectable for a second. Today's flow never
noticed because it broadcast immediately on ack.

The offline enqueue therefore promotes the transaction to `unproven`.
`updateTransactionStatus` for `nosend → unproven` is a pure status write with no
output side-effects (`StorageProvider.js:397-436`; only `failed` has side-effects).
Both directions then obey one rule, and a payer can chain offline spends from
its own change.

### Where each side enqueues

**Payee.** The override at `storage/StorageExpoSQLite.ts:1345` dispatches to
`internalizeActionOffline` when offline. Only the new-txid branch differs; the
merge path (a txid the wallet already knows) never broadcasts and is unchanged.
If the device loses signal mid-internalize while on the online path, the call
fails as it does today and the existing pending queue
(`utils/localpay/pending.ts`) retries — on that retry the device reads as
offline and takes the new path.

**Payer.** `finalizeDelivery` (`utils/localpay/build.ts:252`) currently calls
`broadcastPayment` on a positive ack. When offline it instead enqueues: promote
the transaction `nosend → unproven`, insert an `offline_actions` row with
`role = 'sent'`, and return the existing
`{ kind: 'sent', broadcast: 'pending' }` outcome — which the UI already renders
as "queued, not yet broadcast". A negative ack still aborts, unchanged: the
frame provably never landed, so the inputs must be released.

### New table: `offline_actions`

Added to `storage/schema/createTables.ts`, which is entirely
`CREATE TABLE IF NOT EXISTS`, so existing installs migrate on next `migrate()`
with no version bookkeeping.

```
offline_actions
  offlineActionId    INTEGER PRIMARY KEY AUTOINCREMENT
  created_at         TEXT NOT NULL
  updated_at         TEXT NOT NULL
  userId             INTEGER NOT NULL
  txid               TEXT NOT NULL UNIQUE
  seq                INTEGER NOT NULL        -- arrival order, for tie-breaks
  role               TEXT NOT NULL           -- 'received' | 'sent'
  senderIdentityKey  TEXT                    -- attribution; null when role='sent'
  receivedVia        TEXT                    -- 'awdl' | 'qr' | null
  status             TEXT NOT NULL           -- 'queued' | 'posting' | 'sent' | 'rejected'
  rejectedReason     TEXT
  poisonedByTxid     TEXT                    -- the ancestor whose rejection killed this one
```

This table is a **broadcast queue and provenance record**, not a quarantine. The
money itself lives in the normal `transactions` / `outputs` tables the whole
time, which is what makes it spendable.

### Release order comes from BEEF, not from the queue

A received transaction's ancestry can contain *other people's* unbroadcast
transactions: C pays B underground, B pays us. C's transaction is in our beef
but was never in our queue. So queue rows cannot be the source of ordering.

Every req already stores the full AtomicBEEF in `proven_tx_reqs.inputBEEF`
(`EntityProvenTxReq.fromTxid(txid, rawTx, Utils.toArray(args.tx))` at
`storage/methods/internalizeAction.js:519`). Release therefore:

1. unions every transaction across every queued req's beef;
2. drops any transaction carrying a merkle path (already mined);
3. topologically sorts the remainder on input edges, `seq` breaking ties;
4. posts in that order.

### Posting

One EF `POST /tx` per transaction, parent strictly before child, via the
existing `services/arcadeBroadcastProvider.ts` chain
(Arcade → Taal → GorillaPool → WoC → Bitails). EF carries source scripts inline,
so a child is accepted as soon as its parent is in the mempool — no dependency
on any endpoint accepting BEEF. On a service error (still offline, or a
transient failure) the run stops for that subtree and leaves the rows `queued`.

### Rejection cascades with attribution

On `invalidTx` or `doubleSpend` for transaction X:

- X's req → `invalid` / `doubleSpend`; X's transaction → `failed`, which
  releases allocated inputs and marks its outputs not spendable
  (`StorageProvider.js:421`);
- every **descendant** of X gets the same treatment, with `poisonedByTxid = X`
  — and **children first, parents last**. Corrected 2026-07-28 after the Task 9
  review. `updateTransactionStatus('failed')` releases a transaction's *own*
  inputs and then marks its *own* outputs unspendable
  (`StorageProvider.js:421-424`), so failing a parent before its child lets the
  child's failure hand the parent's outputs back as `spendable: true`, with
  nothing running afterwards to re-mark them — network-refused money spendable
  again. `EntityTransaction.getInputs` re-finds the parent output by
  `txid`+`vout` regardless of `spentBy` being cleared, so parent-first is
  unsalvageable rather than merely order-sensitive. The cascade order is
  `releaseOrder` **reversed**; reversing `descendantsOf`'s breadth-first output
  is *not* a topological order and gets this wrong.
- descendants are found across a graph widened with the wallet's own local
  spenders, not just the merged BEEF. BEEFs reach backwards, so a transaction
  we created by re-spending offline is absent from its parent's BEEF and would
  otherwise escape the cascade entirely.
- each affected req gains a history note
  `{ what: 'offlineRejected', poisonedBy, senderIdentityKey, receivedVia, receivedAt, arcStatus }`.

That note is the who-to-pursue record: it names the identity key that handed us
the transaction, over which transport, and when. It surfaces as a persistent
failure row in `/pay` naming the sender.

**Where the attribution actually comes from** — corrected 2026-07-29 after the
Task 12 review found that nothing populated it. The payment frame carries
`senderIdentityKey`, but the frame lives at the app layer while the queue row is
written deep inside the storage layer's `attemptToPostReqsToNetwork` override,
which cannot see it. So the row is attributed **after** the fact, from the layer
that knows: `processPending` (`utils/localpay/pending.ts`) has both the entry's
frame and the txid the toolbox returns from `internalizeAction`, and updates the
row once the internalize succeeds. Attribution is best-effort — a failure there
must never turn a successfully internalized payment into a failed one, nor abort
the loop over the remaining entries.

A **payer's own** rejected transaction gets a separate notice with no sender
attribution, because there is no counterparty to attribute — it was the user's
own transaction. Scoping the sender-naming row to `role: 'received'` is
necessary (otherwise the payer's own failure reads as fraud committed against
them) but not sufficient on its own: without the second notice the failure
vanishes silently.

`markStaleInputsAsSpent` in the existing broadcast path already resolves the
"input is genuinely gone on chain" case, so a cascade does not resurrect UTXOs
the chain says are spent.

### Trigger

`TaskSendOffline`, with `triggerMsecs = 0` and a static `checkNow` flag — the
same manual-trigger pattern `TaskCheckForProofs` and `TaskCheckNoSends` use. It
is set by the consolidated online listener and by a manual "send now" control.
It never runs while offline, so it costs nothing underground.

## API surface

**Rewritten 2026-07-29 to describe what shipped.** The original proposed
`StorageProvider.internalizeActionOffline`, a parallel copy of
`internalizeAction` dispatched from an override of `internalizeAction` itself.
Implementation found a better seam; below is the built design, not the intent.

The seam is `StorageProvider.attemptToPostReqsToNetwork`, overridden in
`storage/StorageExpoSQLite.ts`. It is the *only* overridable thing the forced
broadcast inside `internalizeAction` reaches — `processAction.js:146` calls it as
a method, declared at `StorageProvider.d.ts:111` — so overriding it holds the
broadcast without duplicating ~400 lines of money-critical logic above it
(proven-tx insertion, target-transaction merge, `markInputsSpent`, BRC-29
payment records, labels, baskets). `TaskSendWaiting` calls the module *function*
directly (`TaskSendWaiting.js:180`), so the monitor's ordinary retries are
deliberately **not** intercepted.

What shipped, upstream-shaped so the ts-stack port is the same code on the same
base class:

- `holdReqsOffline(reqs, userId, role)` — parks requests at `'nosend'` and writes
  the `offline_actions` row. This is the method that becomes
  `StorageProvider.holdReqsOffline` upstream.
- the `attemptToPostReqsToNetwork` override — holds only when the device is
  offline **and** every request's transaction row is already hold-safe
  (`'unproven'` or `'nosend'`); anything else delegates to `super` untouched.
  That narrowing is load-bearing: on the non-delayed `createAction` path the
  transaction row is `'unprocessed'`, and holding it there would let
  `TaskFailAbandoned` fail it within five minutes while the queue still claimed
  it was pending. Narrowing also preserves an existing self-healing path, since
  `'nosend'` is invisible to `TaskSendWaiting`.
- `processOfflineActions({ storage })` — the ordered-release engine, with every
  money decision in the pure `utils/offline/plan.ts` and `utils/offline/order.ts`.
- `TaskSendOffline` in `utils/monitor/`, registered **before**
  `addDefaultTasks()` so the drain precedes `TaskSendWaiting` in a monitor pass.

**Nothing above storage changes.** The signer's `internalizeAction` already
performs both required checks — BEEF ancestry `verify(chainTracker, false)` and
the BRC-29 locking-script match against a freshly derived key
(`signer/methods/internalizeAction.js:71-74`) — *before* it calls
`wallet.storage.internalizeAction(args)`. No `node_modules` patch is required.

### Not built

Recorded so the next reader does not take these for shipped behaviour: the
offline banner does not expand into a tappable list of queued actions; the
received-payment overlay does not flip to a broadcast state after release (it
reports the state at the moment of receipt); the rejection row is not
dismiss-gated; and there is **no manual "send now" control** — `checkNow` has
exactly one setter, the reconnect listener. A stalled queue therefore gets one
release attempt per wallet build plus one per connectivity change, not
continuous retry.

Work lands in this repo first and is mirrored into a `bsv-blockchain/ts-stack`
clone (`packages/wallet/wallet-toolbox`) as each piece stabilizes, so the
upstream PR lands with the app release.

## The header store

### Seam

`services/walletServiceConfig.ts:46,65,84` — replace `new ChaintracksServiceClient(...)`
with `new OfflineFirstChaintracks(remote, store)`, implementing the same
`ChaintracksClientApi`. Every method except `isValidRootForHeight` and
`currentHeight` delegates to the remote client — including
`findHeaderForHeight`, whose only caller is the app's WoC-BUMP service at
`WalletContext:700`, which needs the network regardless.

**Injecting at `options.chaintracks` is necessary but NOT sufficient** — corrected
2026-07-28 after the Task 5 review caught it. `Services.getChainTracker()` does
not hand the wallet our object; it returns
`new ChaintracksChainTracker(chain, options.chaintracks)`
(`services/Services.js:149-154`), and that wrapper's own
`isValidRootForHeight` (`ChaintracksChainTracker.js:21-56`) **never calls the
injected client's `isValidRootForHeight`**. It calls
`findHeaderForHeight(height)`, retries six times at 250 ms, and throws on
persistent failure. Since `findHeaderForHeight` is pure remote delegation, the
local window would never be consulted and the entire root cache and pre-warm
would be dead code.

So the app must also override `services.getChainTracker` to return the wrapper
directly — at the same place it already replaces `postBeefServices` and
`getMerklePathServices` during wallet build. `OfflineFirstChaintracks` satisfies
`ChainTracker` (`isValidRootForHeight` + `currentHeight`), which is all
`Beef.verify` consumes.

`findHeaderForHeight` must stay pure remote delegation and must NOT become
store-backed: `WalletContext:728-729` consumes a real header object from it
(`r.header = { ...header, height }`), so returning a root-only synthetic header
would corrupt the merkle-path service.

### Source

`GET <chaintracks>/getHeaders?height=&count=` returns hex of concatenated
80-byte headers. Live-verified 2026-07-28 on both deployments: main tip 959,884,
ttn tip 27,502, `count=5000` → 800 KB response. Chain-agnostic, which matters
because no bulk header CDN exists for ttn.

### Trust anchor

A checkpoint `{ height, blockHash }` per chain is **hardcoded in app source**,
dated roughly one year before release. Sync walks forward from it to tip,
validating every chunk with the toolbox's own
`chaintracks/util/blockHeaderUtilities` — `validateBufferOfHeaders` (prev-hash
linkage and difficulty) and `blockHash`. Nothing enters the store unless it
chains to a header we shipped, so the store does not inherit the server's word
for anything. Growth is about 4.2 MB per year; a later release bumps the
checkpoint and prunes.

### On-device shape

- `headers/<chain>.bin` — contiguous 80-byte records starting at `baseHeight`.
- `headers/<chain>.json` — `{ chain, baseHeight, count, tipHash, anchor, updatedAt }`.
- `headers/<chain>-extra.json` — sparse `height → merkleRoot` for roots resolved
  below `baseHeight` while online (see *root miss*).

At wallet build, one background pass streams the `.bin` and builds a 32-byte-per-height
root array in memory (~1.7 MB/year), making `isValidRootForHeight` an O(1)
comparison with no per-call I/O. Full headers stay on disk for validation and
extension. Initial sync is chunked, resumable, and progress-reported, off the
critical path — the wallet is usable while it runs, it simply cannot transact
offline until the first sync completes.

`currentHeight()` returns the remote height when online and the store tip when
not. Nothing in BEEF verification consults it; `TaskNewHeader` does, and that
task is network-bound anyway.

### Root miss

A miss means an ancestor was mined before `baseHeight`.

- **Online** — delegate to the remote client and persist the answer in
  `-extra.json`, so the same coin verifies offline next time.
- **Offline** — refuse that specific payment with a plain reason. Never accept
  unverified ancestry.

### Pre-warm

While online, walk this wallet's own spendable outputs' merkle paths and cache
the roots for exactly those heights. That set *is* what a counterparty's BEEF
will reference, because our UTXOs become their inputs. So the payer's pre-warm
is what makes the payee's offline verification succeed, and misses become rare
rather than merely handled.

## Connectivity and UI

NetInfo is currently read in three places (`context/WalletContext.tsx:1244`,
`:1268`, `:1333`). Consolidate on one source of truth — `isConnected &&
isInternetReachable !== false` — and re-point the existing call sites at it, so
"offline" means exactly one thing across the app.

- **`/pay` grid, offline:** nearby cells stay live; handle and address cells are
  disabled with a "needs internet" subtitle. The Pay/Get segmented control is
  unchanged.
- **Offline banner** on `/pay` with the queued count; tapping it lists queued
  offline actions and their statuses.
- **`ReceivedOverlay`** reads "Received offline · not yet broadcast", and flips
  to a broadcast state once `TaskSendOffline` reports success.
- **Rejection row** names the sender identity key, transport, and time, and is
  dismissible only after the user has seen it.

### The risk to state plainly

Accepting a transaction nobody has broadcast means the payer *can* double-spend
it once online. Headers prove ancestry; they cannot prove the absence of a
competing spend. No SPV check closes this, and it is inherent to the underground
scenario rather than a defect of this design. The mitigation is the attribution
record plus honest UI copy — never a claim of settlement.

## Testing

**Unit (jest, alongside the existing 210):**

- topological release ordering, including a three-deep chain where the middle
  transaction arrived first;
- rejection cascade: descendant statuses, `poisonedByTxid`, history-note contents;
- `offline_actions` CRUD and the `CREATE TABLE IF NOT EXISTS` upgrade path from a
  pre-existing database;
- header store: chunk validation accepts a good chain, rejects a broken
  prev-hash link, rejects insufficient difficulty, rejects a chunk that does not
  link to the checkpoint;
- `isValidRootForHeight` hit, miss-online (delegates and persists), miss-offline
  (refuses);
- offline dispatch in the `internalizeAction` override: online path calls
  `super`, offline path enqueues;
- transaction/req status pairs after each transition.

**Device (two physical iPhones, airplane mode):**

1. both online, sync headers, confirm store size and tip;
2. airplane mode both, pay A → B, confirm B's balance rises and B's history
   shows "not yet broadcast";
3. still offline, B pays C (third device or back to A) from the funds just
   received, from a starting balance of zero;
4. still offline, A makes a second payment funded by change from step 2 — this is
   the case the `nosend → unproven` promotion exists for;
5. restore network on one device only; confirm ordered broadcast, all
   transactions accepted, statuses settle;
6. restore the other device; confirm idempotency (already-in-mempool is treated
   as success, `arcadeBroadcastProvider.ts` already does this for WoC);
7. long-offline soak (> 12 h) to confirm no req reaches `invalid`.

Three additions the final whole-branch review identified, each covering a branch
that unit tests provably cannot reach:

8. **Checkpoint bump over a populated window.** Ship with anchor A, sync a
   window, bump the checkpoint to anchor B, relaunch, resync, then verify an
   offline payment still verifies and `rootForHeight` at a mid-window height is
   correct. This is the branch that shipped broken — the old `.bin` was left in
   place and appended to, so the root index rebuilt from the *previous* anchor's
   headers and every upgrading install would have refused all offline
   verification, permanently and silently. `expoHeaderFs.deleteFile` cannot run
   under Jest, so this is the only way to exercise the fix.
9. **Flaky signal, not just airplane mode.** Kill connectivity while leaving the
   interface up, so the internalize retry takes the merge path. That path credits
   the outputs but never holds and never creates a queue row, so the payment gets
   no attribution and no ordered release. Watch the monitor log for an orphan
   rejection during the reconnect drain.
10. **Record the numbers.** `HeaderStore.open` and `prewarmOwnRoots` wall-clock
    timings (both are logged), the `proven_txs` row count behind the pre-warm,
    and the on-disk size of `headers/<chain>.bin`. The standing goal is no JS
    block over 100 ms, and the only figure so far is a Node/V8 proxy that
    excludes native file I/O.

## Non-goals

- Handle and address rails offline. They need a message-box or an overlay
  lookup; neither works underground.
- Reorg handling deeper than the toolbox already does. The store extends and
  re-validates forward; a reorg below `baseHeight` is out of scope.
- Whole-chain header storage. Mainnet is 77 MB and the default chain is main.
- Any cryptographic defence against a payer double-spending an offline payment
  after reconnecting.
