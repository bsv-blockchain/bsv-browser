# Compressed-at-Rest R1-K1 Transactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store every R1-K1 script compressed everywhere it is stored, including inside transaction `rawTx`, and expand only where full bytes are genuinely required.

**Architecture:** A span envelope whose first byte (`0xfe`) makes unexpanded bytes *unparseable* rather than plausibly wrong, carrying the transaction's real txid so every expansion self-verifies by hashing. Compression happens at two write hooks; expansion at seven enumerated read functions plus a runtime assert patched into the SDK's parse primitives, because a branded type is erased crossing into `node_modules`.

**Tech Stack:** TypeScript, `@bsv/templates` R1K1Wallet, `@bsv/sdk`, expo-sqlite, patch-package, Jest, `node:sqlite`.

**Spec:** [docs/superpowers/specs/2026-08-19-tx-size-limits-and-blob-compression-design.md](../specs/2026-08-19-tx-size-limits-and-blob-compression-design.md) Part 1 (§4).

## Global Constraints

- Envelope magic is **`0xfe`** — distinct from the compressed-*script* marker `0xff`, and a value no rawTx (`01|02 00 00 00`), BEEF (`01|02 00 be ef`) or AtomicBEEF (`01 01 01 01`) can begin with. The two markers protect different things and must never be conflated.
- **In-place substitution with a rewritten length varint is forbidden.** It yields a syntactically valid transaction with a wrong txid, and nothing in the stack hashes stored bytes to notice.
- Expansion is **self-verifying**: expand → `hash256` → compare to the recorded txid → throw on mismatch.
- **Never compress** `proven_txs.rawTx` (until B5, behind its own flag), `proven_tx_reqs.rawTx` before B4, `merklePath`, or anything reached by `Beef.verifyBumpIndexLeaves` — once mined, the chain commits to `hash256(real bytes)`.
- Older builds are **not** a consideration. No migration, no backfill: rows written before the codec stay raw forever, and the absence of the magic is the codec flag.
- Verified layout constants (measured against the mined mainnet fixture, not assumed): locking script **959,632** bytes, canonical length varint `fe 90 a4 0e 00`; R1 unlocking script **959,871** = 65+34+33+5+959,733+1; preimage **959,733** pushed with `4e f5 a4 0e 00`; scriptCode at inner offset **246**, length **959,572**, varint `fe 54 a4 0e 00`; a real locking script starts `76 00 9c`.
- Commit after every task.

---

### Task 1: Append-only template registry

**Files:**
- Create: `services/vault/templateRegistry.ts`
- Create: `__tests__/vault/templateRegistry.test.ts`
- Modify: `services/vault/templateCodec.ts` (`describeVaultTemplate`, `referenceBytesFor`)

**Interfaces:**
- Produces: `TEMPLATE_REGISTRY: readonly RegistryEntry[]` where `RegistryEntry = { version: number; artifact: () => Promise<number[]>; regions: TemplateRegion[] }`
- Produces: `registryDigest(): Promise<string>` — SHA-256 over the serialised entry list.
- Produces: `entryForVersion(version: number): RegistryEntry | undefined`

**Why this is a prerequisite and not a nicety:** `describeVaultTemplate()` returns descriptors for exactly one `TEMPLATE_VERSION` and `referenceBytesFor` refuses every other, so **the first change to the vendored artifact makes every stored envelope permanently unexpandable** — in `proven_tx_reqs`, `transactions`, `proven_txs` and every backup at once. "No migration needed" silently becomes "migration impossible", and the victim is the current build's own data written by yesterday's binary. An append-only registry is what keeps expansion possible forever while compression only ever uses the newest entry.

- [ ] **Step 1: Write the failing test**

```ts
import { TEMPLATE_REGISTRY, entryForVersion, registryDigest } from '@/services/vault/templateRegistry'

it('contains version 2 and nothing has been removed', async () => {
  expect(TEMPLATE_REGISTRY.map(e => e.version)).toEqual([2])
  // A committed golden digest: if a historical entry is ever mutated or
  // dropped, this fails rather than silently orphaning stored envelopes.
  expect(await registryDigest()).toBe('<computed on first run, then pinned>')
})

it('resolves an entry by version and refuses an unknown one', () => {
  expect(entryForVersion(2)).toBeDefined()
  expect(entryForVersion(3)).toBeUndefined()
})

it('always compresses with the newest version', () => {
  expect(TEMPLATE_REGISTRY.at(-1)!.version).toBe(Math.max(...TEMPLATE_REGISTRY.map(e => e.version)))
})
```

