# Vault Script Template Compression

## Overview

The YubiKey vault's R1-K1 locking script is 959,632 bytes. Storing it verbatim — once
in `outputs.lockingScript`, again inside the deposit's raw transaction — breaks backup:
a single vault deposit's `rawTx` base64-encodes to 1.28 MB, over the backup server's 1 MiB
blob cap, and encrypting/signing that payload blocks the JS thread for tens of seconds.

The fix isn't a bigger cap. The script is almost entirely a fixed template: only 40 bytes
(a 20-byte R1 commitment and a 20-byte K1 public-key hash) vary between any two vault
outputs. `services/vault/templateCodec.ts` exploits that: it recognizes any script that
matches the template exactly, and replaces the constant bytes with a tiny header plus the
few bytes that actually vary. `expandScript` reverses this back to the original bytes,
byte for byte. The reference template itself is **vendored** — a gzip-compressed copy
committed to this repo (`services/vault/vaultTemplateArtifact.ts`), not rebuilt from
whatever `@bsv/templates` happens to be installed — see "The vendored template" below.

This document explains the wire format and the reasoning behind it. For the problem
statement, the measured evidence, and the full design rationale, see
`docs/superpowers/specs/2026-08-18-vault-script-template-compression-design.md` — the
savings table below matches that spec's "Savings, recomputed for v2" addendum, derived
from the same chain, not adjusted by hand.

## Why the marker is `0xff`, not `OP_NOP7`

A compressed script is not a script anyone could ever be tricked into broadcasting — but
the encoding is deliberately chosen so that even if compressed bytes somehow reached the
network in place of a real locking script, they could never be *spent* — see below for why
that guarantee doesn't extend to mining.

The natural-looking choice would be `OP_NOP7` (`0xb6`): a defined Bitcoin Script opcode
that evaluates as a no-op. That's exactly the problem. A script left in compressed form —
`OP_NOP7` followed by version/region/length/payload bytes — is *still a valid script* to
the interpreter. Depending on what those trailing bytes happened to disassemble to, it
could pass evaluation and reach the chain as a spendable (or worse, always-true) output.

`0xff` is `OP_INVALIDOPCODE` — not a defined opcode in any context. A script beginning
with it fails evaluation immediately and unconditionally, so a compressed blob can never be
*spent*: any attempt to unlock an output whose locking script is compressed bytes fails
script evaluation outright.

That does **not** mean a compressed script can never be *mined*. Output scripts are never
executed at creation, only at spend time, so a compressed blob can absolutely be mined into
a real on-chain output — the only consequence is that the funds it holds become permanently
unspendable (burnt), not that the network rejects the output. Keeping a compressed blob from
ever reaching a `lockingScript` on its way to being broadcast is a procedural property of
this codec's callers, not something `0xff` cryptographically guarantees on its own. This was
an explicit decision by the project owner, made and recorded when the format was designed —
see the design spec's Wire Format section.

## Header layout (v2)

Every compressed region uses the same 11-byte header, followed by a payload whose length
depends on the region:

```
0xff              1 byte   marker: OP_INVALIDOPCODE
version           1 byte   template version — always 2; see "Why v2" below
region            1 byte   0x01 = R1-K1 locking script, 0x02 = R1-K1 preimage scriptCode
originalLength    4 bytes  big-endian length of the ORIGINAL elided run, for validation
checksum          4 bytes  first 4 bytes of SHA-256 of the ORIGINAL (uncompressed) bytes
payload           N bytes  the variable fields for this region and version
```

`isCompressed(bytes)` is a cheap `bytes[0] === 0xff` check — enough to route a candidate
to `expandScript`, not a claim that the rest of the header is well-formed.
`expandScript` validates everything else (a truncated header, an unrecognized
version/region, an `originalLength` that disagrees with the version it names, a
wrong-size payload, a checksum that disagrees with the reconstructed bytes) and throws
rather than ever returning approximately-right bytes.

### Why v2: the checksum

