# PaymentFrame v3: sealed frames, Mandala token payments, overlay-gated release

Date: 2026-07-31
Branch: master (design; implementation branch TBD)

## Problem

Blitz (downstream stablecoin wallet) builds on this app's offline-payments
format and cannot express a token payment in it. Their critique was verified
claim-by-claim against master `63e30c5`; the surviving items, plus the
decisions taken on each, define this design:

1. **Tokens.** `PaymentFrame` v2 has no assetId, no linkage data, no kind
   discriminator — the only extension point is a version bump
   (`codec.ts:118` rejects anything ≠ 2). Blitz's product is a BRC-92
   Mandala stablecoin; the frame must carry one.
2. **Privacy.** The frame travels plaintext on the QR rung. A photographed
   fountain QR yields the payer's identity key and full transaction ancestry.
   The session already carries a 32-byte PSK (`session.ts:60`) that today
   secures only the radio rungs.
3. **Proof state.** Nothing runs proof collection before a frame is built.
   A payer whose Monitor hasn't caught up produces a ballooned AtomicBEEF;
   past 64 KiB (`@bsv/air-gap` `MAX_MESSAGE_BYTES`) the payment fails
   outright with `local_pay_too_large`.
4. **Broadcast classification.** `services/arcadeBroadcastProvider.ts:184-192`
   classifies WoC failures from body strings; `Missing inputs` becomes a
   terminal `doubleSpend` cascade. Decision: no graph disambiguation —
   custom string classification is deleted, Arcade/SSE/toolbox handling is
   the single source of truth, and correctness rests on the guarantee the
   engine already provides: broadcast strictly in topological order, foreign
   ancestors included (`utils/offline/order.ts` `releaseOrder`,
   `processOfflineActions.ts:116-141`). No regtest/svnode compatibility.
5. **Interop asks.** `CAP_BLE` capability bit; publish the codec as
   `@bsv/local-payments` (deferred until the format is device-proven).

Token protocol rule adopted with the format: **a token transfer is admitted
by the issuer's overlay before it is broadcast.** Whoever reconnects first
submits each chain transaction plus its off-chain linkage payload to the
overlay; acceptance gates the normal Arcade broadcast; rejection cascades
exactly like a double-spend. The recipient can perform the submission —
the linkage blobs are encrypted to the overlay, so carrying them is safe —
but nothing is settled by internalize alone.

## Verified dependency facts this design is built on

From `@bsv/mandala` 0.1.0 (source `~/git/demos/mandala/lib`, npm-identical),
`@bsv/templates` 1.9.6, `@bsv/overlay-topics` 1.6.8, installed
`@bsv/wallet-toolbox-mobile` 2.4.3:

- **Overlay wire.** `POST ${overlayUrl}/submit`, `application/octet-stream`,
  `X-Topics: tm_mandala`, `x-includes-off-chain-values: true`, body =
  `varint(beef.length) || beef || offChainValues`. `offChainValues` is the
  UTF-8 JSON of `MandalaLinkagePayload { inputs: [{index, linkage}],
  outputs: [{index, linkage}] }` — **one `SpecificLinkage` per FT input and
  per FT output, verifier = the overlay's identity key**. Acceptance is
  synchronous in the response (`STEAK['tm_mandala'].outputsToAdmit`).
  Gate pattern: `submitAndBroadcast` (reject → `abortAction`; accept →
  `sendWith` broadcast) — `overlay.ts:59-102`. Input linkages are
  **screening-only**: conservation and the frozen-coin gate work from
  `previousCoins` + BEEF source decode with no linkage
  (`MandalaTopicManager.ts:172-197, 270-273`); input reveals exist so the
  overlay can identify **senders** for sanctions and allowlist checks
  (`:199-213, :305-313`) — omit them and a denylist asset still admits,
  but sender screening silently degrades and allowlist assets check
  recipients only. We keep them, matching the reference producer.
