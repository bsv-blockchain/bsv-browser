# Vault backup prerequisite, and BRC-157 recovery shares

Date: 2026-08-16
Status: approved design, not yet planned
Branch: `feat/wallet-backup-log`

## Problem

The vault screen invites a user to lock funds behind a hardware key before that user has any
proven way to recover the wallet. Two failures compound:

1. **No backup is required.** Enrollment asks for a nickname and a passphrase, offers a
   "Print recovery shares" button, and lets the user continue whether or not they press it.
   Deposits are ungated beyond enrollment.
2. **The offered backup does not do what the screen implies.** `generateBackupShares` splits the
   primary key at `m/0'/0'` (`utils/backupShares.ts:20`). That derivation is hardened and one-way,
   so the shares can restore spending authority for the everyday balance but can never rebuild the
   mnemonic — and the vault key needs the mnemonic. A user who prints shares, loses the phone, and
   restores from paper finds the vault permanently shut.

The result is a screen that tells users their money is safer while removing their ability to get
it back. User research is unambiguous that most people never back up voluntarily, so the fix is a
precondition, not a prompt.

## Decisions

| Question | Decision |
|---|---|
| What counts as backed up? | Self-attestation. No verification quiz. |
| Which media satisfy it? | Either the phrase or printed shares. One is enough. |
| Scope of the gate | Vault only — enrollment and deposits. Ordinary sends untouched. |
| Legacy printed shares | Keep working, warn, offer a remedy. |
| Existing unbacked vault holders | Not catered for. The vault is unreleased, so they cannot exist. |

Self-attestation over a quiz because the person needs to be held accountable but verification
should not be painful. Either-medium because BRC-157 makes the two genuinely equivalent, so
ranking them would be arbitrary.

## Part A — Share format: split the entropy, not the primary key

