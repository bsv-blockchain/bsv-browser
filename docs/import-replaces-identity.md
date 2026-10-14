# An import replaces the stored identity

Issue #165, PR #166. Found on 2026-10-14 on 1.7.0 (`e69cbe17`, `@bsv/expo-wallet-toolbox` 0.14.0).

## What happened

The import screen (`bsv-browser://auth/mnemonic?flow=import`) took a 64-hex private key over a wallet created from a
phrase. The app kept the old identity: `getPublicKey({ identityKey: true })` still returned the phrase wallet's key. The
screen still celebrated and attested a backup for the imported key's identity. Only uninstalling, resetting the
keychain and importing again gave the imported identity.

## The lines

`app/auth/mnemonic.tsx`, `handleContinueWithImported`, hex branch, before the fix:

1. `setRecoveredKey(wif)` stores the imported key;
2. `rebuildWallet({ restoreFromBackup: true })` tears the wallet down and bumps the toolbox's auto-build;
3. the auto-build (`@bsv/expo-wallet-toolbox` `core/context/WalletContext.tsx`, "mnemonic first, then recovered key")
   calls `buildWalletFromMnemonic()`, which reads the stored mnemonic and builds the old identity. The recovered key is
   read only when no mnemonic is stored.

The phrase branch (`initializeWallet`) never deleted a recovered key left by an earlier hex import, so both secrets
stayed in the keychain.

## The fix

Once the new secret is stored, delete the other kind, then build. This is the write order of the toolbox's
`core/recovery/restoreWallet.ts`:

- hex: `deleteMnemonic()` after `setRecoveredKey(wif)` returns true;
- phrase: `deleteRecoveredKey()` after `setMnemonic(phrase)` returns true.

A refused store (declined biometric) returns before any delete, so the device never holds neither secret.

## The test

`__tests__/mnemonicSafety.test.tsx`, "an import over an existing wallet replaces its identity". It models the keychain
in memory and the rebuild by the auto-build's rule. Before the fix, the hex import rebuilt `02f32dbd…` (the phrase's
identity) instead of `0279be66…` (the imported key's), and a phrase import left the old key stored.

## Not changed

`app/auth/scan-shares.tsx`'s legacy-key branch stores a recovered key without deleting a stored mnemonic. It has the
same shape and is noted in #165.

## The other fault from the same run

The same run hit a second wallet fault: an action Arcade answered `RECEIVED` and later `REJECTED`, which jammed the
actions funded from its change. That one belongs to `@bsv/wallet-toolbox-mobile`: bsv-blockchain/ts-stack#1079, fixed
by bsv-blockchain/ts-stack#1080. This repo takes it with the bump to the first release that carries #1080.