- **No per-assetId endpoint discovery exists.** `OVERLAY_URL` and
  `OVERLAY_IDENTITY_KEY` are global mutable config (`configureMandala`).
  Multi-issuer support therefore requires the frame to carry **both** the
  overlay URL and the overlay identity key (a re-spender needs the verifier
  key offline to mint its own blobs).
- **Linkage blobs.** `wallet.revealSpecificKeyLinkage({ counterparty,
  verifier, protocolID: [2, 'mandala token'], keyID })` →
  `{ encryptedLinkage (80 B), encryptedLinkageProof (49 B), prover,
  verifier, counterparty, protocolID, keyID, proofType: 0 }`. BRC-72
  encryption: only prover and named verifier can decrypt. ~0.9 KB per blob
  as JSON; a 1-input/2-output transfer ≈ 2.7 KB of payload. Consume side:
  `verifyKeyLinkage(linkage, verifierWallet)` in `@bsv/overlay-topics`.
- **Token script.** `MandalaToken.decode(lockingScript)` →
  `{ assetId, amount, pubKeyHash }`, throws on non-token scripts. Layout:
  `<36B assetId> <scriptnum amount> OP_2DROP <P2PKH tail>`. Token value is
  the script number, **not** `output.satoshis` (token outputs carry 1 sat,
  BRC-92). Ownership check = `pubKeyHash` vs `hash160(derived pubkey)` —
  the derivation triple is the same shape `verify.ts` uses today.
  **Pin `@bsv/templates` ≥ 1.8.0** (assetId byte-order break in 1.8.0).
- **Receiver internalize.** `internalizeAction` with
  `protocol: 'basket insertion'`, `insertionRemittance: { basket,
  customInstructions, tags }`. The toolbox never inspects the script,
  credits no satoshis, writes the output `spendable: true, change: false`
  immediately, and the offline hold parity is exact — the same
  `attemptToPostReqsToNetwork` override (`StorageExpoSQLite.ts:1441-1479`)
  parks the broadcast. Derivation fields are forced `undefined` on this
  path; anything needed to spend later goes in `customInstructions`
  (BTMS precedent — `@bsv/btms` is already installed). Basket name must
  not start with `'p '` (permissions-module routing hijacks it).
- **The toolbox has no offChainValues concept anywhere.** The app must
  persist linkage payloads itself and sequence overlay submission around
  the existing release engine.

## Non-goals

- **No graph-walk error disambiguation.** Superseded by decision 4 above.
- **No BLE transport implementation.** Only the capability bit.
- **No issuer-side float enforcement.** Cert-carried offline limits are a
  shared design surface with Blitz, out of scope here.
- **No change to Ack, PSK handshake, socket framing, or rung selection.**
- **No package publishing yet.** `@bsv/local-payments` from
  `ts-stack/packages/helpers` is a recorded todo, gated on device-proven.
- **`Session` stays JSON** (`bsvpay1:`); no binary session codec.

## Design

### 1. Sealed envelope — every rung, one code path

Everything that leaves the device as a payment frame is sealed with the
session PSK, on radios and QR alike (uniform: one wire shape, no
rung-conditional envelope, and redundant encryption over TLS-PSK/Nearby
costs 49 bytes):

```
[1]  SEAL_VERSION (1)
[n]  SymmetricKey(session.psk).encrypt(frameBytes)   // 32B IV || ct || 16B GCM tag
```

`@bsv/sdk` `SymmetricKey` (AES-256-GCM) over the raw 32-byte PSK. Receiver
unseals, then `decodeFrame`. Overhead: 49 bytes.

Fail-closed compatibility for free: an old build handing sealed bytes to
`decodeFrame` reads first byte `1` → `unsupported frame version 1` →
`decode_failed`. A v3 build receiving an unsealed v2 frame reads
`SEAL_VERSION 2` → `unsupported seal version`. Both directions refuse
cleanly.

Only line-of-sight is closed. An observer who photographed the **pairing**
QR holds the PSK and can decrypt payment frames; that threat was already
noted-not-mitigated in the 07-27 design (§ "Threat not covered") and is
unchanged.