- [ ] **Step 2-4: Run, implement, verify, commit**

```bash
git add services/vault/templateRegistry.ts __tests__/vault/templateRegistry.test.ts services/vault/templateCodec.ts
git commit -m "feat(vault): append-only template registry so stored envelopes stay expandable"
```

---

### Task 2: Codec to `Uint8Array` end to end

**Files:**
- Modify: `services/vault/templateCodec.ts` (`matchesTemplate`, `compressScript`, `compressScriptCode`, `expandScript`, `isCompressed`)
- Modify: `__tests__/vault/templateCodec.test.ts`

**Interfaces:**
- Produces: the same five functions accepting and returning `Uint8Array`, plus thin `number[]` adapters (`compressScriptArray`, `expandScriptArray`) so existing callers and tests compile unchanged.

`Array.from(reference)` is a **measured 13.16 MB per call** and every expansion pays it. `reference.slice()` on a `Uint8Array` is a single typed-array copy. This must land whole: a partial migration pays 24 ms per `Array.from` plus double hashing at every crossing.

- [ ] **Step 1: Add the Uint8Array core with adapters, keeping the existing suite green unchanged**
- [ ] **Step 2: Add a test asserting the core allocates a `Uint8Array`, not an array**
- [ ] **Step 3: Verify and commit**

```bash
npx tsc --noEmit && npx jest __tests__/vault
git add services/vault/templateCodec.ts __tests__/vault/templateCodec.test.ts
git commit -m "perf(vault): run the template codec on Uint8Array end to end"
```

---

### Task 3: The span envelope

**Files:**
- Create: `services/vault/txEnvelope.ts`
- Create: `__tests__/vault/txEnvelope.test.ts`

**Interfaces:**
- Produces: `ENVELOPE_MAGIC = 0xfe`, `ENVELOPE_VERSION = 1`
- Produces: `isEnvelope(bytes: Uint8Array | number[]): boolean`
- Produces: `compressTransaction(rawTx: Uint8Array, txid: string): Promise<Uint8Array>` — returns the input unchanged when nothing matched.
- Produces: `expandTransaction(envelope: Uint8Array): Promise<Uint8Array>` — self-verifying.
- Produces: `readEnvelopeRange(envelope: Uint8Array, offset: number, length: number): Promise<Uint8Array>`
- Produces: `envelopeTxid(envelope: Uint8Array): string`

Layout:

```
magic(1)=0xfe | version(1) | flags(1) | txid(32, internal order)
  | origLength(4 BE) | spanCount(1)
  | spanCount × { offset(4 BE) | region(1) | recLen(2 BE) | record }
  | literalLen(4 BE) | literal
```

**Discovery is structural, never a byte search.** Region `0x02` is a byte-for-byte suffix of region `0x01`, so a sliding-window matcher produces overlapping ambiguous spans. Walk the transaction instead: `version(4)` → varint `nIn` → per input `{ skip 36, read varint L; if L === 959,871 test the inner window at offset 246 length 959,572 against region 0x02; skip L + 4 }` → varint `nOut` → per output `{ skip 8, read varint L; if L === 959,632 test region 0x01; skip L }` → `skip 4` and assert the cursor lands exactly on the buffer end.

Use **one** varint reader throughout: `Transaction.fromReaderInternal` uses `readVarIntNum()` while `BeefTx.scanRawTransaction` uses `readVarIntNum(false)`, and they disagree on `0xff`-prefixed high-bit counts.

- [ ] **Step 1: Write the failing tests** — the round trip against the mined mainnet fixture; a synthetic 1-in/2-out withdrawal with a re-vault output; a **non-canonical varint** transaction that must round-trip to the ORIGINAL txid rather than being normalised; `readEnvelopeRange` at a recorded `scriptOffset`/`scriptLength` byte-compared against the original; a tampered record failing the txid check; spans out of order refused; `0xfe` never beginning a valid rawTx/BEEF/AtomicBEEF.
- [ ] **Step 2-4: Run, implement, verify, commit**

```bash
git add services/vault/txEnvelope.ts __tests__/vault/txEnvelope.test.ts
git commit -m "feat(vault): self-verifying span envelope for R1-K1 transactions"
```

---

### Task 4 (B3): Install the expansion boundary as a behavioural no-op

