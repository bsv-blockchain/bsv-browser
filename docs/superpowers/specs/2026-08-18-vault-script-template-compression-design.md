# Vault script template compression

**Status:** approved by the project owner 2026-08-18
**Supersedes:** the streaming/auth rethink of the backup service, which this makes unnecessary

## Problem

The R1-K1 vault locking script is 959,632 bytes. Storing it verbatim breaks three things at once:

- A vault deposit's `rawTx` is 959,836 bytes, which base64-encodes to 1,279,784 bytes in a
  backup chunk — 1.22x the backup server's 1 MiB blob cap. A wallet that has used the vault
  can never push a backup again.
- Encrypting and BRC-31-signing that payload blocks the JS thread for ~50 seconds per
  attempt, once a minute, starving the rest of the wallet.
- One such transaction occupies 26.6% of a real 7.2 MB wallet database, stored twice
  (`proven_tx_reqs.rawTx` at 959,836 bytes and `outputs.lockingScript` at 959,632).

Raising the server cap was rejected: it treats the symptom, and the same bytes still have to
be encrypted, signed, buffered ~3x server-side, and downloaded again at restore.

## Key insight

The script is almost entirely constant. Verified against the mined mainnet transaction
`6c947ae3825b7a7ea1c61a27b64b39c5b8b424d460677addb896285222982697`:

```
built length                          : 959,632  (= R1K1_LOCK_LEN)
bytes differing between two instances : 40
variable runs                         : 17-36 (20B), 959609-959628 (20B)
real vs freshly built                 : 40 bytes differ
diffs OUTSIDE the known-variable runs : 0        <-- template identical
```

- offsets 17..36 — `r1Commitment` = `hash160(r1PublicKey ‖ salt)`, per the template's own
  `expectedCommitment = lockingBytes.subarray(17, 37)`
- offsets 959,609..959,628 — `k1PublicKeyHash`
- the other 959,592 bytes are template, byte-identical across instances

So a vault locking script is fully described by `{templateVersion, commitment, k1PublicKeyHash}`
— 40 bytes of payload plus a version tag.

The spend side matters as much. `R1K1Wallet.unlockR1` builds its preimage as

```js
formatPreimage(tx, inputIndex, source, new Script([], lockingBytes.subarray(60), void 0, false))
```

so the committed `scriptCode` is the locking script **with its first 60 bytes removed** —
959,632 − 60 = 959,572, which is exactly the documented preimage arithmetic in `r1k1.ts`.
One pinned template therefore reconstructs both regions: rebuild the locking script, slice
60 bytes, and the `scriptCode` follows. No second template variant is required.

## Savings (measured, not estimated)

**Superseded by the addendum below.** The table and wire format immediately following this
note are the ORIGINAL (v1) design, kept for history — v1 never shipped (see the addendum),
so none of these exact byte counts were ever realized in a stored record. Skip to "Addendum
(2026-08-18, post-review): v2 header, vendored template, Uint8Array cache" for the
current, implemented numbers.

| | verbatim | compressed (v1, superseded) |
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

Roughly 3,824x on a deposit and 1,822x on a withdrawal (v1; superseded).

## Wire format (v1, superseded — see addendum)

A compressed region replaces the elided bytes with:

```
0xff              1 byte   marker: OP_INVALIDOPCODE
version           1 byte   template version, monotonic, never reused
region            1 byte   0x01 = R1K1 locking script, 0x02 = R1K1 preimage scriptCode
length            4 bytes  big-endian length of the ORIGINAL elided run, for validation
payload           N bytes  the variable fields for this region and version
```