Version 1 — a format that existed only during this branch's development, was never
persisted by anything, and has no reader in this codec by design (see below) — had a
7-byte header: marker/version/region/originalLength, no checksum. It relied entirely on
`originalLength` and payload-size checks to validate a compressed blob. Neither check can
see corruption *inside* the payload itself: a single bit flip in a stored or transmitted
40-byte payload still produces the right length, still splices cleanly into the reference
template, and still passes every v1 check — while reconstructing a **structurally
perfect but wrong** 959,632-byte script: wrong txid, a merkle proof that no longer
verifies, and an unrecoverable deposit record, with no error anywhere.

v2 adds a 4-byte checksum — the first 4 bytes of SHA-256 of the full original
(uncompressed) bytes — computed at compress time and verified at expand time only
**after** the payload has been spliced into the reference template, against the full
reconstructed result. That order matters: reconstruct, hash, compare, and only then
return — never the reverse. Checking the reconstruction rather than the payload alone
means corruption anywhere is caught, including (in principle) in the constant template
itself, not just in the 20/40 bytes the payload carries.

**This checksum is not a MAC.** It's a plain SHA-256 prefix with no secret key, so anyone
able to rewrite a stored blob can simply recompute the checksum to match their rewritten
bytes — it detects accidental corruption only. It must never be relied on as a
tamper-resistance guarantee at the storage boundary against a hostile writer; that is a
different property, not one this codec provides.

