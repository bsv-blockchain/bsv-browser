# M5 · Tier-3 Design — Native Transaction Engine (FINAL, synthesized)

**Repo:** `/Users/johncalhoun/bsv/bsv-browser` (branch `native-crypto`) · **Engine:** `/Users/johncalhoun/bsv/bsv-rs` (path dep) · **Governing doc:** `NATIVE-CRYPTO-STANDARD.md` (gates 1–7, reality ladder, Tier-3 row) · **Provenance:** Design A (minimal-first) skeleton + grafts from Design B (engine-first), adjudicated 2026-07-21.

**Design prior: MINIMAL-FIRST.** Tier-3 v1 is *not* "bsv-rs as an API." It is two batch calls that kill the two measured per-input ~0.5ms JS cost centers (sign-path sighash, verify-path sighash+Spend), plus a read-only BEEF stretch. Everything else in bsv-rs stays un-exported until a measured number demands it. The kill-test runs in week 1, before any Nitro/packaging investment.

---

## 1. Scoped engine surface v1

### FIRST (M5.A — sign path; the ~25ms of the 26.84ms 50-input floor)
- `batch_sign_p2pkh_inputs(unsignedTx, inputsMeta) → framed unlockingScripts` — replaces the entire batch block `#8` in `patches/@bsv+sdk+2.1.6.patch` (`resolveSourceDetails` O(n²), uncached `formatBip143` O(n²) hashing, `number[]` Writer, 2 hash crossings/input, DER glue, and the ~6.5ms cooperative-slicing tax). Midstates (hashPrevouts/hashSequence/hashOutputs) computed **once** per scope-class in Rust; sign via `PrivateKey::sign` (RFC6979, forced low-S — byte-identical to SDK); output via `TransactionSignature::to_checksig_format`. One async crossing. **Native returns unlocking scripts; JS splices the tx exactly as today** — the byte-parity surface is the script bytes only, never native tx re-serialization.
- `compute_sighash_signing_order(rawTx, inputIndex, subscript, satoshis, scope) → 32B` — conformance/debug export, never routed in prod. **Signing-order only**: bsv-rs's display-order `compute_sighash` (sighash.rs:401) never appears at the seam; only `compute_sighash_for_signing` (sighash.rs:421) does. The order-confusion sig-invalidation trap dies at the API.

### SECOND (M5.B — verify leg; consumes the proven-but-unconsumed batchEcdsaVerify debt, M3 asterisk 6)
- `batch_verify_p2pkh_inputs(signedTx, prevoutsMeta) → verdict byte/input` — replaces toolbox `completeSignedTransaction.js:122-168` `verifyUnlockScripts` (fresh JS `Spend` per input + n sync ~250µs crossings). Mandatory P2PKH shape check (exactly push(sig‖scopeByte) + push(33B pubkey), hash160(pubkey)==lock pkh); any other shape → `Err(NotP2pkh{i})` and JS runs the full `Spend` interpreter on that input. Never silently weaken validation. **Rollout is shadow-mode first** (graft from B): phase 1 runs native AND JS, logs divergences, JS authoritative; phase 2 cuts over with per-input JS re-run on native failure for identical error text.

### THIRD (M5.C — stretch, read-only BEEF; do NOT sequence before M5.B)
- `beef_verify_structure(beef) → [u32 count]([u32 height][32B root, display order])*` — `Beef::from_binary` + `is_valid` + `MerklePath::compute_root`, replacing `internalizeAction`'s hex-string-domain hashing (`MerklePath.js:222/265/422`). JS keeps `chainTracker.isValidRootForHeight` — a "BEEF verified" claim = structural + roots + JS-checked headers, never structural alone.
- `beef_to_ef(beef, txid32) → efBytes` — replaces the `services/arcadeBroadcastProvider.ts:46-49` serialize→reparse→toEF round-trip (the pure-JS interim fix — `findAtomicTransaction` + `toEFUint8Array` — ships regardless). During rollout, dev builds carry a byte-equality assert vs the JS result on every call (graft from B).
- **BEEF merge/`sortTxs`/`toBinaryAtomic` stays JS in v1.** Native never re-emits BEEF — the BRC-95/96 ordering subtleties make byte-different-but-valid re-serialization a real e2e-proof breaker. Entry criterion for a future native emit path (v2): B's `beef_roundtrip` byte-equality fuzz class (random dependency graphs, merge/sort/toBinaryAtomic byte-equal vs JS `Beef`, ≥10k green) — recorded here so v2 starts with its gate defined.

