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

## Prebuilts

```bash
node modules/native-secp256k1/scripts/fetch-prebuilts.mjs
# or --force to re-download
```

`vendor/` is gitignored. Postinstall fetches when vendor is missing.

## Rebuild native app

After adding this package:

```bash
npx expo prebuild
# iOS
cd ios && pod install && cd ..
npx expo run:ios
# Android
npx expo run:android
```

Dev clients built before this module will keep using the noble JS backend until rebuilt.
