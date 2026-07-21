# Vendor prebuilts (v4.5.0)

**Not committed.** Downloaded by `scripts/fetch-prebuilts.mjs` (also via root `npm install` postinstall and `npm run fetch-native-secp`).

## From a clean clone

```bash
# repo root
npm install
# or only binaries:
npm run fetch-native-secp
# re-download:
npm run fetch-native-secp -- --force
```

Then rebuild the native app (EAS or `npx expo run:ios` / `run:android`) so the module links against these files. See the module [README](../README.md).

## Layout after fetch

- `include/ufsecp/` — C ABI headers
- `include/secp256k1/` (+ umbrella) — C++ headers for the mobile static library
- `ios/UltrafastSecp256k1.xcframework` — device + simulator slices (`libfastsecp256k1.a`)
- `android/<abi>/lib/libfastsecp256k1.a` — `arm64-v8a`, `armeabi-v7a`, `x86_64`
- `.stamp` — version marker used to skip re-download when complete

## iOS note

`pod install` copies `ios/UltrafastSecp256k1.xcframework` into `modules/native-secp256k1/ios/` because CocoaPods only vendors paths inside the pod directory. That copy is gitignored; `vendor/` remains the source of truth after fetch.