`0xff` is chosen deliberately over `OP_NOP7`. `OP_NOP7` (0xb6) is a valid opcode that
evaluates as a no-op, so a script left in template form could pass evaluation and reach the
chain. `0xff` is not a defined opcode and is invalid in every context, so a compressed script
fails closed: it can never be spent, mined, or accepted, and any code that mistakenly treats
a compressed script as real gets an immediate, loud failure rather than silent wrong money.
(This guarantee is about *spending*, not *mining* — output scripts are never executed at
creation, so a compressed blob can still be mined into a real output and burn the funds it
holds. That's still true in v2, unchanged.)

For region 0x01 the payload is `commitment(20) ‖ k1PublicKeyHash(20)`. Region 0x02 carries
`k1PublicKeyHash(20)` only, because `subarray(60)` drops the commitment window at offsets
17..36; the commitment is recoverable from the `publicKey` and `salt` the unlocking script
pushes verbatim. Both of these are unchanged in v2.

## Requirements

1. `compress(bytes)` returns the compressed form, or the input unchanged when it does not
   match a known template.
2. `expand(bytes)` returns the original bytes **byte for byte**, or throws
   `VaultError('template-unknown')` for a version it cannot reconstruct. It never returns
   approximately-right bytes.
3. `expand(compress(x)) === x` for every fixture, asserted byte-wise, including the real
   mainnet script above.
4. Recognition is exact: a candidate is compressed only when it matches the pinned template
   at every non-variable offset. A near-miss is left alone.
5. Every historical template version stays reconstructable forever. Versions are pinned by
   the constant bytes they describe, not by an `@bsv/templates` semver range —
   `@bsv/templates` went 1.9.6 to 1.10.0 mid-development, and a byte-level change there must
   surface loudly, never as a wrong reconstruction. (As implemented post-addendum, "surface
   loudly" is a CI-visible test failure rather than a runtime `template-unknown` throw — see
   the addendum's decision 2: the reference bytes are now vendored, not rebuilt from the
   installed library, precisely so a library drift can be caught without being able to brick
   an already-stored record.)
6. The `subarray(60)` offset is a load-bearing constant owned by `@bsv/templates`. It is
   asserted in tests so a library change fails loudly rather than silently producing a wrong
   `scriptCode`.
7. Compression is never applied to bytes that leave the device. Broadcast, BEEF for a
   third-party send, and txid computation all use expanded bytes.

## Non-goals

- The ~96,000 sat withdrawal fee. That is the ~960 KB unlocking script going on-chain: real
  bytes a miner must accept.
- Transient memory during a spend. BEEF for a third-party send needs genuine bytes, so a
  withdrawal still materialises ~1.83 MB of `inputBEEF`.
- A general answer for any large record. This works because the vault script is a known
  template; the client's oversize guard stays as the backstop for everything else.

## Open questions deferred by the owner

- Whether to compress inside `StorageExpoSQLite` read/write paths (the owner chose the
  storage representation as the target). Landing the codec first keeps that decision
  reversible and reviewable on its own evidence.

## Addendum (2026-08-18, post-review): v2 header, vendored template, Uint8Array cache

The owner reviewed the initial implementation (PR #125) and made three decisions before
merge, landed together since they interact. This addendum records them; the sections above
are kept as the original design's history and are superseded where they conflict with this.

**1. v2 header with a 4-byte checksum.** The v1 header (above) fully cross-checked its own
fields but had no integrity check over the 40 payload bytes: a single bit flip would still
splice cleanly into the reference template and pass every v1 check, producing a
structurally perfect but wrong 959,632-byte script — wrong txid, a broken merkle proof, an
unrecoverable deposit record, with no error anywhere. v2 adds a 4-byte checksum (the first
4 bytes of SHA-256 of the full original/reconstructed bytes) to the header:

```
0xff (1) ‖ version (1) ‖ region (1) ‖ originalLength (4, big-endian) ‖ checksum (4) ‖ payload
```

`expandScript` verifies the checksum only *after* splicing the payload into the reference
template, against the full reconstructed result — reconstruct, hash, compare, then return,
never the reverse. v1 never shipped (nothing has ever called this codec outside its own
tests), so there is no v1 record to keep reading and no migration to perform; an
unrecognized version (including a literal v1 header) is simply rejected as
`template-unknown`, the same as any other unknown version — a clean cut, not a
compatibility gap.

**2. Vendor the template, gzipped.** Requirement 5 above ("versions are pinned by the
constant bytes they describe, not by an `@bsv/templates` semver range") turned out to be
under-implemented: only a SHA-256 of the constant bytes was pinned, while the reference
bytes themselves were rebuilt from whatever `@bsv/templates` was installed
(`package.json` pins `^1.10.0`). A routine `npm i` that drifted the template even one byte
made every previously-compressed record permanently unexpandable — not because the bytes
needed to reconstruct it were gone (they were sitting right there in the compressed blob),
but because the *reference* they'd be spliced into had silently changed underneath them.
The template is now vendored: gzip-compressed, base64-encoded, committed to
`services/vault/vaultTemplateArtifact.ts` (8,059 gzipped bytes for the 959,632-byte raw
template, both variable runs zeroed before compression). Reconstruction reads only this
file; the pinned constant-hash literals become a cross-check on the vendored asset rather
than the only defence against a moving library, and a separate test still confirms the
currently-installed `@bsv/templates` matches the vendored bytes, so a real upstream change
is still caught loudly, in CI, without being able to brick a stored record. Decoding uses
`fflate.gunzipSync` (already a dependency — see `patches/@bsv+templates+1.10.0.patch`,
which moved `@bsv/templates` itself onto the same function), never Node's `zlib` or
`DecompressionStream`, neither of which exist in React Native/Hermes.

**3. `Uint8Array` references, cached per batch, released after.** The reference bytes were
held as `number[]` — roughly 8 bytes per element in V8 even though every element fits in a
byte — and held twice (one copy per region), measured at 15.5–16.4 MB retained for the
process's lifetime: more than the 7.2 MB database this feature exists to shrink, alongside
114–200 ms per cold derivation against this project's "no >100 ms JS block" goal. They are
now `Uint8Array`s, with the region-0x02 reference a `subarray` view over region 0x01's
buffer rather than a second copy, cutting the resident cache to under 1 MB. The vendored
template plus the existing `PINNED_VARIABLE_RUNS` literal (cross-checked against the
vendored bytes via the masked-hash comparison, not merely trusted) now supply the run
geometry directly, so the sample-diffing machinery (`DIFF_SAMPLE_COUNT`, building several
throwaway `@bsv/templates` instances and diffing them) is gone entirely — a cold
`describeVaultTemplate()` call now measures single-digit milliseconds. `releaseTemplateCache()`
frees the cache explicitly; a caller processing a batch of records should hold it open for
the whole batch and release once at the end, not per record.

### Savings, recomputed for v2

Same derivation chain as the original table, with the v1 compressed component sizes (47,
27) replaced by the v2 ones (51, 31 — the 4-byte checksum added to each): deposit `rawTx` =
204 + lockingScript; R1 preimage = 161 + scriptCode; R1 unlocking script =
65 + 34 + 33 + (2 + preimage) + 1; withdrawal tx = 204 + unlock × inputs; base64 backup
record = ⌈n/3⌉ × 4; DB per vault tx = rawTx + lockingScript. (204 and 161 are the
non-script overhead this codec doesn't touch — the difference between each verbatim row
and the script/scriptCode length it wraps; unchanged from v1.)

| | verbatim | compressed (v2) |
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
from v1's 3,824x/1,822x, the cost of trading an unauthenticated payload for one a bit flip
can no longer silently corrupt.
