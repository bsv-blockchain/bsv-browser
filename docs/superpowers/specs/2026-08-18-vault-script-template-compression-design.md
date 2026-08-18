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

## Wire format

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

For region 0x01 the payload is `commitment(20) ‖ k1PublicKeyHash(20)`. Region 0x02 carries
`k1PublicKeyHash(20)` only, because `subarray(60)` drops the commitment window at offsets
17..36; the commitment is recoverable from the `publicKey` and `salt` the unlocking script
pushes verbatim.

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
   surface as `template-unknown`, never as a wrong reconstruction.
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
