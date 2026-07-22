# Native crypto benchmarks — measured on physical devices

Every number in this document was measured on a **physical iPhone in a Release
build** (release Hermes, embedded `main.jsbundle`, no Metro attached) unless a
row explicitly says otherwise. Reproduce recipes are at the bottom.

**Devices**

| label | device | chip | iOS |
|---|---|---|---|
| A13 (conservative floor) | iPhone 11 Pro Max | A13 | 26.5 |
| A15 (headline) | iPhone 13 Pro Max | A15 | 26.5.2 |

Builds were signed with a throwaway development identity (a scratch bundle id +
personal development team, empty entitlements) so anyone with any Apple
developer account can reproduce them; nothing in the measurement depends on the
identity. The proof harness flag (`EXPO_PUBLIC_SECP_PROOF=1`) is inlined at
`expo export:embed` time, so the measured bundle is the release Hermes bundle.

---

## 1 · Per-op: routed native vs the SDK's pure-JS EC

A15, Release, N=200 iterations per op, ~500 ms same-op warmup,
per-iteration `performance.now()` percentiles. "Routed" = the same `@bsv/sdk`
call with the SecpNative Nitro module installed; "pure JS" = identical call
with the native module removed (the SDK's own EC path).

| op | routed p50 µs | pure-JS p50 µs | speedup (p50) |
|---|---|---|---|
| `ECDSA.sign` (forceLowS) | 194.3 | 8,003.7 | **41×** |
| `ECDSA.verify` | 253.4 | 7,747.9 | **31×** |
| `PrivateKey.toPublicKey` | 117.3 | 7,184.9 | **61×** |
| `PrivateKey.deriveChild` (BRC-42) | 182.1 | 7,476.5 | **41×** |
| `PublicKey.deriveChild` (BRC-42) | 215.0 | 11,270.9 | **52×** |
| `PrivateKey.deriveSharedSecret` | 208.7 | 7,180.9 | **34×** |
| `Signature.RecoverPublicKey` | 212.3 | 11,943.8 | **56×** |
| `Signature.CalculateRecoveryFactor` | 213.6 | 11,847.8 | **55×** (77× by mean) |
| `Schnorr.generateProof` | 1,539.6 | 11,506.9 | **7.5×** |
| `Schnorr.verifyProof` | 446.0 | 15,763.2 | **35×** |

A later re-recording on the same phone (plus the A13 floor) showed a uniform
+6–16 % clock/thermal drift in **both** columns — the ratios hold (44×/32×/62×
vs 42×/31×/61×). A13 routed p50s run only 1.05–1.13× slower than A15 on single
ops (the ~150–215 µs per-call seam cost is similar on both chips).

`Schnorr.generateProof` still carries two JS point multiplications at the seam
boundary, hence the lower ratio; it is an identified follow-up candidate.

## 2 · Flow: 50-input `Transaction.sign`

One `batchSignP2pkhInputs` crossing signs all 50 inputs (BIP-143 midstates
computed once per sighash-scope class, RFC 6979 low-S ECDSA in libsecp256k1);
JS builds the unsigned skeleton + one 73-byte meta record per input and splices
the returned unlocking scripts. 16 iterations, Release:

| leg | A13 min/p50/p95 ms | A15 min/p50/p95 ms |
|---|---|---|
| **engine-routed (tier 1, one crossing)** | 5.61 / **5.70** / 6.06 | 4.43 / **4.59** / 4.80 |
| tier-2: SecpNative-batched ECDSA, shared sighash cache, time-sliced | 20.83 / 21.20 / 22.01 | 16.91 / 17.48 / 17.78 |
| tier-3: pure JS (no natives) | 833.7 / 833.8 / 834.0 | 816.5 / 816.6 / 817.0 |
| seam only: `batchSignP2pkhInputs` (native cost floor) | 2.19 / 2.20 / — | 1.74 / 1.76 / — |

- The design hard gate — routed 50-input sign **p50 ≤ 10 ms judged on the A13
  floor** — passes at 5.70 ms (43 % headroom).
- An earlier recording of the tier-2 leg on the same A15 phone (before the
  shared `SignatureHashCache`): batched **33.34 ms**, routed singles 39.23 ms,
  original unpatched pure-JS loop **461.6 ms** — i.e. the secp tier alone takes
  50-input signing 461 ms → 33 ms, and the engine tier takes it to **4.6 ms
  (≈100× end to end on the A15, 146–178× vs the shipped no-native fallback)**.

### 20-key BRC-42 `deriveChild` (one batched crossing)

| leg | A13 p50 ms | A15 p50 ms |
|---|---|---|
| batched (one crossing) | 0.12 | 0.09 |
| routed singles | 3.71 | 3.16 |
| pure JS | 23.11 | 19.07 |

20 child keys in one crossing ≈ 3.5–6 µs/key amortized (ECDH computed once per
counterparty) — ~**250×** the original pure-JS flow in the first A15 recording
(0.07 ms vs 17.58 ms).

## 3 · Verify: 50-input `verifyUnlockScripts`

The wallet-toolbox `verifyUnlockScripts` P2PKH loop (fresh `Spend` per input,
O(n²) hashing) vs ONE async `batchVerifyP2pkhInputs` crossing, 12 iterations:

| leg | p50 ms |
|---|---|
| JS per-input `Spend` loop | 167.2 |
| one `batchVerifyP2pkhInputs` crossing | **3.05** (**~55×**) |

Shipped in **shadow mode**: the JS `Spend` loop remains authoritative; the
engine verdict runs alongside, divergences are counted and logged loudly, and
the JS verdict is never replaced (see `__tests__/verifyShadowRouting.test.ts`).

## 4 · Frame harness — does signing still jank the JS thread?

rAF heartbeat on the RN JS thread while a createAction-scale workload (20
BRC-42 derivations + 20-input `Transaction.sign`) runs; a frame counts as
dropped at ≥1.5× the measured idle rAF budget (both phones ticked at 60 Hz).

| scenario | device | dropped frames | longest stall ms |
|---|---|---|---|
| **engine-routed sign** | A13 | **0** | 20.0 |
| **engine-routed sign** | A15 | **0** | 16.9 |
| secp-batched (engine off) | A13 | 0 | 24.3 |
| secp-batched (engine off) | A15 | 0 | 16.7 |
| pure JS, original unpatched path (first A15 recording) | A15 | **38** | **249.3** |
| pure JS, shipped sliced fallback | A13 / A15 | 8 / 5 | 84.0 / 55.1 |

The engine-routed path needs no cooperative time-slicing to stay clean —
there is nothing left on the JS thread to slice. (The shipped no-native
fallback keeps the time-sliced loop, which is why even pure-JS improves from
38 dropped frames to 5–8.)

## 5 · Sustained load (thermal soak)

**47,056** engine-routed 50-input signs — **2,352,800 signatures** — run
continuously over **300.003 s** on the A13: no thermal cliff (no sustained p50
ramp, no p95 blow-out), and the main/UI thread appears in 11 of 30,643 app CPU
samples (0.04 %) during the soak. A second soak on an independent build
reproduced the shape (46,332 ops / 93 buckets).

## 6 · Conformance — the gate behind every number

Byte-for-byte parity against this exact `@bsv/sdk` version is the merge gate
for every native path; performance claims above are meaningless without it.

- **~400,000 differential-fuzz cases vs the patched `@bsv/sdk@2.1.6`, 0
  mismatches** across the effort — 155,148 cases against the secp seam (sign /
  verify / recover / BRC-42 / Schnorr / ECDH), and a 400k-case final gate on
  the shipping engine crate (sign-flow, mixed-template sign, preimage, and a
  100k-case / 1.4M-input verify stratum). The full corpus generator lives in
  our differential-fuzz harness (NDJSON oracle vs the SDK dist) — happy to
  contribute it upstream or run it against any revision on request.
- **In this repo, runnable by reviewers:**
  - `native-secp-poc/fixtures/vectors.json` — SDK-generated vectors replayed
    byte-for-byte by `cargo test` (`native-secp-poc/tests/conformance.rs`),
    plus a ts-sdk-HEAD cross-check fixture;
  - `native-engine-ffi/tests/` — spike-parity oracle, k256-vs-libsecp DER
    crosscheck (4,096 pairs incl. edge scalars), dependency pin guards, and a
    conformance replay that runs when a corpus dir is present (skips vacuously
    otherwise);
  - jest: `nobleBackend.test.ts` (noble tier byte-parity, 400-case),
    `sdkSignRouting.test.ts` (three-tier `Transaction.sign` routing/fallback
    parity vs the original per-template path), `verifyShadowRouting.test.ts`
    (shadow-verify observe-don't-replace contract).
- **On device** (both phones, release Hermes): 53/53 routed-SDK conformance
  census, 53/53 byte-identical `batchSignP2pkhInputs` fixtures (873 inputs),
  CHRONICLE / missing-FORKID must-reject probes rejected, and the routed
  corpus signed with exactly one engine crossing per tx and zero tier-2
  crossings.

## 7 · Mainnet round-trips (public chain data)

Real money through each native path — tiny UTXOs, signed on-device, verified
independently, then internalized back into the wallet:

| path | funding tx | spend (signed on-device) |
|---|---|---|
| secp batched path | [`e52943db…1154`](https://whatsonchain.com/tx/e52943db2e404e96b0eb24325d8ccbcb4e809b6c64b0ffde3afcbcf37dc71154) | [`db4b9bbc…d02b`](https://whatsonchain.com/tx/db4b9bbc1e7ce78e34812564caab2567584d30a1459c70c825873723fb13d02b) |
| engine path (`batchSignP2pkhInputs`) | [`fb2c0a18…c776`](https://whatsonchain.com/tx/fb2c0a18cae3107731b02854bc9ac953bd5a68d8df6bb7ecf6cf027fa8d9c776) | [`f1cde7ad…da73`](https://whatsonchain.com/tx/f1cde7ad6f7fc6193a580e4e0ccf6b982ef3e7100fbfad1b0280d815d28eda73) |

Each spend carried counting-proxy evidence that the intended native path (and
only that path) produced the signatures.

---

## Reproducing

**Host-side (no device needed):**

```bash
# Rust conformance + parity + pin guards (builds libsecp256k1 from vendored C):
cd native-secp-poc   && cargo test --release
cd native-engine-poc && cargo test --release
cd native-engine-ffi && cargo test --release

# JS parity (noble tier + three-tier routing + shadow verify):
npm install && npx jest nobleBackend sdkSignRouting verifyShadowRouting
```

**Build the native modules from source** (nothing prebuilt is fetched — see
the supply-chain note in the PR description):

```bash
# 1. Rust staticlib → xcframework + UniFFI Swift bindings:
native-secp-poc/scripts/build-secp-xcframework.sh
native-engine-ffi/scripts/build-engine-xcframework.sh

# 2. Sync the built xcframeworks into the Nitro module packages:
packages/react-native-secp-native/scripts/sync-xcframework.sh
packages/react-native-engine-native/scripts/sync-xcframework.sh

# 3. Normal app build:
npm install && npx pod-install && npm run ios
```

**Device bench (Release, embedded bundle):** build once with
`EXPO_PUBLIC_SECP_PROOF=1` in the environment at `expo export:embed` time (any
throwaway development signing identity works; entitlements can be empty),
install and launch on a wired device, and pull
`Documents/secp-proof-result.json` / the console report via
`xcrun devicectl device copy from … --domain-type appDataContainer`. The
harness (`utils/secpNativeProof.ts`, `utils/engineNativeProof.ts`) prints the
conformance census, per-op tables, flow benches, and the frame harness;
`EXPO_PUBLIC_CR_DEVICE=1` (+ `EXPO_PUBLIC_CR_FULL=1`) runs the A/B bench and
the 300 s soak / frame-stall distribution and writes
`Documents/cr-device-result.json`.