### 2. `PaymentFrame` v3 — `kind` discriminator, token fields

`FRAME_VERSION` 2 → 3. Layout (`utils/localpay/codec.ts`):

```
[1]    version (3)
[1]    kind                        0x01 = bsv, 0x02 = token
[33]   senderIdentityKey           raw compressed pubkey
[v]    outputIndex                 (LEB128 varint)
[v]+n  derivationPrefix            (varint length + UTF-8)
[v]+n  derivationSuffix
--- kind 0x02 only ---
[v]+n  assetId                     UTF-8 "<txid>.<vout>"
[v]+n  overlayUrl                  UTF-8
[33]   overlayIdentityKey          raw compressed pubkey (linkage verifier)
[v]    certCount, then per cert:
[v]+n    certificate               opaque serialized bytes
[v]    linkageCount, then per entry:
[32]     txid                      display byte order
[v]+n    linkagePayload            UTF-8 JSON MandalaLinkagePayload
[v]+n  recipientLinkage            UTF-8 JSON SpecificLinkage (verifier = payee)
--- both kinds ---
[v]+n  transaction                 AtomicBEEF
```

Rules:

- `kind` is a discriminator, not optional trailing fields: an unknown kind
  throws `CodecError('unsupported frame kind')`. The `trailing bytes after
  frame` check is preserved. Frames stay never-forward-compatible.
- **The linkage map covers the whole chain.** One entry per unbroadcast
  token transaction in the carried BEEF — the payer's new transfer plus
  every ancestor payload it received in earlier frames. Payloads are the
  exact bytes the overlay consumes (`encodeLinkagePayload` output),
  carried opaquely and forwarded verbatim on re-spend. The recipient can
  submit any of them; it can decrypt none of them.
- `recipientLinkage` is a bsv-browser addition over mandala 0.1.0's wire
  (which notifies recipients via MessageBox instead — unavailable
  offline). It is one extra `revealSpecificKeyLinkage` call with
  `verifier` = the payee's identity key, for the payee's output of the tip
  transaction only. The payee runs `verifyKeyLinkage` on it and checks the
  recovered `pubKeyHash` against the decoded output — evidence the payer
  minted honest linkage for this output (it cannot prove the overlay's
  copy is honest; the overlay verdict at submission is the real gate).
- `certificates` are opaque to the codec. Format and overlay consumption
  are Open question 2.
- There is deliberately still no `amount` field, for either kind. The BSV
  figure is the verified output's satoshis; the token figure is
  `MandalaToken.decode(...).amount`. A field could only agree with the
  script or lie about it.

### 3. `Session` — token requests, versioned fail-closed

New optional field on `Session`, wire key `t`:

```ts
asset?: {
  id: string          // assetId "<txid>.<vout>"
  label?: string      // display, from AssetMetadata
  ticker?: string
  decimals?: number
  overlayUrl: string
  overlayIdentityKey: string  // 66-hex compressed pubkey
}
```

When `asset` is present, `amount` is **base units of that asset**, and it
remains a binding term exactly as today (`session.ts:20-26`).

Session stays `v: 1`. (A version bump to fence off older payers — which
would otherwise read a token request's `amount` as satoshis — was
considered and dropped: the app is not live, no older build exists in the
field. The general policy still goes in the docs pass: frames are
strictly versioned; the session JSON is extensible, except a future field
that changes the meaning of money on a *deployed* format must bump `v`.)

Capability bits (`session.ts:5-6`): add `CAP_BLE = 0x04`. Wire format
already accommodates it (caps is a plain number; `selectTransport` masks
specific bits). No local BLE support — the bit exists so a Blitz session
can advertise it and so our builds ignore it cleanly.

### 4. Payer — building a token frame

`buildPaymentFrame` (`utils/localpay/build.ts`) grows a token path,
selected by `session.asset`:

1. Funding: token UTXOs from the `mandala-tokens` basket
   (`listOutputs({ basket, include: 'entire transactions' })` — the BEEF
   must carry complete raw source transactions; the signer layer refuses
   txid-only entries).
