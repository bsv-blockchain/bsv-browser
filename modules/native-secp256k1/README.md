# native-secp256k1

Local Expo module providing **synchronous** secp256k1 ECDSA for BSV Browser.

Uses [UltrafastSecp256k1](https://github.com/shrec/UltrafastSecp256k1) mobile prebuilts (v4.5.0) via a thin C++ bridge that matches ufsecp ECDSA semantics (RFC 6979, low-S compact R||S).

## JS API

```ts
import {
  isAvailable,
  ecdsaSign,
  ecdsaVerify,
  pubkeyCreate
} from 'native-secp256k1'

if (isAvailable()) {
  const sig = ecdsaSign(msg32, priv32) // Uint8Array(64)
  const ok = ecdsaVerify(msg32, sig, pub33)
  const pub = pubkeyCreate(priv32) // Uint8Array(33)
}
```

All methods are **synchronous** (required by `@bsv/sdk` `PrivateKey.sign`).

## Soft-fail

When the native module is not linked (Jest, web, Node, missing rebuild):

- `isAvailable()` → `false`
- methods throw if called without a guard

The app falls back to `@noble/secp256k1` via `utils/crypto/nativeSecpBackend.ts`.

## Layout

```
modules/native-secp256k1/
├── common/                 # Shared C++ bridge (committed)
│   ├── ufsecp_bridge.h
│   └── ufsecp_bridge.cpp
├── ios/                    # Expo Apple module + CocoaPods podspec
│   ├── NativeSecp256k1.podspec
│   ├── NativeSecp256k1Module.swift
│   ├── NativeSecp256k1Bridge.{h,mm}
│   └── (staged at pod install — gitignored)
│       ├── ufsecp_bridge.{h,cpp}          # copy of common/
│       └── UltrafastSecp256k1.xcframework # copy of vendor/ios/
├── android/                # Expo Android module + CMake/JNI
├── scripts/
│   └── fetch-prebuilts.mjs # Downloads vendor/ from GitHub Releases
├── vendor/                 # Prebuilts (gitignored; not in the repo)
│   ├── include/            # ufsecp + secp256k1 C++ headers
│   ├── ios/UltrafastSecp256k1.xcframework
│   └── android/<abi>/lib/libfastsecp256k1.a
└── src/index.ts            # JS surface
```

## From a clean clone: rebuild required binaries

Prebuilts are **not** checked into git. Anyone starting from the repo must download them and rebuild the native app before `isAvailable()` is true.

### 1. Install JS deps + fetch prebuilts

From the **repo root**:

```bash
npm install
# postinstall runs: node modules/native-secp256k1/scripts/fetch-prebuilts.mjs
```

Or fetch only the native binaries:

```bash
npm run fetch-native-secp
# force re-download:
npm run fetch-native-secp -- --force
# equivalent:
node modules/native-secp256k1/scripts/fetch-prebuilts.mjs --force
```

**Requires network** (GitHub Releases). Offline installs print a warning and continue; ECDSA uses noble until prebuilts exist and the app is rebuilt.

### 2. Verify vendor/

```bash
test -f modules/native-secp256k1/vendor/ios/UltrafastSecp256k1.xcframework/Info.plist
test -f modules/native-secp256k1/vendor/android/arm64-v8a/lib/libfastsecp256k1.a
test -f modules/native-secp256k1/vendor/include/ufsecp/ufsecp.h
```

### 3. Rebuild the native app

**EAS local (what production/dev-client scripts use):**

```bash
# from repo root, after vendor/ is present
npm run ios-dev-build       # or ios-build-for-app-store
npm run android-dev-build   # or android-build-for-play-store
```

**Expo CLI / Xcode / Gradle:**

```bash
# iOS
npx expo prebuild --platform ios --clean
cd ios && pod install && cd ..
# pod install stages common/ + vendor xcframework into modules/native-secp256k1/ios/
npx expo run:ios --device

# Android
npx expo prebuild --platform android --clean
npx expo run:android --device
```

### 4. Confirm native backend

In a **dev** client, boot logs should include:

```text
Fast ECDSA backend: native
```

If you see `noble`, the module is not linked or prebuilts were missing at build time — re-fetch and rebuild the binary (Metro alone is not enough).

## How iOS packaging works

This project sets `ios.useFrameworks: static` (static frameworks). Important constraints:

1. **No Swift bridging headers** on the pod. Xcode errors with  
   `Using bridging headers with framework targets is unsupported`.  
   ObjC (`NativeSecp256k1Bridge`) is a **public modular header**; Swift calls it as throwing methods for `NSError **` APIs.

2. **CocoaPods cannot compile `source_files` outside the pod directory** (`ios/`).  
   The podspec therefore **copies** at `pod install` time:
   - `../common/ufsecp_bridge.{h,cpp}` → `ios/`
   - `../vendor/ios/UltrafastSecp256k1.xcframework` → `ios/`
   - Strips `module.modulemap` from the staged xcframework (avoids  
     `redefinition of module 'UltrafastSecp256k1'` when linking as a static library  
     while compiling C++ against `vendor/include`)

3. Staged copies under `ios/` are **gitignored**. Always edit `common/` (and re-run `pod install`) for bridge changes; re-fetch vendor for binary upgrades.

4. **Verified build path:** after `npm run fetch-native-secp` + `pod install`, a Release  
   `iphoneos` archive of the app target should link `NativeSecp256k1` and `-lfastsecp256k1`.

5. **Simulator arch:** prebuilts are **arm64-only** (`ios-arm64` + `ios-arm64-simulator`).  
   The podspec sets `EXCLUDED_ARCHS[sdk=iphonesimulator*] = x86_64` on both the pod  
   and the app so EAS/Xcode generic-simulator builds do not fail with  
   `ld: library 'fastsecp256k1' not found` when linking x86_64.

## How Android packaging works

`android/src/main/cpp/CMakeLists.txt` points at:

- `${MODULE_ROOT}/common/ufsecp_bridge.cpp`
- `${MODULE_ROOT}/vendor/android/<abi>/lib/libfastsecp256k1.a`
- headers under `vendor/include` and the ABI include tree

No staging step — CMake reads `common/` and `vendor/` directly. Fetch prebuilts before any Gradle/EAS Android build.

## Prebuilt version

Configured in `scripts/fetch-prebuilts.mjs` (`VERSION = '4.5.0'`). Assets:

| Asset | Purpose |
| ----- | ------- |
| `UltrafastSecp256k1-v*-ios-xcframework.tar.gz` | iOS device + simulator static library xcframework |
| `UltrafastSecp256k1-v*-android-*.tar.gz` | `libfastsecp256k1.a` per ABI |
| `ufsecp-c-*.tar.gz` | C ABI headers (reference; bridge uses CT C++ API) |

Bump `VERSION` and re-run with `--force` when upgrading UltrafastSecp256k1.

## Soft-fail without rebuild

Dev clients built **before** this module (or without vendor at link time) keep using noble until rebuilt. JS and tests always resolve the package; Jest maps to a mock under `__tests__/__mocks__/native-secp256k1.js`.