**Files:**
- Modify: `storage/StorageExpoSQLite.ts` — E1 `getProvenOrRawTx` (:1220), E2 `getRawTxOfKnownValidTransaction` (:1235), E3 `findOutputs` script loop (:785), E4 `findTransactions` (:864), E5 new `mergeReqToBeefToShareExternally` override
- Create: `patches/@bsv+sdk+<version>.patch` additions — `assertExpanded` at the top of `Transaction.fromBinary`, `fromBinaryView`, `Beef.mergeRawTx`, `BeefTx.scanRawTransaction`, in **both** `dist/cjs` and `dist/esm`
- Create: `patches/@bsv+wallet-toolbox-mobile+<version>.patch` additions — E6 `getBeefForTransaction.js:121,129`, E7 `TaskCheckForProofs.js:117`
- Modify: `context/WalletContext.tsx` — `services.postBeefServices.remove('ArcadeBeef')`

Ships with nothing compressed, so behaviour is unchanged and the boundary can be proven before it matters.

**E7 must split its outcome:** an *unexpandable* blob must NOT become `status='invalid'` — that transition is irreversible and cascades to every notified transaction. Only successfully-expanded bytes that hash wrong are genuinely invalid.

**CI must fail hard when any patch does not apply.** A dropped patch degrades to today's behaviour, which is quieter than crashing and therefore worse.

- [ ] Steps: write the integration test that force-compresses one synthetic req in a scratch DB and drives create → sign → processAction → broadcast → **mine** → `TaskCheckForProofs`; add the hooks; add the patches; assert every expansion in the run originated at one of the seven boundary functions.

---

### Task 5 (B4): Compress `proven_tx_reqs.{rawTx,inputBEEF}` and `transactions.inputBEEF`

Hook `insertProvenTxReq`/`updateProvenTxReq`/`insertTransaction`/`updateTransaction`, plus write-side envelope assertions in `sqlInsert`/`sqlUpdate`/`sqlUpdateComposite`.

**Primary success criterion for the whole programme:** on a real device, after a deposit and a withdrawal, `estimateEncodedBytes` clears `MAX_BLOB_BYTES` and the backup cursor **advances**. Also: two `TaskCheckForProofs` sweeps with no req reaching `status='invalid'`, and `TaskSendWaiting` reading ~500 bytes per req instead of ~1.9 MB.

---

### Task 6 (B5): Compress `proven_txs.rawTx`, behind its own flag

Only after B4 has run on a real device through a full deposit → withdrawal → proof cycle. That row **is** the merkle evidence, and `Beef.verifyBumpIndexLeaves` binds `hash256(rawTx)` to a chain-committed BUMP leaf — the one gate no subclass can intercept. Verification: spend a vault output whose source is a compressed `proven_txs` row and assert `beef.verify()` at `createAction.js:495` passes.

---

### Task 7 (B6): Sync chunks and a peer capability flag

`getSyncChunk` calls `findOutputs` without `noScript`, so a full ~960 KB script enters the chunk for a column the origin device stores as NULL. Compress it there, and gate sync on a declared capability: `storage/portable/index.js` base64s byte columns verbatim and neither `getSyncChunk` nor `processSyncChunk` inspects them, so envelopes replicate to peer storage with no signal — and byte-for-byte entity diffs mean a mixed fleet sees every record as changed and re-pushes forever.

---

## Self-review

**Spec coverage (§4):** registry §4.4 → Task 1; `Uint8Array` B1 → Task 2; envelope §4.1-4.2 → Task 3; boundary §4.3 B3 → Task 4; B4 → Task 5; B5 → Task 6; B6 → Task 7. Backup envelope versioning §4.6 rides with Task 7, since both concern what leaves the device.

**Staging rationale:** Tasks 1-3 change no stored bytes and no behaviour — they are provable in tests alone. Task 4 installs the boundary while still writing raw, so a missed seam surfaces before it can corrupt anything. Only Task 5 changes what is written, and its success criterion is a device observation, not a test. Tasks 6-7 are gated on Task 5 having run on hardware.

**What is NOT worth doing:** compressing `merklePath` (small, and identity-bearing), compressing `outputs.lockingScript` ahead of the envelope (it is NULL for vault outputs — `maxOutputScript` is 1024 — so there is nothing there to compress), and any attempt to make the compressed form parseable by `Transaction.fromBinary` (spec §2.1).

**Type consistency:** `TEMPLATE_REGISTRY`, `entryForVersion`, `registryDigest` in `templateRegistry.ts`; `ENVELOPE_MAGIC`, `ENVELOPE_VERSION`, `isEnvelope`, `compressTransaction`, `expandTransaction`, `readEnvelopeRange`, `envelopeTxid` in `txEnvelope.ts`; the `Uint8Array` core plus `compressScriptArray`/`expandScriptArray` adapters in `templateCodec.ts`.
