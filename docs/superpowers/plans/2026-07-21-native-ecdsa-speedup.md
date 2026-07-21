# Native ECDSA Speedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make wallet ECDSA (sign/verify) dramatically faster by injecting a high-performance secp256k1 backend into `@bsv/sdk`, mirroring how `react-native-quick-crypto` is injected for hashes/AES.

**Architecture:** Early boot installs a fast ECDSA stack in `index.js` (after quick-crypto). Metro rewrites `@bsv/sdk` `./ECDSA.js` imports to `utils/crypto/fastECDSA.ts`, which prefers a **sync native** UltrafastSecp256k1/ufsecp binding when present, then falls back to audited `@noble/secp256k1`. A local Expo module (`modules/native-secp256k1`) wraps prebuilt ufsecp libraries with **synchronous** methods so `PrivateKey.sign()` stays sync. Jest uses noble only (no native).

**Tech Stack:** Expo 55, React Native 0.83, `@bsv/sdk`, `@noble/secp256k1`, `@noble/hashes`, local Expo module + UltrafastSecp256k1 prebuilts (ufsecp C ABI v4), Metro resolver aliases.

## Global Constraints

- Mirror the quick-crypto pattern: early `install()` in `index.js` + Metro `resolveRequest` routing (do not monkey-patch frozen ESM exports).
- `sign`/`verify` must remain **synchronous** (BSV SDK `PrivateKey.sign` is sync).
- Preserve BSV ECDSA semantics: low-S when `forceLowS=true`, reject oversized message hashes, support `customK` by falling back to original pure-JS ECDSA.
- Fast path must produce signatures that verify with both BSV pure-JS verify and the accelerated verify.
- Native module must soft-fail: app runs with noble fallback when native is missing (web, Jest, incomplete native build).
- Do not break existing Jest suite; add focused unit tests for parity.
- Prefer small focused files under `utils/crypto/` and `modules/native-secp256k1/`.
- Do not commit large binary prebuilts if a download script can fetch them at postinstall; prebuilts may be gitignored and fetched by script.
- Branch: `feat/native-ecdsa-speedup` in worktree `.worktrees/native-ecdsa-speedup`.

---

### Task 1: Dependencies, crypto package layout, and install entrypoint

**Files:**
- Modify: `package.json` (add `@noble/secp256k1`, `@noble/hashes`; extend postinstall if needed)
- Create: `utils/crypto/types.ts`
- Create: `utils/crypto/installFastEcdsa.ts`
- Create: `utils/crypto/nativeSecpBackend.ts` (JS-facing backend probe; native optional)
- Create: `utils/crypto/nobleSecpBackend.ts`
- Test: `__tests__/fastEcdsa.install.test.ts`

**Interfaces:**
- Consumes: none
- Produces:
  - `export type SecpBackend = { name: 'native' | 'noble'; ecdsaSign(msg32: Uint8Array, priv32: Uint8Array): Uint8Array; ecdsaVerify(msg32: Uint8Array, sig64: Uint8Array, pub33: Uint8Array): boolean; pubkeyCreate(priv32: Uint8Array): Uint8Array }`
  - `export function getSecpBackend(): SecpBackend`
  - `export function installFastEcdsa(): { backend: string }`
  - `export function isFastEcdsaInstalled(): boolean`

- [ ] **Step 1: Write the failing install test**

```ts
// __tests__/fastEcdsa.install.test.ts
import { installFastEcdsa, isFastEcdsaInstalled, getSecpBackend } from '@/utils/crypto/installFastEcdsa'

describe('installFastEcdsa', () => {
  it('installs a backend and reports noble in Jest', () => {
    const result = installFastEcdsa()
    expect(isFastEcdsaInstalled()).toBe(true)
    expect(result.backend).toMatch(/noble|native/)
    const backend = getSecpBackend()
    expect(backend.ecdsaSign).toEqual(expect.any(Function))
    expect(backend.ecdsaVerify).toEqual(expect.any(Function))
    expect(backend.pubkeyCreate).toEqual(expect.any(Function))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- __tests__/fastEcdsa.install.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Add dependencies**

```bash
npm install @noble/secp256k1@^3.1.0 @noble/hashes@^1.8.0
```

- [ ] **Step 4: Implement types + noble backend + install**

`utils/crypto/types.ts`:
```ts
export type SecpBackendName = 'native' | 'noble'

