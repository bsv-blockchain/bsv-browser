# End-to-end tests

Maestro drives a release build of BSV Browser on an Android emulator and an iOS Simulator. The same YAML flows run locally and in GitHub Actions.

Detox was not used. This app is Expo SDK 57 with a dev client, React Native's new architecture, Nitro modules, and a WebView wallet bridge. Detox needs a grey-box test binary and fights that combination. Maestro talks to the installed app, which is the same shape on both platforms, and it can see native sheets that sit over the WebView.

## What an e2e build will and will not do

`EXPO_PUBLIC_E2E=1` is inlined into the JS bundle. Production builds leave it unset, and the hooks below do not run.

- The wallet profile is forced to **testnet** on every storage read and write.
- Every chain's Arcade URL is `http://127.0.0.1:8787/arc`. That server answers **403** and does not relay a transaction. A tap on Authorize still cannot broadcast.
- Encrypted backup is off (`backupUrl: null`).
- The UI is switched to English after launch so the flow text matches.
- The handwritten-backup confirm control appears after 400ms instead of 15s.
- A one-pixel status line exposes `testID`s such as `e2e-status-page-home` so flows do not depend on WebView accessibility text.
- `bsv-browser://e2e?url=` opens a page only when the URL is the loopback fixture. Any other origin is ignored. Production builds do not handle the link.

No mnemonic, private key, or API secret is committed. `e2e/scripts/print-mnemonic.js` prints a new 12-word BIP-39 phrase per run. Maestro types it into the restore flow. Do not reuse it. Failure logs can contain it; the build that typed it cannot broadcast.

Chaintracks stays on the public read-only default so a new wallet can sync headers. That is not a spend path.

## Layout

```
e2e/
  fixtures/           loopback site (browser pages, 402, arcade mock)
  maestro/flows/      one journey per file
  maestro/subflows/   launch, menu, navigation, wallet create
  maestro/attach/     http-intent check, run only after open-http.sh
  scripts/            build, install, Maestro
.github/workflows/e2e.yml
```

App id: `org.bsvassociation.browser`.

## Prerequisites

