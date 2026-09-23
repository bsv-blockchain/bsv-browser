# Wallet data files

Open **Wallet data files** from Settings or Wallet configuration. Choose a BRC-38 or BRC-39 file with the native document picker, enter its passphrase if encrypted, and validate it. The screen displays the wallet identity, network and every record category before any activation. Signing keys are recovered separately.

Create an encrypted export with a long passphrase of at least 12 characters. Save/share uses the native platform sheet. Completed exports and original imports remain available after restart or container relocation. Wrong passwords, corrupt tags and invalid records leave the active wallet unchanged.

Restore a separate copy first, or merge into the matching active wallet. Merge saves a complete before point, reconciles records separately and retains resumable progress. Changed recovery data and mismatched destinations fail closed. Explicit activation stops and drains the existing monitor and wallet sessions, selects a verified database for the exact identity/network, and rebuilds the wallet with its existing keys.

The native adapter retains the application's SQLite schema and monitor tasks. Operations use bounded streaming (2 GiB files, 64 MiB rows), strict category/reference validation, Argon2id and AES-256-GCM. The iOS SQLite text patch preserves embedded NUL values, and iOS/Android statement finalization records freed state before reporting an SQL error.

## Dependency compatibility

SDK 2.8.0's transaction snapshot and atomic signing checks are preserved. The previous native batch-signing shortcut is disabled until it implements those guards. Compatible native primitive acceleration remains. Header proof checks now supply exactly 32 hash bytes to the patched Toolbox API. Restored databases must match the selected identity, network and storage key before any migration. Protocol permissions and vault access checks remain active.

The dependency update aligns Expo 55 and React Native 0.83 patch releases and their native pods. Published Templates 1.10.3 fixes the SDK import interoperability reported in [TS Stack #571](https://github.com/bsv-blockchain/ts-stack/issues/571), so the temporary CommonJS patch is removed. The Expo Router patch uses the default export of query-string 9.5.1, allowing its patched URI decoder without changing URL semantics. Template interoperability and the remaining router patch have targeted regression coverage. Native engine provenance is generated from the locked Cargo dependency rather than an absent sibling checkout.

This repository tracks its iOS project. Expo Doctor therefore reports the existing non-CNG configuration-sync warning: changes to app.json native properties must also be applied to the native project. The aligned dependencies pass its other 19 checks. Do not regenerate the tracked iOS project without preserving the custom native modules and entitlements.

Run `npm run test:wallet-files` on Node 24.18 or newer for the independent streaming/SQLite/codec/monitor checks, `npm test -- --runInBand`, `npx tsc --noEmit` and platform bundle builds. Native file-picker/share-sheet, cancellation/restart and cross-wallet application-state acceptance must be recorded for each supported device before release. Synthetic test results do not establish a production or laboratory conformance result.

References: [BRC-38](https://github.com/bsv-blockchain/BRCs/blob/2b959b13f1f73040d13cc4eb14edbfc376f8010b/outpoints/0038.md), [BRC-39](https://github.com/bsv-blockchain/BRCs/blob/2b959b13f1f73040d13cc4eb14edbfc376f8010b/outpoints/0039.md).

Toolbox Mobile 2.14.0 incorporates [TS Stack #579](https://github.com/bsv-blockchain/ts-stack/pull/579): basket membership/recovery corrections, send-max authorization, optional monitor subscription recovery and additive mobile exports. Message Box Client 2.5.3 uses the patched SDK peer floor. The lockfile pins the independently verified npm artifacts.

## Portable runtime qualification follow-ups

Normalize Expo SQLite’s Android filesystem directory to an absolute file URI before checking for saved databases; retain iOS file URIs unchanged. Native Android qualification of the shared flow found this before restoration.

Published SDK 2.8.1 supplies the authenticated empty AES-GCM fix from [TS Stack #574](https://github.com/bsv-blockchain/ts-stack/pull/574). The temporary AES patch is removed; the existing native primitive acceleration patch is preserved against 2.8.2. The forced-portable CJS/ESM test covers 24 cross-runtime vectors and rejects altered tags, wrong keys/IVs and truncated envelopes.

BRC-100 app qualification also checks same-document navigation. Android may report a reader route through a loading-start callback without a later page-finished event. The browser retains that valid route immediately, keeps loading independent, and reconciles completion only from matching native progress. Cold WebView mounts resume the current route; passive route updates do not reload an already-mounted page. Regression coverage includes duplicate callbacks, invalid URLs, back/forward history, tab switching and restoration. Native qualification must repeat these checks after dependency changes.

## Android file destinations

Save/share offers **Save to folder** through the Android document-provider picker as well as the platform share sheet. This works when no installed sharing app offers a local-save destination. Saving creates a new provider file and copies in 256 KiB chunks, verifies its size and yields between writes; it never loads the complete archive into JavaScript memory. Interrupted/failed saves remove only the newly created partial output when possible and retain the app’s original. Provider selection stays outside the cancellable copy so the system picker’s background transition does not abort a fresh save. Nonempty destination files are refused without deletion.

## SDK 2.8.2 integration

The wallet now pins published SDK 2.8.2, retaining the authenticated AES-GCM fix from 2.8.1 and adding [TS Stack #581](https://github.com/bsv-blockchain/ts-stack/pull/581). Successful automatic React Native/XDM discovery no longer leaves subsequent wallet calls subject to the short probe deadline. Discovery remains bounded, explicit operation timeouts and response/origin validation are unchanged. Web applications must also update their own SDK bundle; upgrading a wallet alone cannot repair an older application bundle.

The funding app also pins 2.8.2; `docs/fund.html` is regenerated from that locked dependency graph. The acceleration patch changes only its SDK version context; the published AES and wallet-discovery fixes remain intact.

Signed-out iOS Apple Pay mode retains its script-injection prohibition. A narrow
`react-native-webview` patch observes [WebKit's KVO-compliant native URL](https://developer.apple.com/documentation/webkit/wkwebview/url)
to report completed same-document navigation when the normal injected history
shim is unavailable. It emits only for the current mounted WebView and matching
URL after native history state settles, and removes its observer on teardown.
Native reader back/forward and restart acceptance are required after rebuilding.