export type SecpBackend = {
  name: SecpBackendName
  /** Compact 64-byte R||S, low-S normalized */
  ecdsaSign(msg32: Uint8Array, priv32: Uint8Array): Uint8Array
  ecdsaVerify(msg32: Uint8Array, sig64: Uint8Array, pub33: Uint8Array): boolean
  /** Compressed 33-byte pubkey */
  pubkeyCreate(priv32: Uint8Array): Uint8Array
}
```

`utils/crypto/nobleSecpBackend.ts`: wire `secp.hashes.sha256` / `hmacSha256` from `@noble/hashes`, implement the three methods with `{ prehash: false, lowS: true }` for sign.

`utils/crypto/nativeSecpBackend.ts`: try `require('native-secp256k1')` or `require('../../modules/native-secp256k1')` and if `isAvailable()` + sync methods exist, wrap them; else return `null`.

`utils/crypto/installFastEcdsa.ts`: prefer native, else noble; store on `globalThis.__BSV_SECP_BACKEND__`; idempotent.

- [ ] **Step 5: Run tests**

Run: `npm test -- __tests__/fastEcdsa.install.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json utils/crypto __tests__/fastEcdsa.install.test.ts
git commit -m "$(cat <<'EOF'
feat(crypto): add installable secp backend (noble + native probe)

Introduce an early-install ECDSA acceleration stack that prefers a sync
native ufsecp binding and falls back to audited @noble/secp256k1.
EOF
)"
```

---

### Task 2: fastECDSA drop-in matching @bsv/sdk ECDSA exports

**Files:**
- Create: `utils/crypto/fastECDSA.ts`
- Create: `utils/crypto/bnBytes.ts` (BigNumber ↔ 32-byte helpers)
- Test: `__tests__/fastEcdsa.parity.test.ts`

**Interfaces:**
- Consumes: `getSecpBackend()` from Task 1; `@bsv/sdk` `BigNumber`, `Signature`, `Point`
- Produces: `export const sign` and `export const verify` with **identical signatures** to `@bsv/sdk` `primitives/ECDSA`:
  - `sign(msg: BigNumber, key: BigNumber, forceLowS?: boolean, customK?: BigNumber | ((iter: number) => BigNumber)): Signature`
  - `verify(msg: BigNumber, sig: Signature, key: Point): boolean`

- [ ] **Step 1: Write failing parity tests**

```ts
// __tests__/fastEcdsa.parity.test.ts
import { PrivateKey, BigNumber, Signature } from '@bsv/sdk'
import { installFastEcdsa } from '@/utils/crypto/installFastEcdsa'
import { sign, verify } from '@/utils/crypto/fastECDSA'

// Also import ORIGINAL via special alias that metro/jest maps to real SDK ECDSA
// In Jest moduleNameMapper: '^@bsv/sdk-original-ecdsa$': '<rootDir>/node_modules/@bsv/sdk/dist/cjs/src/primitives/ECDSA.js'
import * as OriginalECDSA from '@bsv/sdk-original-ecdsa'