2. Outputs: payee output via
   `MandalaToken.lock(assetId, amount, hash160(derivedKey))` where the
   derivation is `getPublicKey({ protocolID: [2, 'mandala token'],
   keyID: `${session.derivationPrefix} ${session.derivationSuffix}`,
   counterparty: session.identityKey })` — mandala's FT protocol with
   **our payee-minted nonces as the keyID**, preserving the
   frame-to-session binding unchanged. Token change (if any) back to self
   under a self-derived key. 1 satoshi per token output.
3. Two-step `createAction`/`signAction` exactly as today
   (`build.ts:120-163`); amount pre-checked against `session.amount` in
   base units.
4. Linkage: one `revealSpecificKeyLinkage` per FT input and output with
   `verifier = session.asset.overlayIdentityKey` → `MandalaLinkagePayload`
   → `encodeLinkagePayload`; plus `recipientLinkage` with
   `verifier = session.identityKey` for the payee output.
5. Frame assembly: linkage map = the new payload keyed by the signed txid,
   **plus every stored ancestor payload** for unbroadcast token ancestors
   in the BEEF (see §6 store).
6. Hold/queue/ack/broadcast flow unchanged from v2 — with one insertion:
   when online, the positive-ack finalize for a token frame runs
   `submitToOverlay` first and only broadcasts on acceptance (the
   `submitAndBroadcast` pattern: rejection → `abortAction(reference)` →
   payment fails before any network exposure). Offline, the hold parks
   both the transaction and its payload; the overlay gate moves to the
   drain (§6).

Do not use mandala's `configureMandala` global config — endpoints are
per-frame values; call the facilitator with the explicit URL.

### 5. Payee — verifying and crediting a token frame

`verifyFramePayment` (`utils/localpay/verify.ts`) grows a token branch:

1. Parse AtomicBEEF, take `outputs[frame.outputIndex]`.
2. `MandalaToken.decode(lockingScript)` — throws → `not_mine`-class
   refusal. Check `decoded.assetId === frame.assetId`, and against
   `session.asset.id` at the settle call site.
3. Ownership: `decoded.pubKeyHash` equals
   `hash160(getPublicKey({ protocolID: [2, 'mandala token'], keyID:
   nonces, counterparty: frame.senderIdentityKey, forSelf: true }))` —
   the mirror of the payer derivation, same pattern as the BSV branch.
4. Return `{ kind: 'token', assetId, amount }`; the settle path binds
   `amount` against `session.amount` (base units) exactly like satoshis
   today (`NearbyFlow.tsx:624-638` comparison unchanged in shape).
5. `verifyKeyLinkage(frame.recipientLinkage, wallet)` and compare its
   `pubKeyHash` to the decoded output's. Display uses
   `session.asset.{label,ticker,decimals}`; fall back to
   `resolveAssetMetadata(assetId)` when online.

Credit via the pending queue as today, with the internalize call switched
per kind (`utils/localpay/pending.ts:138-156`):

```ts
outputs: [{
  outputIndex,
  protocol: 'basket insertion',
  insertionRemittance: {
    basket: 'mandala-tokens',
    customInstructions: JSON.stringify({
      protocolID: [2, 'mandala token'], keyID, counterparty: sender,
      assetId, amount,
    }),
    tags: [`mandala_assetid_${assetId}`, `mandala_sender_${sender}`],
  },
}]
```

Offline behavior is identical to the BSV path by construction (same
storage override, transaction lands `'unproven'`, hold-safe). The output
is spendable immediately — which is what makes chained offline token
re-spend work — and the three-tone receipt doctrine applies unchanged:
credited ≠ settled, "Received offline · not yet broadcast" until the
drain confirms.

### 6. Persistence and the overlay-gated drain

