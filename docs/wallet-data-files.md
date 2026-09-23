# Wallet data files

Open **Wallet data files** from Settings or Wallet configuration. Choose a BRC-38 or BRC-39 file with the native document picker, enter its passphrase if encrypted, and validate it. The screen displays the wallet identity, network and every record category before any activation. Signing keys are recovered separately.

Create an encrypted export with a long passphrase of at least 12 characters. Save/share uses the native platform sheet. Completed exports and original imports remain available after restart or container relocation. Wrong passwords, corrupt tags and invalid records leave the active wallet unchanged.

Restore a separate copy first, or merge into the matching active wallet. Merge saves a complete before point, reconciles records separately and retains resumable progress. Changed recovery data and mismatched destinations fail closed. Explicit activation stops and drains the existing monitor and wallet sessions, selects a verified database for the exact identity/network, and rebuilds the wallet with its existing keys.

The native adapter retains the application's SQLite schema and monitor tasks. Operations use bounded streaming (2 GiB files, 64 MiB rows), strict category/reference validation, Argon2id and AES-256-GCM. The iOS SQLite text patch preserves embedded NUL values, and iOS/Android statement finalization records freed state before reporting an SQL error.

## Dependency compatibility

SDK 2.8.0's transaction snapshot and atomic signing checks are preserved. The previous native batch-signing shortcut is disabled until it implements those guards. Compatible native primitive acceleration remains. Header proof checks now supply exactly 32 hash bytes to the patched Toolbox API. Restored databases must match the selected identity, network and storage key before any migration. Protocol permissions and vault access checks remain active.

The dependency update aligns Expo 55 and React Native 0.83 patch releases and their native pods. The Templates 1.10.2 CommonJS patch corrects double-wrapped SDK default imports ([upstream report](https://github.com/bsv-blockchain/ts-stack/issues/571)); the ESM build is unchanged. The Expo Router patch uses the default export of query-string 9.5.1, allowing its patched URI decoder without changing URL semantics. Both compatibility patches have targeted regression coverage. Native engine provenance is generated from the locked Cargo dependency rather than an absent sibling checkout.

This repository tracks its iOS project. Expo Doctor therefore reports the existing non-CNG configuration-sync warning: changes to app.json native properties must also be applied to the native project. The aligned dependencies pass its other 19 checks. Do not regenerate the tracked iOS project without preserving the custom native modules and entitlements.

Run `npm run test:wallet-files` on Node 24.18 or newer for the independent streaming/SQLite/codec/monitor checks, `npm test -- --runInBand`, `npx tsc --noEmit` and platform bundle builds. Native file-picker/share-sheet, cancellation/restart and cross-wallet application-state acceptance must be recorded for each supported device before release. Synthetic test results do not establish a production or laboratory conformance result.

References: [BRC-38](https://github.com/bsv-blockchain/BRCs/blob/2b959b13f1f73040d13cc4eb14edbfc376f8010b/outpoints/0038.md), [BRC-39](https://github.com/bsv-blockchain/BRCs/blob/2b959b13f1f73040d13cc4eb14edbfc376f8010b/outpoints/0039.md).