describe('fastECDSA parity', () => {
  beforeAll(() => {
    installFastEcdsa()
  })

  it('signs and verifies with low-S', () => {
    const key = new PrivateKey(1)
    const msg = new BigNumber(
      '4d7a2145a347e0aabf58a6a1260ae359436b27eaca5ac5cba6685a6f6e0fe39c',
      16
    )
    const sig = sign(msg, key, true)
    expect(sig).toBeInstanceOf(Signature)
    expect(verify(msg, sig, key.toPublicKey())).toBe(true)
    // Cross-check original verifier
    expect(OriginalECDSA.verify(msg, sig, key.toPublicKey())).toBe(true)
  })

  it('matches original for fixed customK path by delegating', () => {
    const key = new PrivateKey(2)
    const msg = new BigNumber(
      'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00',
      16
    )
    const k = new BigNumber(123456789)
    const a = sign(msg, key, true, k)
    const b = OriginalECDSA.sign(msg, key, true, k)
    expect(a.r.toString(16)).toBe(b.r.toString(16))
    expect(a.s.toString(16)).toBe(b.s.toString(16))
  })

  it('rejects oversized message hashes like the original', () => {
    const key = new PrivateKey(3)
    const huge = new BigNumber(1).ushln(300)
    expect(() => sign(huge, key, true)).toThrow(/too large/)
  })
})
```

- [ ] **Step 2: Run test — expect FAIL (fastECDSA missing)**

Run: `npm test -- __tests__/fastEcdsa.parity.test.ts`

- [ ] **Step 3: Implement `fastECDSA.ts`**

Logic:
1. If `customK` is provided → call original ECDSA (`@bsv/sdk-original-ecdsa`).
2. Else convert msg/key BigNumbers to 32-byte BE `Uint8Array` (left-pad).
3. Call `getSecpBackend().ecdsaSign`.
4. Split R||S into BigNumbers → `new Signature(r, s)`.
5. If `forceLowS === false` and backend forced low-S only: document that native/noble always low-S; when `forceLowS` is false and s was low, result is still valid; BSV default for PrivateKey.sign is `forceLowS=true`.
6. `verify`: convert Point to compressed pubkey (0x02/0x03 || x), call backend; on backend failure fall back to original verify.

Also add Jest mapper in `package.json`:
```json
"^@bsv/sdk-original-ecdsa$": "<rootDir>/node_modules/@bsv/sdk/dist/cjs/src/primitives/ECDSA.js"
```

- [ ] **Step 4: Run parity tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add utils/crypto __tests__/fastEcdsa.parity.test.ts package.json
git commit -m "$(cat <<'EOF'
feat(crypto): add fastECDSA drop-in with noble/native backends

Provide BSV-compatible sign/verify that routes through the installed
secp backend and delegates customK to the original pure-JS ECDSA.
EOF
)"
```

---

### Task 3: Metro + index.js injection (mirror quick-crypto)

**Files:**
- Modify: `metro.config.js`
- Modify: `index.js`
- Modify: `package.json` (jest mapper for ECDSA if needed)
- Modify: `README.md` (Architecture / crypto section)
- Test: `__tests__/metroEcdsaAlias.test.ts` (unit-test the resolve helper if extracted)

**Interfaces:**
- Consumes: `utils/crypto/fastECDSA.ts`, `installFastEcdsa`
- Produces: every `@bsv/sdk` relative `./ECDSA.js` resolve returns fastECDSA; original available as `@bsv/sdk-original-ecdsa`

- [ ] **Step 1: Extract resolve helper for testability**

Create `metro-shims/ecdsaResolve.js`:
```js
const path = require('path')

function shouldAliasBsvEcdsa(moduleName, originModulePath) {
  if (!originModulePath || !originModulePath.includes(`${path.sep}@bsv${path.sep}sdk`)) {
    return false
  }
  return (
    moduleName === './ECDSA.js' ||
    moduleName === './ECDSA' ||
    moduleName === '../primitives/ECDSA.js' ||
    moduleName === '../primitives/ECDSA' ||
    /[/\\]primitives[/\\]ECDSA(\.js)?$/.test(moduleName)
  )
}

module.exports = { shouldAliasBsvEcdsa }
```

Test:
```ts
import { shouldAliasBsvEcdsa } from '../metro-shims/ecdsaResolve'

it('aliases relative ECDSA from sdk private key', () => {
  expect(
    shouldAliasBsvEcdsa(
      './ECDSA.js',
      '/app/node_modules/@bsv/sdk/dist/esm/src/primitives/PrivateKey.js'
    )
  ).toBe(true)
})

it('does not alias unrelated modules', () => {
  expect(shouldAliasBsvEcdsa('./ECDSA.js', '/app/utils/foo.js')).toBe(false)
})
```

- [ ] **Step 2: Wire `metro.config.js`**

```js
const { shouldAliasBsvEcdsa } = require('./metro-shims/ecdsaResolve')
const fastEcdsa = path.resolve(__dirname, 'utils/crypto/fastECDSA.ts')
const originalEcdsa = path.resolve(
  __dirname,
  'node_modules/@bsv/sdk/dist/esm/src/primitives/ECDSA.js'
)

// inside resolveRequest:
if (moduleName === '@bsv/sdk-original-ecdsa') {
  return { type: 'sourceFile', filePath: originalEcdsa }
}
if (shouldAliasBsvEcdsa(moduleName, context.originModulePath)) {
  return { type: 'sourceFile', filePath: fastEcdsa }
}
```