New storage: an `offline_linkage` table (or column family on
`offline_actions`) — `txid PRIMARY KEY, payloadBytes BLOB, overlayUrl
TEXT, overlayIdentityKey TEXT, source ('minted'|'forwarded')`. Written by
the payer at hold time (own payloads) and by the payee at savePending
(every entry of a received frame's linkage map). Rows outlive the frames
that carried them and are keyed to the release engine's txids.

`processOfflineActions` gains one step, inside the existing
topologically-ordered walk, per transaction that has a linkage row:

```
for step in plan (already parent-first):
  if linkage row exists for step.txid:
    submit varint(beef)||beef||payload to that row's overlayUrl
    ├─ accepted (outputsToAdmit non-empty) → proceed to normal release
    ├─ rejected → applyOutcome('invalidTx')  // same terminal cascade as
    │             a double-spend: descendants rejected, outputs
    │             un-credited, OfflineNotice attribution
    └─ unreachable/error → serviceError      // retryable, per-subtree
                                              // stall, existing backoff
  release to Arcade as today (post, storage-witnessed 'unmined')
```

`isAlreadyBroadcast`-class overlay responses (already/known/duplicate)
count as accepted — resubmission of an admitted tx is idempotent. BSV
transactions (no linkage row) are untouched by this step.

### 7. Broadcast classification cleanup

`services/arcadeBroadcastProvider.ts` WoC branch: delete the
`body.includes('mempool-conflict') || body.includes('Missing inputs')` →
`doubleSpend` inference (`:188-189`). Keep `'already in the mempool'` →
success (txid-idempotent). Every other WoC failure is `serviceError` —
retryable, which `plan.ts:242-247` already documents as the safe default
("a plain error is never read as invalidity... the drain simply stalls,
which loses nothing"). ARC's structured `txStatus` classification
(`ARC_DOUBLE_SPEND_STATUSES`) stays the sole terminal-verdict source.
Correctness argument: the release engine already guarantees parents-first
over the merged BEEF including foreign ancestors, and refuses to post
anything whose ancestry didn't merge (`processOfflineActions.ts:133-138`)
— so a self-inflicted orphan cannot be sent, and a conflicting-spend
verdict arrives from ARC as `DOUBLE_SPEND_ATTEMPTED`, not from a WoC
string.

### 8. Proof collection on /pay

On /pay screen focus: schedule one deferred, non-blocking proof nudge —
preference order (a) prompt the Arcade SSE client to sync outstanding
`proven_tx_reqs` events, (b) a single `CheckForProofs` Monitor run —
gated to at most once per 10 minutes, dispatched after interactions
settle so screen mount never blocks on it. Rationale: frame size tracks
unproven ancestry; a payer whose proofs are current produces the smallest
possible BEEF and lands on the fastest rung. (The 2-hour background
trigger in `WalletContext.tsx:1000-1031` is unchanged.)

## Size budget

| component | bytes |
|---|---|
| seal overhead | 49 |
| v3 header (token, no certs) | ~120 + URL |
| linkage payload, 1-in/2-out transfer, JSON | ~2,700 per chain tx |
| recipientLinkage | ~900 |
| AtomicBEEF | 2–8 KB (BSV, measured by Blitz); grows with unproven ancestry |
| hard cap (air-gap `MAX_MESSAGE_BYTES`) | 65,536 |

A 5-link token chain ≈ BEEF 19 KB + 5×2.7 KB linkage ≈ 33 KB: over the
Nearby 32 KiB protocol ceiling (falls back to fountain QR by design),
comfortably under 64 KiB. Deeper chains or certificate payloads eat the
remaining headroom — if it becomes real, the v4 lever is binary-packing
the linkage payload (~3.5× smaller than its JSON), not raising the cap.

## Compatibility

No live builds exist; there is no migration story to preserve. Dev builds
refuse each other's formats cleanly by construction (version guards on
seal, frame, and nothing else needed). Interop rows that matter:

| scenario | behavior |
|---|---|
| v3 build, BSV payment | kind 0x01; flow identical to v2 semantics |
| Blitz BLE session | `CAP_BLE` bit ignored by us, QR floor still common |

## Resolved questions (from the mandala reference wallet)

1. **Spending a Mandala output through the BRC-100 wallet — solved,
   pattern exists to copy.** `walletMandalaUnlock` (mandala
   `lib/src/unlock.ts:42-72`) builds the unlocking script with zero raw
   keys: sighash preimage via `TransactionSignature.format`, then
   `wallet.createSignature({ hashToDirectlySign: hash256(preimage),
   protocolID: [2, 'mandala token'], keyID, counterparty })`, and the
   matching pubkey from `getPublicKey({ ..., forSelf: true })` (BRC-42
   symmetry: for tokens locked to us by another party, `counterparty` =
   sender and only the forSelf derivation matches the pkh).
   `estimateLength` = 108 → `unlockingScriptLength: 108` in createAction.
   Used exactly this way in `transfer.ts:167` (template on
   `signableTransaction.tx` inputs → `tx.sign()` → `signAction` spends).
2. **Permission prompts — non-issue.** The frame build path already runs
   as `adminOriginator` (`NearbyFlow.tsx:1046` → `build.ts` originator
   param), which bypasses `WalletPermissionsManager` gating for
   `createSignature` and `revealSpecificKeyLinkage` alike.

## Scope split: what lands here vs. in stablecoin apps

Token **flows** are introduced in other apps (Blitz and future stablecoin
wallets), not necessarily in bsv-browser. What lands here is the format
and the libraries those apps consume — the pieces destined for
`@bsv/local-payments`:

**In bsv-browser now:** sealed envelope end-to-end (§1, both kinds, all
rungs); frame v3 codec with full token encode/decode including the
certificate slot and linkage map (§2), library-grade and test-pinned even
though this app only mints kind 0x01; session `asset` field + `CAP_BLE`
(§3); the token verify branch (§5 steps 1–5, via `@bsv/templates`) so a
conforming receiver implementation exists and is tested against real
scripts; broadcast classification cleanup (§7); /pay proof nudge (§8).

**Consumer guidance, not built here:** the payer token build flow (§4),
basket-insertion crediting and the `offline_linkage` store + overlay-gated
drain (§5 credit path, §6). Those sections are normative for implementers
— they cite the exact toolbox/mandala APIs — but bsv-browser's own pay
flow stays BSV-kind until a product decision says otherwise.

## Open questions

1. ~~Certificate format~~ **Resolved:** certificates are serialized
   `@bsv/sdk` `VerifiableCertificate` instances. Issuance, validation,
   and consumption belong to the stablecoin apps and issuer overlays —
   this format only guarantees the slot (opaque `certCount` +
   per-certificate bytes in §2), and the codec never parses them.
2. **`@bsv/mandala` under Metro/Hermes.** The only `import.meta` use is
   `constants.ts` (guarded, but Metro can reject the *syntax* at
   transform time). Options, in preference order: (a) depend on the
   package and patch-package the one line if Metro chokes; (b) vendor the
   small pure pieces the frame path needs — `unlock.ts` (72 lines),
   `encodeLinkagePayload` (a JSON.stringify), inline `FT_PROTOCOL` — and
   take `MandalaToken` from `@bsv/templates` + the facilitator from
   `@bsv/sdk`, skipping `@bsv/mandala` for the wire path entirely (it
   remains the reference for ftSelect/change planning either way). We
   bypass `configureMandala` global state regardless (per-frame
   endpoints).

## Deferred (recorded todos)

- Publish codec + session as `@bsv/local-payments` from
  `ts-stack/packages/helpers` once the v3 format is locked and
  device-proven.
- Full documentation alignment pass after real-world tests approve
  (includes: versioning policy prose, sealed-QR trade-off, superseding the
  07-29 design's Part III `bsvpayf2:` section).
- Reply to Blitz: v2/v3 corrections to their frame sketch, the items that
  don't apply to this architecture and why, CAP_BLE allocation,
  recommendation to adopt AWDL/Nearby rungs, and the "ten defects vs
  seven" doc pointer (matches nothing in this repo).