v1 never shipped: nothing has ever called `compressScript`/`compressScriptCode`/
`expandScript` outside this codec's own tests (see "Nothing calls this codec yet" below),
so no v1 record has ever been persisted anywhere. There is therefore no migration to
perform and no v1 reader to maintain — a v1-tagged header (or any version this build
doesn't recognize) is simply rejected with `template-unknown`, the same as any other
unknown version.

## The two regions

**Region 0x01 — the locking script.** Payload is `commitment(20) ‖ k1PublicKeyHash(20)`,
40 bytes, making a compressed locking script exactly `11 + 40 = 51` bytes. `commitment` is
`hash160(r1PublicKey ‖ salt)`, sitting at offsets 17..36 of the real script;
`k1PublicKeyHash` sits at offsets 959,609..959,628.

**Region 0x02 — the sighash preimage's `scriptCode`.** Payload is `k1PublicKeyHash(20)`
alone, making a compressed scriptCode exactly `11 + 20 = 31` bytes — no commitment field at
all. This isn't an oversight: `R1K1Wallet.unlockR1` (in `@bsv/templates`) builds the
committed `scriptCode` as `lockingScript.subarray(60)` — the locking script with its first
60 bytes dropped. The R1 commitment lives at offsets 17..36, entirely inside that dropped
prefix, so it simply isn't part of the scriptCode's bytes; only `k1PublicKeyHash`, shifted
down by 60, survives into region 0x02's variable run. There is nothing to recover from a
payload that was never there in the first place: the commitment is independently
recoverable at spend time because the *unlocking* script pushes `publicKey` and `salt`
verbatim, and `commitment = hash160(publicKey ‖ salt)` can be recomputed from those two
values directly. One vendored reference template covers both regions — region 0x02 is
derived by slicing 60 bytes off the front of region 0x01's vendored bytes, never built or
hardcoded independently — see `ensureTemplateCache` in `services/vault/templateCodec.ts`.

## The vendored template

The reference template that recognition and reconstruction are checked against is
**vendored**: gzip-compressed and committed as base64 in
`services/vault/vaultTemplateArtifact.ts` (8,059 gzipped bytes for a 959,632-byte raw
template — about 11 KB as base64), not rebuilt from whatever `@bsv/templates` happens to
be installed.

This replaced an earlier design where `describeVaultTemplate` rebuilt the template from
the installed `@bsv/templates` on first use and pinned only a SHA-256 of the result.
`package.json` pins `@bsv/templates` at `^1.10.0`, so a routine `npm i` can move it — and
the moment the installed library's output drifted from the pinned hash by even one byte,
*every* previously-compressed record became permanently unexpandable, even though the 40
bytes needed to reconstruct any given record were sitting right there in its own
compressed blob. Re-pinning the hash to match the new library would have "fixed" the
throw but silently reconstructed old records against the new template — wrong bytes, no
error.

Vendoring removes the installed library from the reconstruction path entirely: an
`@bsv/templates` upgrade (or removal) cannot change what an already-compressed record
expands back into, because expansion never asks it anything. `PINNED_CONSTANT_HASH`/
`PINNED_CONSTANT_HASH_SCRIPT_CODE` in `templateCodec.ts` are still checked, but now as a
cross-check on the vendored asset (catching a corrupted commit, or a stale
`PINNED_VARIABLE_RUNS`), not as the only thing standing between a dependency bump and an
unrecoverable deposit record. A separate test (`templateCodec.test.ts`) still builds a
script with whatever `@bsv/templates` is currently installed and checks that it still
matches the vendored bytes — so an upstream change is still caught loudly, in CI — it just
can no longer make a stored record unreadable.

Decoding happens with `fflate`'s `gunzipSync`, never Node's `zlib` or the DOM
`DecompressionStream` — this codec ships to React Native/Hermes, which has neither.
`fflate` is already a real dependency of this project (see `patches/@bsv+templates+1.10.0.patch`,
which moved `@bsv/templates` itself onto `fflate.gunzipSync` for the same reason).

### Reference-template cache and release

The inflated reference bytes (~960 KB) are held as a module-level cache, populated lazily
on first use and reused across calls — `ensureTemplateCache` in `templateCodec.ts`. They're
held as `Uint8Array`, not `number[]`: a `number[]` of ~960,000 JS numbers costs roughly
8 bytes per element (~7.5 MB) even though every element fits in a byte, and the previous
implementation held *two* such arrays (one per region) — 15.5–16.4 MB retained for the
life of the process, more than the 7.2 MB database this feature exists to shrink. The
region-0x02 reference is a `subarray` **view** over region 0x01's buffer, not a copy, so
the whole cache costs under 1 MB.

`releaseTemplateCache()` clears this cache; the next `describeVaultTemplate` call
transparently re-inflates and re-verifies it from the vendored asset. This is a
memory-management knob only — nothing is discarded that isn't trivially reconstructible
from bytes already committed to this repo. A caller processing a **batch** of vault
records (compressing every `lockingScript` in a backup pass, or expanding every stored
record on restore) should hold the cache open for the whole batch and release once at the
end, not per record — releasing between records would turn one inflate-and-verify pass
into one per record for no benefit.

## Compressed bytes never leave the device

Compression is a **storage and backup representation only**. Broadcast, BEEF construction
for a third-party send, and txid computation all operate on fully expanded bytes — a
compressed script is never valid input to any of those paths, by construction (it fails
script evaluation outright, per the marker choice above). The codec's job ends at
"reconstruct the exact original bytes before anything wire-facing touches them."

## Drift protection

Recognizing "this is a compressed-eligible template" isn't just a length check.
`ensureTemplateCache` checks the vendored template's fingerprint (`constantHash`, a SHA-256
of the inflated bytes with the two variable runs masked to zero — a no-op against the
vendored asset, since it was built with those exact positions already zeroed) against
`PINNED_CONSTANT_HASH`/`PINNED_CONSTANT_HASH_SCRIPT_CODE`, literals computed once — before
the template was vendored — from a genuine `@bsv/templates` sample.

That masking-then-hashing (rather than a bare hash of the asset) is what makes this a
cross-check and not a tautology: if the vendored asset were corrupted, or
`PINNED_VARIABLE_RUNS` no longer named the positions the asset was actually zeroed at,
masking would zero the wrong bytes and the resulting hash would disagree with these
independently-sourced literals. `ensureTemplateCache` throws
`VaultError('template-invalid')` rather than proceeding if that ever happens — this check
runs on every process, not only in CI.