### Explicitly stays JS (enumerated, gate 6 — every path dev-logged)
1. Toolbox orchestration: storage JSON-RPC `createAction`/`processAction`, dcr/vout mapping, fee/change, BRC-29 grouping (already batched via `batchBrc42DeriveChild`).
2. Non-P2PKH `unlockingScriptTemplate` polymorphism (PushDrop, RPuzzle, custom) — mixed txs sign P2PKH inputs natively, others in JS.
3. Fallback classes (tested, per-input): `customK`, `forceLowS !== true`, scope without SIGHASH_FORKID, SIGHASH_CHRONICLE/OTDA preimage (bsv-rs has no legacy/OTDA path; `spend.rs:1447` hard-rejects non-FORKID), missing `sourceSatoshis`/`lockingScript`, non-P2PKH lock shape.
4. Scalar/domain edges per the ratified Tier-1 surface.
5. Hex-txid↔bytes at storage/API boundaries; the complete pure-JS path for web/jest/Expo Go (the seam's probe philosophy — engine is an accelerator, never a dependency).
6. ChainTracker network calls; broadcast HTTP (bsv-rs `http` feature not enabled).
7. Full script-interpreter validation of arbitrary scripts (JS `Spend` authoritative for non-P2PKH; native `Spend` export is a v2 candidate after shadow-mode data).

### NOT exported in v1 (bsv-rs has it; no measured demand)
General `Transaction` parse/serialize API, `Spend`, `MerklePath::combine`, BEEF merge/`to_binary_atomic`, keys/addresses (Tier-1 covers), async `Transaction::sign`/`verify` (would drag an executor into the staticlib; the sync path covers everything). Non-goals: Tier-4 key handles, legacy sighash in bsv-rs, Android, promoting the flag-parameterized node-vector census wholesale.

---

## 2. Crate / workspace architecture

```
bsv-browser/
  native-engine-ffi/                    # standalone-workspace crate ([workspace] header, committed Cargo.lock)
    Cargo.toml                          # bsv-rs = { path = "../../bsv-rs", default-features = false, features = ["transaction"] }
                                        # uniffi 0.28 [cli]; crate-type [lib, cdylib, staticlib]; [profile.release] lto=true, codegen-units=1
                                        # K256-BOUNDARY-CONTRACT block copied from a prior proven UniFFI staticlib crate
    BSV-RS-PIN.md                       # bsv-rs commit hash recorded per build (graft from B)
    src/lib.rs                          # #[uniffi::export] fns — Vec<u8>/u32/u64/String only
    tests/conformance_engine.rs         # $BSV_CONFORMANCE_DIR replay, pinned census
    scripts/build-engine-xcframework.sh
  packages/react-native-engine-native/  # mirrors packages/react-native-secp-native exactly
```

**Two crates; secp-native FROZEN.** No k256 collision exists today (secp-native = rust-secp256k1 0.31; bsv-rs = k256 0.13.4) — the split preserves the M1–M4 proof chain (155,148 fuzz cases, 53/53 device conformance) binary-identical while the engine iterates. Two staticlibs in one app target is a proven shape; the `Headers/<FFI_MODULE>/module.modulemap` nesting fix is mandatory.

**k256-pin strategy (four guards):** (1) engine crate may link bsv-rs freely but never any dkls crate — sibling of, never dependency of, anything dkls; bytes-only seam, no k256/secp256k1 type ever crosses FFI. (2) Committed Cargo.lock + build-script grep: fail if the lock contains k256 outside 0.13.x or any dkls crate. (3) Mechanical `cargo tree -e normal` check (graft from B): must show exactly one `k256 v0.13.*` and zero matches for `dkls|sl-mpc-mate|multi-party`; any other result hard-fails. (4) bsv-rs is consumed from crates.io, exactly pinned; the source commit is recorded in native-engine-ffi/BSV-RS-PIN.md.

**Ownership note (corrected from A):** the sighash midstate cache lives engine-side; if it genuinely needs bsv-rs API additions (e.g. `SighashParams`), they land in bsv-rs via normal process — bsv-rs is Calgooon-owned. What stays owner-gated is anything PR'd to ts-stack SDK or bsv-blockchain upstreams (gate 7 / epoch D-gates).

**Build script:** copy `native-secp-poc/scripts/build-secp-xcframework.sh` → rename (CRATE_NAME/LIB_NAME/SWIFT_MODULE=EngineNative/FFI_MODULE=engine_native_ffi). All five encoded deltas carry over: no root-lock seeding; fat simulator slice (`aarch64-apple-ios-sim` + `x86_64-apple-ios` via lipo); extern-C guard injection anchored on `#include <stdint.h>` with assert (Nitro objcxx mangling); nested `Headers/<module>/module.modulemap`; direct uniffi-bindgen with CWD=crate root. Podspec auto-runs `sync-xcframework.sh`, never copies a second header/modulemap; UniFFI globals as file-scope `private let`s. Pin uniffi 0.28. `DEVELOPER_DIR=/Applications/Xcode-26.3.app`. Rebuild both xcframeworks together after any rustc bump (std dedup rule).

**Size:** expect 45–60MB/slice pre-link (beef-ios-ffi with `transaction` = 45.7MB), dead-stripping to low-single-digit MB shipped (secp precedent: 41MB slice → ~1.2MB in the 25.5MB Release binary). Authoritative check = app archive with/without, per RESULTS.md's own rule.

---

## 3. Seam API (bytes-only)

**Framing convention (documented once, in `src/lib.rs` and the Nitro spec — graft from B):** multi-value buffers are `[u32-LE count]` then records; fixed-width fields raw; variable-width fields `[u32-LE len][payload]`. Txids cross in internal byte order; JS converts at the hex boundary. All fns return `Result<_, EngineError>` → Swift throws → Promise reject; **reject-on-any-invalid-element**, caller falls back per-op to JS (the M3 contract).

```rust
#[derive(uniffi::Error, Debug, thiserror::Error)]
pub enum EngineError { BadFraming, TxParse, NotP2pkh { input_index: u32 }, UnsupportedScope { input_index: u32 }, IndexOutOfRange, BeefInvalid }

/// inputsMeta: N fixed 73-byte records: [u32 LE inputIndex][32B privkey][u64 LE satoshis][u32 LE sigScope][25B P2PKH lockingScript]
/// Outpoints + sequences are read from unsignedTx itself — never duplicated in meta (single source of truth).
/// Returns framed per-record: [u32 LE inputIndex][u8 len][unlockingScript] where script = push(DER‖scopeByte) push(pubkey33).
/// Only FORKID, non-CHRONICLE scopes accepted. Privkey scalars zeroized after use.
pub fn batch_sign_p2pkh_inputs(unsigned_tx: Vec<u8>, inputs_meta: Vec<u8>) -> Result<Vec<u8>, EngineError>;

/// prevoutsMeta: N fixed 37-byte records: [u32 LE inputIndex][u64 LE satoshis][25B lockingScript]
/// Returns N verdict bytes (1/0), same order. Non-P2PKH-shaped input → Err(NotP2pkh{i}) → that input goes to JS Spend.
pub fn batch_verify_p2pkh_inputs(signed_tx: Vec<u8>, prevouts_meta: Vec<u8>) -> Result<Vec<u8>, EngineError>;

/// Conformance/debug only. SIGNING order only — display-order intentionally not exported.
pub fn compute_sighash_signing_order(raw_tx: Vec<u8>, input_index: u32, subscript: Vec<u8>, satoshis: u64, scope: u32) -> Result<Vec<u8>, EngineError>;

// ── M5.C (stretch, read-only) ──
pub fn beef_verify_structure(beef: Vec<u8>) -> Result<Vec<u8>, EngineError>;  // [u32 count]([u32 height][32B root display-order])*
pub fn beef_to_ef(beef: Vec<u8>, txid: Vec<u8>) -> Result<Vec<u8>, EngineError>;

pub fn engine_version() -> String;  // "bsv-rs <hash> / engine-ffi 0.1.0" — probe + proof-artifact stamping
```

Implementation is thin composition over mature bsv-rs API: `Transaction::from_binary`, `compute_sighash_for_signing`, `PrivateKey::sign`, `TransactionSignature::{from_components,to_checksig_format}`, hash160, `Beef::from_binary`, `MerklePath::compute_root`. No async, no tokio, no `http`.

**Nitro spec** (`packages/react-native-engine-native/src/specs/EngineNative.nitro.ts`): `version(): string` sync; `batchSignP2pkhInputs` / `batchVerifyP2pkhInputs` / `computeSighashSigningOrder` / (M5.C) `beefVerifyStructure` / `beefToEf` as `Promise<ArrayBuffer>`. Swift copies the `HybridSecpNative.swift:164-208` pattern verbatim: **`toData(copyIfNeeded: true)` on the JS thread BEFORE dispatch**, then `Promise.parallel { ArrayBuffer.copy(...) }`. Satoshis cross as JS `number` (SDK is number-bound ≤2^53; u64 is framing-internal).

**JS integration:** (1) Sign — extend batch block `#8` in `patches/@bsv+sdk+2.1.6.patch` (cjs+esm): eligibility scan (all-P2PKH template + FORKID + no customK + forceLowS + sourceSatoshis/lockingScript present), build 73B meta with one `Uint8Array`/`DataView`, one crossing, wrap returned scripts as `UnlockingScript` chunks; ineligible → existing JS path, dev-logged; delete cooperative slicing once measured clean. Interim JS win ships regardless: one shared `SignatureHashCache` threaded through the fallback loop (kills O(n²) for web/jest/Expo Go). (2) Verify — patch toolbox `verifyUnlockScripts`: shadow-mode → cutover as above. (3) BEEF (M5.C) — `internalizeAction` `validateAtomicBeef` + `arcadeBroadcastProvider.ts` `beefToEF`.

---

## 4. Conformance strategy

**Corpus pin first:** pin an exact ts-stack commit (disk = 73 files/6,650 vectors vs stale META 6,646; `sync/brc136-basm.json` missing from PARITY_MATRIX), rerun `recount-meta.mjs`, regen PARITY_MATRIX, record the hash in `native-engine-ffi/tests/` and re-sync the bsv-fuzz verbatim copy per its SOURCE.md rule. New vectors go upstream in ts-stack (append-only, stable IDs, per VECTOR-FORMAT.md) — never edit the copy.

**Vector replay** (host rung → device rung, through the real FFI fns, `$BSV_CONFORMANCE_DIR` pattern from `bsv-rs/tests/conformance_scripts.rs`): the 2,000 node-sighash fixtures in `vectors/sdk/scripts/evaluation.json` (FORKID `regular_hash` side; legacy `original_hash` = pinned-unsupported class — build the engine's own census, do NOT copy bsv-rs's blindly); the 161 whole-tx verify fixtures (P2PKH subset via `batch_verify_p2pkh_inputs`, rest pinned per flag class); `tx-sequence-zero-sighash.json` (3, ts-sdk#371); `serialization.json` (15); M5.C: `merkle-path.json` (16, `mp-compound-001` resolved or pinned with rationale), `merkle-path-odd-node.json` (5), `beef-v2-txid-panic.json`, `beef-isvalid-hydration.json`, `fee-model-mismatch.json` (graft from B). Crypto vectors (ecdsa/signature/hashes) already green via secp-native — not re-plumbed.

**NEW upstream vectors:** (1) `sdk/scripts/sighash-preimage.json` (~200): full BIP-143 preimage BYTES from patched SDK `formatBip143` — ALL/NONE/SINGLE × ±ANYONECANPAY × SINGLE with `inputIndex ≥ outputs.length` (the SDK's usesOtdaSingleBug constant-0x01 digest — named explicitly, graft from B) × sequence 0/max × satoshi edges. The localization tool hash-only vectors can't provide. (2) `sdk/transactions/p2pkh-sign.json`: `{unsignedTxHex, per-input meta}` → exact signed tx hex (RFC6979 determinism) — narrows the demoted createaction(90)/signaction(8) gap without the funded mock harness. (3) M5.C: BEEF_V2 round-trip + atomic-success + BEEF→roots positive corpus (only 6 BEEF vectors exist today) + `merkle-dup-txid.json` — CVE-2012-2459 duplicate-txid trees and compound-BUMP tree-height cases (graft from B).

**Differential fuzz (gate 2, extend the differential-fuzz NDJSON harness; JS oracle = the app's exact patched sdk-2.1.6 dist):**
- `p2pkh_sign_flow` — byte-equality on the FULL signed tx (JS assembles from returned scripts). Adversarial generator: n∈[1,64], ALL/NONE/SINGLE × ±ANYONECANPAY × FORKID, SINGLE with index≥outputs, CHRONICLE-flagged inputs that MUST Err to fallback (graft from B), sequence 0/max, satoshis {0,1,2^32,2^53−1}, duplicate outpoints. **≥100k cases, 0 unexplained mismatches** before any routing.
- `sighash_preimage` — preimage + hash byte-equality vs `formatBip143`. ≥100k.
- `p2pkh_verify` — mutated signed txs → verdict-equality vs JS Spend+ecdsaVerify; native must never accept what JS rejects. ≥50k.
- `beef_roots` (M5.C) — beefHex → roots vs JS `MerklePath.computeRoot`. ≥10k.

**Reality ladder (gate 3), each rung a recorded artifact in `M5-RESULTS.md`:** host cargo conformance+fuzz → simulator (fat slice) → physical device Release conformance + per-op p50/p90/p95 before/after tables → app-integrated (real Metro/Nitro path) 50-input sign + createAction with frame-drop trace (gate 4's real number; ~0.5s warmup per device-bench rule) → tiny-UTXO mainnet TXID through native sign+verify (gate 5), WoC-verified with `TAAL_API_KEY` set, plus a second round-trip proving the change output spendable.

---

## 5. Milestones & sequencing

Nine issues, M5.1→M5.2→M5.3 (KILL-TEST GATE, week 1) → {M5.4, M5.5} → M5.6 → M5.7 → M5.8; M5.9 stretch after M5.6. ~4–6 wk, matching the standard's Tier-3 row. Perf targets: 50-input sign p50 ≤10ms hard gate (vs 33.34ms sliced / 26.84ms floor), ≤8ms aspirational, ZERO dropped frames, slicing deleted. If the routed number doesn't clear the hard gate, M5-RESULTS.md says so plainly — measured, not vibes.

## 6. Biggest risk & kill-test

**Risk (fund-loss class, not perf class):** silent byte-divergence between native and `@bsv/sdk@2.1.6` signed-tx bytes on sighash edges — three named families: (a) SIGHASH_SINGLE with `inputIndex ≥ outputs.length` (usesOtdaSingleBug constant-0x01 digest), (b) CHRONICLE/OTDA scope leaking into the FORKID-only engine instead of Err→JS-fallback, (c) display-order vs signing-order hash swap (well-formed, verifiable-in-isolation, consensus-invalid signatures). The 2,000 existing vectors assert only final hashes, so a preimage bug is visible but unlocalizable. Mitigations built into the design: (c) is structurally removed at the seam (signing-order only); the preimage-level vectors make every failure localizable to a specific BIP-143 field; the read-only BEEF stance removes the re-serialization drift class entirely.

**Kill-test:** see the killTest field — M5.3 as a week-1 spike, before Nitro/packaging investment. Any mismatch class not attributable to a documented, fallback-routed SDK behavior stops M5 and forces a re-scope. Final backstop: the gate-5 tiny-UTXO mainnet round-trip before any real value.