Keep existing quick-crypto routing intact.

- [ ] **Step 3: Update `index.js`**

Immediately after `install()` for quick-crypto and crypto propagation:

```js
import { installFastEcdsa } from './utils/crypto/installFastEcdsa'
try {
  const { backend } = installFastEcdsa()
  if (__DEV__) {
    console.log(`[Crypto Setup] Fast ECDSA backend: ${backend}`)
  }
} catch (e) {
  console.warn('[Crypto Setup] Fast ECDSA install failed; using pure-JS SDK ECDSA', e)
}
```

- [ ] **Step 4: Document in README** next to the quick-crypto boot description.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add metro.config.js metro-shims/ecdsaResolve.js index.js README.md package.json __tests__
git commit -m "$(cat <<'EOF'
feat(crypto): inject fast ECDSA via Metro like quick-crypto

Route @bsv/sdk ECDSA imports through utils/crypto/fastECDSA and install
the backend at app boot immediately after react-native-quick-crypto.
EOF
)"
```

---

### Task 4: Local Expo module `native-secp256k1` (sync ufsecp)

**Files:**
- Create: `modules/native-secp256k1/` (local Expo module)
  - `package.json` (name: `native-secp256k1`, main: `src/index.ts`)
  - `expo-module.config.json`
  - `src/index.ts` (TS API: `isAvailable`, `ecdsaSign`, `ecdsaVerify`, `pubkeyCreate`)
  - `ios/NativeSecp256k1.podspec`, `ios/NativeSecp256k1Module.swift` (or ObjC++), link UltrafastSecp256k1 xcframework / ufsecp
  - `android/build.gradle`, `android/src/main/java/.../NativeSecp256k1Module.kt` + JNI or prefab static lib
  - `scripts/fetch-prebuilts.mjs` — downloads v4.5.0 iOS xcframework + Android arm64/armv7/x64 prebuilts into `modules/native-secp256k1/vendor/`
- Modify: root `package.json` — `"native-secp256k1": "file:modules/native-secp256k1"`, postinstall runs fetch when vendor missing
- Modify: `.gitignore` — ignore `modules/native-secp256k1/vendor/**` binaries if large
- Wire: `utils/crypto/nativeSecpBackend.ts` to use `native-secp256k1` when available

**Interfaces:**
- Consumes: ufsecp C ABI (`ufsecp_ctx_create`, `ufsecp_ecdsa_sign`, `ufsecp_ecdsa_verify`, `ufsecp_pubkey_create`)
- Produces: sync JS API:

```ts
export function isAvailable(): boolean
export function ecdsaSign(msg32: Uint8Array, priv32: Uint8Array): Uint8Array // 64 bytes
export function ecdsaVerify(msg32: Uint8Array, sig64: Uint8Array, pub33: Uint8Array): boolean
export function pubkeyCreate(priv32: Uint8Array): Uint8Array // 33 bytes
```

- [ ] **Step 1: Scaffold local Expo module**

```bash
npx create-expo-module@latest modules/native-secp256k1 --local --no-example --name NativeSecp256k1 --description "Sync secp256k1 ECDSA via UltrafastSecp256k1/ufsecp"
```

If interactive flags fail, hand-write the minimal Expo module structure matching Expo 55 local modules.

- [ ] **Step 2: Implement fetch-prebuilts script**

Download from GitHub releases `v4.5.0`:
- `UltrafastSecp256k1-v4.5.0-ios-xcframework.tar.gz`
- `UltrafastSecp256k1-v4.5.0-android-arm64.tar.gz`
- `UltrafastSecp256k1-v4.5.0-android-armv7.tar.gz`
- `UltrafastSecp256k1-v4.5.0-android-x64.tar.gz`
- `ufsecp-c-4.5.0.tar.gz` (headers)

Place headers under `vendor/include/ufsecp/` and libs under `vendor/ios`, `vendor/android/<abi>/`.

- [ ] **Step 3: Implement native sync bindings**

iOS: Expo Module functions that call C ABI (bridging header import `ufsecp.h`), return base64 or ArrayBuffer of results. Prefer returning `Uint8Array` via Expo typed arrays.

Android: Kotlin Expo Module + JNI wrapper around `libfastsecp256k1` / `libufsecp` with the same methods.

**Critical:** methods must be synchronous (no Promise) so BSV `PrivateKey.sign` can call them.

- [ ] **Step 4: JS package exports + native backend probe**

`modules/native-secp256k1/src/index.ts` exports the API and catches missing native module (returns `isAvailable() === false`).

Update `nativeSecpBackend.ts` to wrap this package.

- [ ] **Step 5: Jest mock**

Add `package.json` moduleNameMapper:
```json
"^native-secp256k1$": "<rootDir>/__tests__/__mocks__/native-secp256k1.js"
```
Mock: `isAvailable: () => false`.

- [ ] **Step 6: Unit-test backend selection still uses noble under Jest**

- [ ] **Step 7: Commit**

```bash
git add modules/native-secp256k1 package.json package-lock.json utils/crypto __tests__ .gitignore
git commit -m "$(cat <<'EOF'
feat(native): add sync native-secp256k1 Expo module over ufsecp

Vendor UltrafastSecp256k1 prebuilts via fetch script and expose
synchronous ECDSA sign/verify/pubkey for the Metro-injected ECDSA path.
EOF
)"
```

---

### Task 5: Public-key fast path + README/PR polish

**Files:**
- Create: `utils/crypto/fastPublicKey.ts` (optional helper)
- Modify: `utils/crypto/installFastEcdsa.ts` to optionally patch nothing if PrivateKey cannot be patched; instead document that ECDSA sign/verify is the hot path
- Optionally metro-alias is **not** required for PublicKey if gains are small; skip unless easy
- Modify: `README.md` crypto section fully
- Modify: `GROK_REVIEW.md` note item 10 partially addressed (optional short note)
- Test: ensure full suite green

- [ ] **Step 1: Add a small micro-benchmark script**

`scripts/perf/ecdsa-bench.mjs` (Node-only noble path):
- Compare original BSV ECDSA vs fastECDSA for N=100 signs
- Print ms/op

- [ ] **Step 2: README updates**

Document:
1. quick-crypto for SHA/AES/HMAC
2. fast ECDSA injection for secp256k1
3. native module + noble fallback
4. need for `npx expo prebuild` / native rebuild after adding the module

- [ ] **Step 3: Full tests**

Run: `npm test`

- [ ] **Step 4: Commit**

```bash
git add scripts/perf/ecdsa-bench.mjs README.md
git commit -m "$(cat <<'EOF'
docs(crypto): document ECDSA acceleration stack and add bench script
EOF
)"
```

---

### Task 6: Push branch and open PR

**Files:** none (git/gh only)

- [ ] **Step 1: Ensure clean status and tests pass**

```bash
npm test
git status
git log --oneline master..HEAD
```

- [ ] **Step 2: Push and create PR**

```bash
git push -u origin HEAD
gh pr create --title "feat: native/fast ECDSA for wallet secp256k1" --body "$(cat <<'EOF'
## Summary
- Inject a high-performance ECDSA path into `@bsv/sdk` the same way `react-native-quick-crypto` is injected for hashes/AES.
- Metro rewrites `@bsv/sdk` `ECDSA` imports to `utils/crypto/fastECDSA`.
- Early `installFastEcdsa()` in `index.js` selects **sync native ufsecp** when the local Expo module is linked, otherwise audited **@noble/secp256k1**.
- Local `modules/native-secp256k1` wraps UltrafastSecp256k1 prebuilts with synchronous sign/verify/pubkey.
- `customK` signing still uses original pure-JS ECDSA for correctness.

## Test plan
- [x] `npm test` (Jest; noble backend)
- [ ] Dev client rebuild (`npx expo prebuild` / EAS) and confirm log: `Fast ECDSA backend: native`
- [ ] Sign a micropayment / createAction path and verify on-chain acceptance
- [ ] Optional: run `node scripts/perf/ecdsa-bench.mjs` for Node noble vs pure-JS comparison

EOF
)"
```

---

## Self-review notes

- Spec coverage: quick-crypto mirror, native ufsecp, noble fallback, metro injection, sync API, tests, PR — all tasked.
- customK + oversized hash edge cases covered in parity tests.
- Native soft-fail for Jest/web is mandatory so CI stays green without prebuilts.
