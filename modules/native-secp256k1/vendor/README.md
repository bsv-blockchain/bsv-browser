# Vendor prebuilts (v4.5.0)

Downloaded by `scripts/fetch-prebuilts.mjs`. Do not commit large binaries.

- `include/ufsecp/` — C ABI headers
- `include/secp256k1/` (+ umbrella) — C++ headers for the mobile static library
- `ios/UltrafastSecp256k1.xcframework`
- `android/<abi>/lib/libfastsecp256k1.a`

Re-fetch: `node modules/native-secp256k1/scripts/fetch-prebuilts.mjs --force`
