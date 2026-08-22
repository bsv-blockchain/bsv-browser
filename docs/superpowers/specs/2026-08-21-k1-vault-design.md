# K1-Only Vault: Drop the R1 Spend Path

**Date:** 2026-08-21
**Status:** Approved for implementation
**Supersedes:** `2026-08-15-r1k1-vault-design.md` (the R1-K1 experiment), the
compressed-at-rest codec design (`2026-08-19-tx-size-limits-and-blob-compression-design.md`),
and the template-compression design (`2026-08-18-vault-script-template-compression-design.md`).

## Summary

The vault drops the on-chain secp256r1 (R1) spend path entirely. Vault outputs
become plain P2PKH locked to per-output BIP32 K1 children of a vault xprv. The
YubiKey remains the gate for every vault operation — deposit and withdrawal —
but its role changes from *on-chain signer* to *hardware unwrap oracle*: it
PIV-ECDH-unwraps the vault xprv, which lives briefly in memory while keys are
derived and signatures gathered, then is zeroized.

## Motivation

The R1 path's UX cost is transaction-size-bound, not YubiKey-bound:

- R1-K1 locking script: **959,632 bytes per output** (secp256r1 verification
  implemented in Bitcoin script).
- R1 unlocking script: **959,871 bytes per input** (the whole sighash preimage
  is pushed).
- Measured wall-clock: ~40 s to create a vault output, ~80 s to spend one.

Under K1-only, locking is 25 bytes and unlocking ~107 bytes — roughly a
10,000× reduction. Deposits and withdrawals become ordinary-sized
transactions, and the entire compressed-at-rest storage layer (built solely to
keep ~960 KB scripts out of the database and backup log) becomes unnecessary.

R1-K1 was a development experiment. It never reached production; all R1-K1
outputs have been spent back to test wallets. There is no migration burden and
no legacy-decode requirement.

## Security model (accepted trade-off)

**What is lost.** With R1, the hardware key signed on-chain and the private
key never existed outside the YubiKey. Now the K1 xprv exists in plaintext in
phone memory during the signing window; malware resident at spend time could
exfiltrate the key controlling the vault.

**What is kept.**

- The YubiKey ECDH private key never leaves hardware. The at-rest blob is
  useless without a physical tap. No password is in the loop, so there is no
  offline brute-force angle against the blob.
- Every vault operation — deposit and withdrawal — requires YubiKey presence.
- The K1 leg was already a full-strength spend path in the R1-K1 template, so
  compromise of the K1 key was already total loss. The marginal loss is
  "hardware-only signing", not "hardware-gated access".

**Residual risks (documented, accepted):**

1. Memory zeroization under React Native / Hermes is best-effort. All secret
   material is handled as `Uint8Array` and overwritten after use, but the
   runtime may have made copies (JS value semantics, GC moves). This is an
   accepted residual risk.
2. Existing vault outputs (outpoints, amounts, history) are visible in the
   wallet's SQLite `outputs`/`transactions` tables — the toolbox needs them
   for balance display and coin selection. Phone compromise reveals current
   vault UTXOs. Database-at-rest encryption is out of scope for this change.

## Design

### 1. Output format

- Plain P2PKH locked to a per-output BIP32 K1 child of the vault HD node
  (derivation unchanged: `services/vault/vaultDerivation.ts`, vault seed =
  `Mnemonic.toSeed(passphrase)` from the main mnemonic, deposit address *n* =
  `vaultHD.deriveChild(n)`).
- `customInstructions` v3: `{ v: 3, type: 'K1', keyID: 'bip32/<n>' }`.
  The v2 fields `salt`, `r1PublicKey`, and `slot` are removed.
- Per-output children preserve on-chain address privacy (no vault-wide
  clustering from a single reused address).

### 2. Key custody and flows