- Node 22 and npm, then `npm ci`
- [Maestro](https://maestro.mobile.dev): `curl -Ls "https://get.maestro.mobile.dev" | bash`
- Android: Android Studio, an emulator, and `adb` on `PATH`
- iOS: macOS, Xcode, and the two Rust xcframeworks (the script builds them if they are missing)

The suite uses a **release** binary with the JS bundle inside it. It does not use the Expo dev client or Metro. `RCT_USE_PREBUILT_RNCORE=0` is only for dev-client builds; leave it unset here.

## Run on Android

```bash
# emulator-only ABI. Drop this to build every ABI for a device.
export E2E_ANDROID_ARCH=x86_64
npm run e2e:android
```

That prebuilds `android/` (gitignored) with cleartext HTTP enabled, assembles a debug-signed release APK, reverse-forwards port 8787, installs, starts the fixture server, and runs Maestro.

A second pass then runs `e2e/scripts/open-http.sh`, which sends `http://127.0.0.1:8787/deeplink` to this package, and `e2e/maestro/attach`. Android will otherwise offer the system browser for `http` links.

Rebuild skip, when the APK is already installed:

```bash
E2E_SKIP_BUILD=1 npm run e2e:android
```

## Run on iOS

```bash
npm run e2e:ios
```

This compiles `SecpNative.xcframework` and `EngineNative.xcframework` if they are not already in the Nitro packages, then `npx expo run:ios --configuration Release`. Prebuild turns on `NSAllowsLocalNetworking` so the simulator can load the fixture. That edits the committed `ios/` tree. Do not commit that diff.

`E2E_SKIP_BUILD=1 npm run e2e:ios` only runs Maestro against the booted simulator.

## Run a subset

Start the fixture yourself, install an e2e build, then:

```bash
npm run e2e:server
# other terminal, app already installed, adb reverse tcp:8787 tcp:8787 on Android
npx maestro test e2e/maestro/flows/browse.yaml
npx maestro test --include-tags smoke e2e/maestro
```

`smoke` is onboarding, browse, and settings. Wallet flows are not in that tag because creating a wallet is the slow part.

The restore flow needs a phrase. `e2e/scripts/maestro.sh` generates one and passes `-e E2E_MNEMONIC`. Do not put a phrase in the shell history you plan to keep, and do not commit one.

## Flows

| Flow | What it checks |
| --- | --- |
| `onboarding` | First launch is the browser. The Web3 benefits sheet is not up. Menu opens Homepage and Search Engine. |
| `browse` | Address bar loads the fixture home page and an article, then Back. |
| `tabs` | New tab from the menu, tab overview, new tab, Done. |
| `bookmarks-history` | Bookmark the article, open the bookmark list, open history, clear history. |
| `settings` | Search engine changes to Brave. Wallet network screen shows Testnet. |
| `wallet-create` | Pay creates a wallet behind the biometric advisory, then the backup words can be confirmed. |
| `wallet-restore` | Import a generated phrase. Abandon the disabled backup replay if it is offered. |
| `unlock` | Kill and relaunch. The wallet is still there, with no OS biometric sheet. |
| `send-receive` | Get paid opens an address (or the generator error). Pay accepts a public testnet example address and does not send. |
| `camera-permission` | In-app camera sheet. Don't Allow. The OS camera dialog is not accepted. |
| `permission-brc100` | A page calls `getPublicKey` for a protocol. Reject. |
| `identity-certificate` | A page calls `acquireCertificate`. Reject. |
| `micropayment-402` | A 402 above the auto-approve threshold shows Spending Authorization. Reject. A direct `createAction` is rejected the same way. |
| `deeplink` | `bsv-browser://pair` (invalid, on purpose), `peerpay:` (invalid identity), and `bsv-browser://e2e?url=` into the fixture. iOS also opens the http URL. |

## Add a flow

1. Put a page in `e2e/fixtures/handler.js` if the journey needs one. Report progress with `e2e('some:status')` (see the script already injected into every page). The app paints `e2e-status-some-status`.
2. Add `e2e/maestro/flows/<name>.yaml`. Start from `../subflows/launch.yaml`.
3. Add the file name to `flowsOrder` in `e2e/maestro/config.yaml`.
4. Prefer `id` selectors (`testID`) for controls this repo owns. Use visible English text for toolbox screens we do not compile.
5. Do not tap Authorize, do not switch the network to Mainnet, and do not complete a send.

`__tests__/e2e` covers the testnet lock and the fixture. Run `npx jest __tests__/e2e`.

## Debug

Maestro writes screenshots and the hierarchy under `e2e/output/` (gitignored).

```bash
maestro hierarchy
maestro studio
```

`adb logcat` and Console.app show the JS logs. The fixture log is `e2e/output/fixture.log` when the run script started the server.

Animations are set to zero on Android by `run-android.sh`. If a sheet is mid-spring, wait on text instead of tapping immediately. The flows already use `extendedWaitUntil`.

Wallet creation runs BIP-39 on the JS thread and can sit on "Secure Your Wallet" for a while. The wait is 120 seconds.

If the address bar's first menu tap only expands the bar, `open-menu.yaml` taps again.

## CI

`.github/workflows/e2e.yml`

The fixture job runs on every pull request. It does not boot a device.

The Android and iOS jobs run only when a release is being gated:

- The pull request has the **`release`** label. Adding the label starts them. Later pushes to that PR run them again while the label stays on. This repo has no existing version or release label. `eas-build` is the label that asks EAS to build a binary, so this suite does not reuse it.
- A version tag `v*` is pushed. That is the backstop for a release that did not go through a labeled PR.
- Someone starts the workflow with `workflow_dispatch`.

Device jobs still wait for the fixture job. On failure they upload `e2e/output` (`maestro-android` / `maestro-ios`).

## Gaps

- No mainnet, no funded testnet wallet, and no successful broadcast. Spending and 402 flows stop on Reject. The mock would refuse a broadcast anyway.
- Nearby payments, YubiKey, QR scan, and the share sheet are not driven. They need hardware or system UI Maestro cannot finish reliably.
- Unlock assumes the simulator has **no** enrolled biometrics. If Face ID or a fingerprint is enrolled, the OS sheet appears and the unlock flow will fail. CI does not enroll any.
- Certificate and protocol prompts depend on the toolbox permission queue. If a call errors before the sheet, the flow fails on purpose rather than skipping the prompt.
- Header sync still reads public testnet chaintracks. A fully offline chain is not wired up.
- Android `http` deep links are delivered with `adb` to this package. The in-app handler is also covered by `bsv-browser://e2e?url=`, which only accepts the fixture origin.
- An e2e iOS prebuild dirties `ios/` (`NSAllowsLocalNetworking`). Leave that uncommitted.
