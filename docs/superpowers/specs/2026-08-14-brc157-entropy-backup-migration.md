# Migrating to BRC-157 entropy backup

**Status:** design proposal, awaiting decision
**Date:** 2026-08-14
**Spec:** [BRC-157](https://bsv.brc.dev/key-derivation/0157) — entropy as the single master secret, with BIP-39 mnemonic and BRC-140 shares as two interchangeable encodings of it

---

## The finding that decides the design

**The app's on-chain keys do not change at all.** BRC-157's root key is:

```
rootKey = HD.fromSeed(Mnemonic.fromEntropy(entropy).toSeed()).derive("m/0'/0'").privKey
```

which is byte-identical to what `utils/mnemonicWallet.ts:52-53` already computes today. Verified empirically over 200 random 16-byte entropy values: **200/200 match.**

So the app is *already* BRC-157-compliant on the derivation side. Exactly one thing is wrong:

| | payload inside the backup shares |
|---|---|
| today (`utils/backupShares.ts:20-27`) | the **derived** `m/0'/0'` private key |
| BRC-157 | the **entropy** that the mnemonic encodes |

That single difference is why the two artifacts are incompatible today: `m/0'/0'` is a *hardened* derivation, so it is one-way. Shares of the derived key can restore spending authority but can never reconstruct the mnemonic. Shares of the entropy can do both.

### What this means for the proposed plan

The plan in the goal was to version the database and tag each output as old-way or new-way. **Output tagging is not needed and should be dropped.** There is no "old way" and "new way" for outputs — the key that locks them is the same key before and after. Nothing on-chain changes, no address changes, no sweep, no dual-derivation period, no per-output metadata.

What *is* needed is a version record — but on the **backup format**, not on outputs. The app needs to know whether a user's printed shares contain entropy or a derived key, in order to prompt for the upgrade and to interpret shares correctly at restore.

---

## Three cohorts

### A. Mnemonic still available — the overwhelming majority

Migrate in place. No on-chain activity, no risk to funds.

```ts
const entropy = Mnemonic.fromString(mnemonic).toEntropy()   // 16 bytes for a 12-word wallet
assertValidEntropy(entropy)                                  // see gap #1 below
const padded = [...Array(32 - entropy.length).fill(0), ...entropy]  // BRC-157 left-pad
const shares = new PrivateKey(padded).toBackupShares(2, 3)
// print, then record backupFormat = 2 and entropyBytes = entropy.length
```

Cost to the user: one tap and a trip to the printer. Their spend key never moves.

### B. Restored from shares, no mnemonic

`m/0'/0'` is hardened, so the entropy is unrecoverable. These wallets **cannot** be migrated in place — this is a mathematical limit, not an implementation gap.

Two options, and I recommend the first:

1. **Leave them on legacy, do not nag.** Their existing shares still restore full spending authority; nothing is broken and nothing is at risk. Mark them `backupFormat = 1, migratable = false` and offer an *optional* upgrade rather than a warning. The only thing they lack is the ability to recover a mnemonic they never had.
2. **Opt-in fresh start:** generate new BRC-157 entropy, build a second wallet, sweep everything across, print new shares. This is the "transfer funds out first" path from the goal. It is the only route to full compliance for this cohort, but it costs a transaction, breaks identity-key continuity, and should never be forced.

Note this cohort already cannot use the vault (`EnrollWizard` hard-gates on `getMnemonic()`), so the constraint is consistent with what already ships.

### C. New wallets

Generate 32 bytes of validated entropy → 24 words → shares over the entropy. Fully BRC-157 from birth. Note this changes new wallets from 12 words to 24.

---

## The one real hazard: shares are format-ambiguous

A legacy share and a BRC-157 share are **the same string format** — `base58(x).base58(y).threshold.integrity`. `PrivateKey.fromBackupShares()` returns 32 bytes either way, and `app/auth/scan-shares.tsx:86-90` feeds them straight into `buildWalletFromRecoveredKey`, which at `context/WalletContext.tsx:1288` uses them **directly as the primary key**.

Interpret an entropy share that way and you silently get a valid-looking but completely wrong wallet: different identity key, no funds, no error. This is the failure mode to design against.

### Resolution: the identity key is already on the page

`generatePrintHTML` already prints the identity key, with its own QR, on every share page (`utils/backupShares.ts:113, 140-141`). That is sufficient to disambiguate — including on **paper already in the wild**, which no version field can retroactively fix.

At restore, compute both candidates and match against the printed identity key:

```ts
const asKey     = new PrivateKey(payload).toPublicKey().toString()
const asEntropy = HD.fromSeed(Mnemonic.fromEntropy(trim(payload)).toSeed(''))
                    .derive("m/0'/0'").privKey.toPublicKey().toString()
// exactly one matches the identity key printed on the share page
```

Verified: for a legacy payload only `asKey` matches; for a BRC-157 payload only `asEntropy` matches. Never both.

### Defence in depth

Two cheap backstops for when the user cannot supply the identity key:

- **Leading-zero test.** A 12-word wallet's entropy is 16 bytes left-padded to 32, so a BRC-157 payload always has ≥16 leading zero bytes. A legacy payload is a uniformly random scalar. Measured over 2000 trials: legacy never exceeded **1** leading zero byte; BRC-157 never fell below **16**. A `≥12` threshold separates them, with a false-positive probability of `256⁻¹⁶ = 2⁻¹²⁸`.
  Caveat: this works because existing wallets are 12-word. A 24-word BRC-157 wallet has no padding and is *not* distinguishable this way — which is why cohort C needs the version field.
- **Version field on new prints.** Put `backupFormat` and the entropy length in the printed page and the QR payload wrapper, keeping the raw share string intact for manual entry. This covers everything printed from today onward; the identity-key check covers everything printed before.

---

## Two spec-compliance gaps in the SDK

Found while verifying, both need app-side handling:

1. **Zero entropy is not rejected.** BRC-157 requires entropy in `[1, n−1]` and says zero and values `≥ n` must be rejected at generation, mnemonic decode, and share recovery. `new PrivateKey(Array(32).fill(0))` is accepted by `@bsv/sdk` 2.4.0 without complaint. Add an `assertValidEntropy()` and call it at all three points. (This is not merely theoretical: the well-known `abandon abandon … about` test vector *is* 16 zero bytes, which is how a first draft of my own verification passed degenerately.)
2. **Record the entropy length explicitly.** BRC-157 offers a fallback heuristic — `max(16, roundUpToMultipleOf4(32 − leadingZeros))` — for recovering the original word count. It happens to be safe for 12-word wallets because of the `max(16, …)` floor (0/200 failures), but it is guesswork. Store `entropyBytes` alongside `backupFormat` and use the heuristic only for legacy paper.

---

## SDK upgrade

`toEntropy()` / `fromEntropy()` are **not** in the installed `@bsv/sdk` 2.1.9. Latest is **2.4.0**, which has both. That is a three-minor jump underneath a wallet, so it wants its own commit and its own verification pass rather than riding along with the migration work. The 768-test suite is the safety net.

---

## Recommended shape

1. Upgrade `@bsv/sdk` to 2.4.0 on its own branch; confirm the suite stays green.
2. Add `assertValidEntropy()` and a `backupFormat` / `entropyBytes` record to wallet settings (default `1` for existing installs).
3. Teach the restore path to disambiguate via the printed identity key, with the leading-zero fallback.
4. Add an "Upgrade your backup" card for cohort A: one tap, derive entropy, reprint, set `backupFormat = 2`. Advise destroying the old set once the new one is stored — otherwise six shares exist for one wallet and any two of *either* set is enough, which doubles the exposure for no benefit.
5. New wallets: 32 bytes of validated entropy, 24 words, shares over entropy.
6. Cohort B: offer, never force. Their current backup still works.

Explicitly **not** doing: output metadata, dual derivation, or any forced fund movement.

---

## Open questions

- Do we want new wallets on 24 words (BRC-157's generated form), accepting the UX cost versus today's 12?
- For cohort B, is an opt-in sweep-to-new-wallet flow worth building now, or deferred until someone asks?
- Should the upgrade card be dismissible-forever, or resurface periodically?