A **same-length** constant-byte drift in `@bsv/templates` itself — an upstream change that
keeps exactly 959,632 bytes but reorders or alters some of the fixed bytes in between (say,
a reshuffled `OP_CHECKSIG` branch) — can no longer make an already-stored record
unreadable, because reconstruction no longer consults `@bsv/templates` at all (see "The
vendored template" above). It's still caught, just differently: a dedicated test builds a
script with the currently-installed library, masks it the same way, and asserts the result
still matches `PINNED_CONSTANT_HASH`. That test failing is the loud, CI-visible signal a
library upgrade changed the template — the runtime path is simply no longer the mechanism
that catches it, so it can't also be the mechanism a stale record dies to.

Changing either pinned hash (or `PINNED_VARIABLE_RUNS`) is a deliberate, version-bumping
act, done together with regenerating `vaultTemplateArtifact.ts` — never a "make the
assertion pass again" edit. Versions are pinned by the constant bytes they describe, not by
an `@bsv/templates` semver range — `package.json` pins `^1.10.0`, and a byte-level change
within that range must surface as a loud test failure, never as a silent wrong
reconstruction.

## Measured savings

Measured against a real mined mainnet transaction
(`6c947ae3825b7a7ea1c61a27b64b39c5b8b424d460677addb896285222982697`), not estimated. The
compressed-side numbers below reflect the v2 header (51-byte locking script, 31-byte
scriptCode); see the design spec for the full derivation chain.

| | verbatim | compressed |
|---|---|---|
| deposit `rawTx` | 959,836 B | 255 B |
| deposit as a backup record (base64) | 1,279,784 B | 340 B |
| `outputs.lockingScript` | 959,632 B | 51 B |
| R1 preimage | 959,733 B | 192 B |
| R1 unlocking script | 959,871 B | 327 B |
| withdrawal tx, 1 vault input | 960,075 B | 531 B |
| withdrawal tx, 2 vault inputs | 1,919,946 B | 858 B |
| DB per vault tx (stored twice) | 1,919,468 B | 306 B |
| backup per user per year (1 vault tx/month) | 15.4 MB | ~4.0 KB |

Roughly 3,764x on a deposit and 1,808x on a withdrawal (1 vault input) — down slightly
from v1's 3,824x/1,822x, the cost of the 4-byte checksum on an otherwise tiny payload.

## What this does not solve

- **The withdrawal fee.** A vault withdrawal still puts a ~960 KB unlocking script
  on-chain — that's ~96,000 sat of real, uncompressible bytes a miner has to accept. This
  codec never touches broadcast bytes (see above), so it cannot and does not change that
  cost.
- **Transient spend-time memory.** Building a withdrawal for a third-party send still
  needs genuine, expanded bytes for BEEF construction, which still materializes roughly
  1.83 MB of `inputBEEF` in memory during that operation. Compression shrinks what's
  *stored*, not what a spend transiently needs to *build*.
- **Anything other than this known template.** This works because the vault script has an
  exact, pinned shape. It is not a general answer for large records; the client's oversize
  guard remains the backstop for everything else.
- **Nothing calls this codec yet.** No storage or backup path invokes `compressScript`,
  `compressScriptCode`, or `expandScript` — the read/write wiring that would actually realise
  the savings above is a deliberately separate change, so those numbers are what this codec
  *makes possible*, not what the app currently achieves.

## Where this lives

| File | Role |
|------|------|
| `services/vault/templateCodec.ts` | Template descriptor, exact recognition, compress/expand, checksum, cache/release, drift protection |
| `services/vault/vaultTemplateArtifact.ts` | The vendored reference template: gzip-compressed, base64-encoded, committed |
| `services/vault/r1k1.ts` | R1-K1 locking-script construction and the preimage/unlock length constants this codec's regions are checked against |
| `__tests__/vault/templateCodec.test.ts` | Descriptor, round-trip (including the real mainnet fixture), region 0x02, checksum, cache-release, and vendored-vs-installed-library tests |
| `__tests__/vault/r1k1MainnetFixture.test.ts`, `__tests__/vault/fixtures/r1k1MainnetFixture.ts` | The pinned real mined mainnet script used as a template-drift fixture |
| `__tests__/vault/r1k1.test.ts` | R1-K1 template arithmetic, including the `estimateLength` pin against `R1K1_R1_UNLOCK_LEN` that catches an upstream change to the scriptCode offset |