Per [BRC-157](https://bsv.brc.dev/key-derivation/0157), shares carry the mnemonic *entropy*.
Recovery then rebuilds the mnemonic, the seed, `m/0'/0'`, and therefore everything downstream
including the vault. Phrase and shares become two encodings of one secret.

### Payload framing

The naive form — split the raw entropy — cannot be distinguished from a legacy share on recovery.
A 12-word phrase yields 16 bytes, but the import path accepts 12–24 words
(`utils/mnemonicWallet.ts:35`) and a 24-word phrase yields **32 bytes, byte-identical in length to
a legacy primary key**. Length alone would silently restore the wrong wallet.

The secret is therefore always exactly 32 bytes:

```
payload = entropy(16) || sha256(entropy)[0..16]
```

Recovery left-pads to 32 unconditionally, then tests the tag:

| tag matches | interpretation |
|---|---|
| yes | v2 — bytes 0..16 are the entropy; rebuild the mnemonic from them |
| no | legacy primary key; use directly, warn the user |

The unconditional pad is load-bearing. `PrivateKey` is a BigNumber, so `toArray()` drops leading
zero bytes; roughly 1 in 256 payloads begins with `0x00`. Without the pad, v2 payloads decode
short and legacy payloads fail an `=== 32` check — the bug strands both cohorts.

Measured over 400 generated wallets: 400/400 v2 round-trips exact (2 with a leading zero byte),
0/400 legacy keys misread as v2. Analytic collision probability is 2⁻¹²⁸.

### Rejected alternative

An earlier draft validated the 16-byte branch by round-tripping entropy through
`Mnemonic.fromEntropy` and checking the BIP39 checksum. That check is vacuous: `fromEntropy`
*computes* the checksum, so it accepts any 16 bytes and can never reject a misclassification.
Verified empirically over 300 random inputs — zero rejections.

### 24-word phrases

32 bytes of entropy leaves no room for the tag, and `toBackupShares` splits a 256-bit scalar, so
there is nowhere to grow. For an imported 24-word wallet the print-shares affordance is disabled
with a plain reason, and the phrase is the only route through the gate. This affects imports only;
the app has never generated anything but 12 words.

### Legacy shares

Accepted, never silently. On classifying a payload as legacy, tell the user the format changed and
that these shares cannot open a vault.

The remedy depends on what else the user still holds, and the copy must offer them in this order:

1. **Has the phrase** — whether re-printing from Settings or restoring on a device that already
   has the wallet. Recover from the mnemonic and re-print. Keeps the wallet, keeps the vault.
2. **Restoring from legacy paper, but the phrase exists somewhere** — restore from the phrase
   instead. It recovers everything the shares do plus the vault, then re-print from there. Prompt
   for this before assuming the phrase is gone; a user reaching for paper has not necessarily lost
   it.
3. **Phrase genuinely gone** — sweep everything to a fresh wallet. Last resort, not the default
   advice, and the only case where the legacy restore cannot be upgraded in place.

Mixing v1 and v2 paper is already impossible — `validateShareCompatibility` rejects mismatched
integrity hashes (`utils/backupShares.ts:68`), and the two versions carry different secrets. The
error message it produces ("shares are from different keys") is misleading for this case and
should name the version mismatch.

## Part B — Restore must persist the mnemonic

Today `app/auth/scan-shares.tsx:90` converts the recovered key to WIF and calls `setRecoveredKey`;
`setMnemonic` is never reached, so a share-restored wallet has no phrase. Leaving that in place
would make the entropy change worthless — the restored wallet would still be barred from the vault
at `components/vault/EnrollWizard.tsx:89`.

A v2 restore must instead:

1. Rebuild the mnemonic from the entropy and persist it via `setMnemonic`.
2. Clear any stored `recoveredKey`, so the two secrets cannot coexist and disagree.
3. Handle a refused biometric without destroying state — `setMnemonic` is behind `ensureAuth`
   (`context/LocalStorageProvider.tsx:125`), and a refusal after clearing `recoveredKey` would
   leave no wallet at all on the next launch. Clear only after the write succeeds.

A legacy restore keeps the existing WIF path unchanged.

This also removes an existing asymmetry: mnemonic wallets hand the BIP32 master to the
`PrivilegedKeyManager` while share-restored wallets hand it the `m/0'/0'` child
(`context/WalletContext.tsx:1318`). After a v2 restore both paths derive identically.

## Part C — The backup step

`EnrollWizard`'s `Step` union gains `backup` as the first state, ahead of `passphrase` and the
YubiKey ceremony. The nickname input stays on `intro`; only the backup obligation moves forward.
The component is a sequence of guarded returns, so this is one new early-return block.

Layout: heading, one line of rationale, then two rows as a checklist.

| Row | Action | Sets the flag when |
|---|---|---|
| Write down your recovery phrase | Opens a reveal sheet: the 12 words, a copy action, and an explicit "I have written these down" confirm | The user confirms |
| Print recovery shares | Calls the existing `printRecoveryShares` | `Print.printAsync` resolves — a cancelled sheet sets nothing |

A completed row shows a tick and stays tappable, so either medium can be added later without
nagging. Continue enables on the first tick. The footer states that either one is enough and that
both restore everything, vault included.

Reveal sits behind the existing biometric gate and enables screenshot protection while mounted.
The words are the entire wallet; one Face ID prompt is cheap next to an over-the-shoulder capture.

Follow the file's established idioms: module-level `t` helper rather than `useTranslation`, the
three existing button shapes, colours inline from `useTheme()`, one shared StyleSheet at the
bottom, errors as inline translated text above the primary button.

## Part D — The deposit gate

Enforced inside `depositToVault` (`services/vault/transfers.ts:225`), beside the existing dust
check.

This is defence in depth rather than the primary gate. Because enrollment itself now requires a
backup, a vault cannot normally exist alongside an unset flag. The deposit check covers the paths
that skip the wizard — the deep link straight to the transfer screen, and any future state where
the flag is cleared while a vault survives.

Explicitly **not** inside `nextDepositKey` (`services/vault/transfers.ts:86`), despite that being
the single funnel for every vault-basket output. A partial withdrawal re-vaults its remainder
through the same function (`services/vault/transfers.ts:306`), and the withdraw UI always passes a
parsed integer with no sweep affordance, so a gate there would block most **withdrawals**. Locking
someone out of their own money is the precise failure this feature exists to prevent. The
placement needs a comment saying so, or a later tightening will reintroduce it.

The service-layer placement still covers the deep link that lands directly on the transfer screen
(`app/+native-intent.ts:21`), since that path funnels through `depositToVault` too. No dApp route
needs covering: `admin vault` is admin-reserved and the toolbox rejects web originators before
permission config is consulted.

Surfacing: the deposit screen currently renders a single inline red footnote and its i18n fallback
is broken for unknown codes (`app/vault-transfer.tsx:81`), so a new error code would ship as a raw
key string. Use the house pattern for a hard-blocked vault action — the `showAlert` modal already
used by disable-while-funded (`app/vault.tsx:66`) — with a route into the backup step. Fix the
fallback so an unrecognised code degrades to readable text.

## Part E — The flag

One persisted record, scoped to the wallet identity. A bare global key would survive Delete
Wallet — which is wired straight to `logout()` (`app/wallet-config.tsx:581`), and logout clears
only four keys (`context/WalletContext.tsx:1713`) — so the next wallet on that device would be
born already backed up.

Follow `services/vault/vaultStore.ts` as the reference: a frozen object literal with async
accessors, a numeric `v` discriminant on the persisted shape, and getters that swallow parse
errors and return null rather than throwing. Scope by interpolating the identity suffix into the
key, matching the established `keySuffix` idiom (`context/WalletContext.tsx:813`).

Logout must clear it. Record the medium used and a timestamp, not a bare boolean, so the UI can
show which row is ticked.

The flag is advisory. It records that a user said they wrote something down — it is not a security
control and the write-up around it should not imply otherwise.

Users who already printed shares before this ships have no flag and must repeat the action. That
is acceptable and mildly desirable: their existing paper is legacy format, so re-printing upgrades
it.

## Part F — Copy that becomes false

Under BRC-157 shares reconstruct the mnemonic, so shares plus the vault passphrase open the vault.
Three places currently assert the opposite and must change together:

- `components/vault/EnrollWizard.tsx:317` — `RecoveryPaths`' second path becomes "your recovery
  phrase **or backup shares**, plus the vault passphrase".
- The footnote under the print button — "Recovery shares restore your everyday balance only. They
  cannot open the vault" — deleted. Leaving it tells users their vault backup is worthless.
- `utils/printRecoveryShares.ts:4-14` — the header comment documents the old hardened-derivation
  reasoning at length and is the file a future reader will trust.

The printed sheet itself now carries seed-equivalent material. Its recovery instructions should say
so, and the security framing should treat a single sheet as more valuable than before, even though
2-of-3 still means one stolen page reveals nothing.

New strings land in `en` first, at the `vault_off` anchor that ends every locale's vault run
(`context/i18n/translations.tsx:300`), with the other 11 locales backfilled in a separate
machine-translation commit — the established house pattern. Nothing enforces locale parity, so a
typo renders as the raw key.

## Part G — Testing

The share format currently has **zero test coverage** and three duplicated producers
(`app/auth/mnemonic.tsx:128`, `app/wallet-config.tsx:136`, `utils/printRecoveryShares.ts:50`).
Collapse them onto the one util as part of this work.

Cases:

- v2 round-trip: entropy → payload → shares → recovery → identical entropy and identical mnemonic.
- Forced leading-zero payload, asserting the pad restores full width.
- Legacy 32-byte primary key classifies as legacy, never as v2.
- A corrupted tag classifies as legacy rather than producing a wrong mnemonic.
- Restore persists the mnemonic and clears `recoveredKey`; a refused biometric leaves prior state
  intact.
- Gate: `depositToVault` refuses while unset; `withdrawFromVault` with a re-vaulted remainder
  succeeds while unset.
- Flag: scoped per identity, cleared by logout.

Assertions are on shape and equality of derived values, never on real key material, and any
manual verification uses a disposable wallet profile.

## Out of scope

- Forcing or nagging backup anywhere outside the vault.
- Any gate on ordinary sends, including large ones.
- Entropy/mnemonic backup to a remote service — the encrypted backup log is a separate feature.
- Verification quizzes.

## Adjacent bugs found, not fixed here

Each deserves its own ticket:

- `vault_meta_v1` also survives Delete Wallet, so a new wallet can inherit vault metadata only the
  previous wallet can recover (`services/vault/vaultStore.ts`).
- `getMnemonic()` triggers a biometric prompt for share-restored users before returning null,
  because `setRecoveredKey` sets the shared `hasWalletKeys` flag — one wasted prompt per launch
  (`context/LocalStorageProvider.tsx:141`).
- `generateRandomMnemonic(strength)` ignores its argument and always returns 128 bits
  (`utils/mnemonicWallet.ts:92`). Currently dead code.
- `buildWalletFromRecoveredKey` rewrites the WIF, causing a second biometric prompt on restore
  (`context/WalletContext.tsx:1345`).
- The encrypted backup-log restore has no UI consumer, so a share restore recovers spending
  authority without repopulating the transaction database (`utils/backup/restore.ts:49`).