- **At rest on phone:** exactly two vault artifacts — the PIV-ECDH-wrapped
  vault xprv blob (PR #116 wrap/gate machinery, reused unchanged) and a
  plaintext `nextKeyIndex` counter. Nothing else. In particular, **no xpub is
  stored**, wrapped or plaintext: the xpub is derivable from the xprv on
  unwrap, so persisting it separately would only weaken privacy.
- **Deposit:** YubiKey tap → ECDH-unwrap xprv → derive child *n*'s public key
  → build P2PKH locking script → increment `nextKeyIndex` → zeroize.
  Consequence: vault deposits are deliberate tap ceremonies; no flow may
  auto-derive a vault address without the user present.
- **Withdrawal:** YubiKey tap → ECDH-unwrap xprv → derive the child private
  keys named by each input's `keyID` → sign → zeroize.
- **Zeroization convention:** secret bytes travel as `Uint8Array`, are
  overwritten immediately after last use, and never appear in logs, errors,
  or React state.

### 3. Recovery ("lost my YubiKey")

Same key, two custody routes — not two keys:

1. **Daily:** YubiKey tap → unwrap on-phone blob → xprv.
2. **Recovery:** main mnemonic + vault passphrase → re-derive the same xprv
   (`vaultDerivation.ts`) → re-wrap to a replacement YubiKey.

Because both routes reach the same key, existing outputs remain spendable
as-is after YubiKey replacement; no sweep is required. The single-backup-phrase
property is preserved: there is no third path and nothing to reset.

**Multisig considered and rejected.** P2MSKH 1-of-2 (`@bsv/templates`) only
pays off with two genuinely independent keys; an independent recovery key
would need its own backup artifact (reversing the one-phrase consolidation),
and P2MSKH unlocks reveal both public keys plus the multisig script (~3× the
P2PKH unlock size) while reintroducing template complexity this change exists
to delete.

### 4. Deletions

All of the following exist solely because of the ~960 KB R1 scripts and are
removed outright (no legacy-decode path):

- `services/vault/r1k1.ts` (replaced by a thin K1 module: v3
  customInstructions codec + P2PKH lock/unlock construction)
- `services/vault/templateCodec.ts`
- `services/vault/templateRegistry.ts`
- `services/vault/vaultTemplateArtifact.ts`
- `services/vault/txEnvelope.ts`
- The compress/expand hooks in `storage/StorageExpoSQLite.ts` and
  `storage/methods/expandStored.ts`
- All R1-K1 tests and fixtures (`__tests__/vault/r1k1*`,
  `__tests__/storage/compressStored.test.ts`, `expandStored.test.ts`,
  `txEnvelope.test.ts`, `templateCodec.test.ts`, the mainnet fixture)
- The `@bsv/templates` `R1K1Wallet` import; drop the dependency entirely if
  nothing else imports the package

This retires the PR #139 compressed-at-rest machinery wholesale.

### 5. Survives (with simplification)

- Ceremony/enrollment, YubiKey serial check, guard, session,
  `VaultKeyService`, `vaultStore`, `backupAttestation`
- `transfers.ts` — the R1 wrong-key check and R1 signing branch are stripped;
  K1 signing remains, now the only path
- `vaultDerivation.ts` — derivation math unchanged; its header commentary
  about persisting the xpub is superseded by section 2 (no stored xpub) and
  must be updated
- The two-transaction deposit fix and the deferred-broadcast rail

### 6. Testing

- K1 lock/unlock roundtrip (script bytes, address, signature validity)
- Derivation determinism (same mnemonic+passphrase+index → same key, forever)
- Full wrap → unwrap → derive → sign → zeroize flow against `mockYubiKey`
- Deposit requires tap: no code path derives a vault address without an
  unwrap
- v3 customInstructions codec: encode/decode, fail-closed on unrecognized
  input
- Spend-proof script (successor to `scripts/r1k1-spend-proof.ts`) against
  testnet

### 7. Branch / integration

- Spec committed on `master` (current branch). Implementation proceeds from
  here per the implementation plan.
- The PIV-ECDH wrap/gate parts of unmerged PR #116 are the custody
  foundation; take those pieces rather than building on the full PR #116
  branch, which also carries R1 material.

## Out of scope

- Database-at-rest encryption (residual risk 2)
- Publishing changes to `@bsv/templates`
- Any change to the main (non-vault) wallet's key handling
