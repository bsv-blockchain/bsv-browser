# Vault Script Template Compression

## Overview

The YubiKey vault's R1-K1 locking script is 959,632 bytes. Storing it verbatim — once
in `outputs.lockingScript`, again inside the deposit's raw transaction — breaks backup:
a single vault deposit's `rawTx` base64-encodes to 1.28 MB, over the backup server's 1 MiB
blob cap, and encrypting/signing that payload blocks the JS thread for tens of seconds.

The fix isn't a bigger cap. The script is almost entirely a fixed template: only 40 bytes
(a 20-byte R1 commitment and a 20-byte K1 public-key hash) vary between any two vault
outputs. `services/vault/templateCodec.ts` exploits that: it derives the constant template
by diffing several freshly-built sample scripts, recognizes any script that matches it
exactly, and replaces the constant bytes with a tiny header plus the few bytes that
actually vary. `expand()` reverses this back to the original bytes, byte for byte.

This document explains the wire format and the reasoning behind it. For the problem
statement, the measured evidence, and the full design rationale, see
`docs/superpowers/specs/2026-08-18-vault-script-template-compression-design.md` — the
savings table below is reproduced from there, not recomputed.

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

## Header layout

Every compressed region uses the same 7-byte header, followed by a payload whose length
depends on the region:

```
0xff              1 byte   marker: OP_INVALIDOPCODE
version           1 byte   template version, monotonic, never reused
region            1 byte   0x01 = R1-K1 locking script, 0x02 = R1-K1 preimage scriptCode
originalLength    4 bytes  big-endian length of the ORIGINAL elided run, for validation
payload           N bytes  the variable fields for this region and version
```

`isCompressed(bytes)` is a cheap `bytes[0] === 0xff` check — enough to route a candidate
to `expandScript`, not a claim that the rest of the header is well-formed.
`expandScript` validates everything else (a truncated header, an unrecognized
version/region, an `originalLength` that disagrees with the version it names, a
wrong-size payload) and throws rather than ever returning approximately-right bytes.

## The two regions

**Region 0x01 — the locking script.** Payload is `commitment(20) ‖ k1PublicKeyHash(20)`,
40 bytes, making a compressed locking script exactly `7 + 40 = 47` bytes. `commitment` is
`hash160(r1PublicKey ‖ salt)`, sitting at offsets 17..36 of the real script;
`k1PublicKeyHash` sits at offsets 959,609..959,628.

**Region 0x02 — the sighash preimage's `scriptCode`.** Payload is `k1PublicKeyHash(20)`
alone, making a compressed scriptCode exactly `7 + 20 = 27` bytes — no commitment field at
all. This isn't an oversight: `R1K1Wallet.unlockR1` (in `@bsv/templates`) builds the
committed `scriptCode` as `lockingScript.subarray(60)` — the locking script with its first
60 bytes dropped. The R1 commitment lives at offsets 17..36, entirely inside that dropped
prefix, so it simply isn't part of the scriptCode's bytes; only `k1PublicKeyHash`, shifted
down by 60, survives into region 0x02's variable run. There is nothing to recover from a
payload that was never there in the first place: the commitment is independently
recoverable at spend time because the *unlocking* script pushes `publicKey` and `salt`
verbatim, and `commitment = hash160(publicKey ‖ salt)` can be recomputed from those two
values directly. One pinned template descriptor covers both regions — region 0x02 is
derived by slicing region 0x01's samples, never built or hardcoded independently — see
`describeVaultTemplate` in `services/vault/templateCodec.ts`.

## Compressed bytes never leave the device

Compression is a **storage and backup representation only**. Broadcast, BEEF construction
for a third-party send, and txid computation all operate on fully expanded bytes — a
compressed script is never valid input to any of those paths, by construction (it fails
script evaluation outright, per the marker choice above). The codec's job ends at
"reconstruct the exact original bytes before anything wire-facing touches them."

## Drift protection

Recognizing "this is a compressed-eligible template" isn't just a length check.
`describeVaultTemplate` pins the live template's fingerprint (`constantHash`, a SHA-256 of
the built script with its variable runs zeroed out) against `PINNED_CONSTANT_HASH_V1`, a
hardcoded literal computed once from the `@bsv/templates` version this codec was verified
against.

That literal is what makes a **same-length** constant-byte drift fail loudly instead of
silently. `totalLength`/`originalLength` checks alone cannot see an upstream change that
keeps exactly 959,632 bytes but reorders or alters some of the fixed bytes in between (say,
a reshuffled `OP_CHECKSIG` branch) — without the pinned hash, `expandScript` would happily
splice a real payload into a stale reference template and hand back confidently wrong bytes
for a real, already-mined, real-money output, with no error at all. With it, that drift
changes `constantHash`, and `describeVaultTemplate` throws `VaultError('template-unknown')`
instead. This check runs on every process, not only in CI, and changing the pinned literal
is a deliberate, version-bumping act — never a "make the assertion pass again" edit.

Versions are pinned by the constant bytes they describe, not by an `@bsv/templates` semver
range, as a precaution — that package went 1.9.6 to 1.10.0 mid-development, and a future
byte-level change between minor versions must surface as `template-unknown`, never as a
silent wrong reconstruction.

## Measured savings

Reproduced from the design spec — measured against a real mined mainnet transaction
(`6c947ae3825b7a7ea1c61a27b64b39c5b8b424d460677addb896285222982697`), not estimated:

| | verbatim | compressed |
|---|---|---|
| deposit `rawTx` | 959,836 B | 251 B |
| deposit as a backup record (base64) | 1,279,784 B | 336 B |
| `outputs.lockingScript` | 959,632 B | 47 B |
| R1 preimage | 959,733 B | 188 B |
| R1 unlocking script | 959,871 B | 323 B |
| withdrawal tx, 1 vault input | 960,075 B | 527 B |
| withdrawal tx, 2 vault inputs | 1,919,946 B | 850 B |
| DB per vault tx (stored twice) | 1,919,468 B | 298 B |
| backup per user per year (1 vault tx/month) | 15.4 MB | 3.9 KB |

Roughly 3,824x on a deposit and 1,822x on a withdrawal.

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
| `services/vault/templateCodec.ts` | Template descriptor derivation, exact recognition, compress/expand, drift protection |
| `services/vault/r1k1.ts` | R1-K1 locking-script construction and the preimage/unlock length constants this codec's regions are checked against |
| `__tests__/vault/templateCodec.test.ts` | Descriptor derivation, round-trip (including the real mainnet fixture), region 0x02, and drift-detection tests |
| `__tests__/vault/r1k1MainnetFixture.test.ts`, `__tests__/vault/fixtures/r1k1MainnetFixture.ts` | The pinned real mined mainnet script used as a template-drift fixture |
| `__tests__/vault/r1k1.test.ts` | R1-K1 template arithmetic, including the `estimateLength` pin against `R1K1_R1_UNLOCK_LEN` that catches an upstream change to the scriptCode offset |
