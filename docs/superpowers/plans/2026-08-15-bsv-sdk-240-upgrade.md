# @bsv/sdk 2.4.0 Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move bsv-browser from `@bsv/sdk` 2.1.9 to 2.4.0, rebasing the 2168-line native-secp256k1 patch onto the new version with byte-exactness proven, so the wallet's signing behaviour is unchanged.

**Architecture:** This is a dependency bump underneath a live wallet, so it is its own branch and its own verification pass. The risk is not the SDK API — the APIs this app uses are unchanged — it is the local patch, which reroutes ECDSA signing through a Nitro native module with a `@noble/secp256k1` fallback. The patch is regenerated against 2.4.0 with `patch-package`, then gated on the existing byte-parity test suite before anything else is allowed to depend on it.

**Tech Stack:** TypeScript, React Native / Expo, `patch-package`, Jest, `@bsv/sdk` 2.4.0, `@noble/secp256k1`, `react-native-nitro-modules`.

## Global Constraints

- Target `@bsv/sdk` **2.4.0** exactly. There is no 2.1.9 compatibility path anywhere.
- The patch must preserve **byte-exact** ECDSA output: RFC 6979 deterministic k, low-S DER. Any divergence changes signed transactions and is a hard fail.
- `patches/@bsv+sdk+2.1.9.patch` must be **deleted**, not left alongside the new file. `patch-package` applies by exact version-matched filename, so a stale file is silently ignored and creates the illusion of coverage.
- All 63 test files must pass. `__tests__/nobleBackend.test.ts` is the byte-parity gate and is non-negotiable.
- Do **not** fold any backup-feature work into this branch.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `package.json` | Pins `@bsv/sdk` version | Modify |
| `package-lock.json` | Lockfile | Regenerate |
| `patches/@bsv+sdk+2.1.9.patch` | Old native-secp patch | **Delete** |
| `patches/@bsv+sdk+2.4.0.patch` | Rebased native-secp patch | Create (generated) |
| `__tests__/nobleBackend.test.ts` | Byte-parity gate for the noble backend | Verify unchanged, extend |
| `__tests__/sdkAuthFetchBinaryBody.test.ts` | Locks in the 2.4.0 binary-body fix | Create |

The patch covers 8 SDK source files in both `dist/cjs` and `dist/esm`: `ECDSA.js`,
`NativeSecp.js` (added wholesale by the patch), `PrivateKey.js`, `PublicKey.js`,
`Schnorr.js`, `Signature.js`, `script/templates/P2PKH.js`, `transaction/Transaction.js`.

---

### Task 1: Branch and capture the 2.1.9 baseline

**Files:**
- Create: `/tmp/sdk-upgrade-baseline.json` (scratch, not committed)

**Interfaces:**
- Consumes: nothing
- Produces: a baseline signature vector file used by Task 4 to prove byte-exactness across the version change.

The whole upgrade rests on "signing behaviour did not change". That claim needs a
before-image captured while 2.1.9 is still installed.

- [ ] **Step 1: Create the branch**

```bash
git checkout -b chore/bsv-sdk-2.4.0
```

- [ ] **Step 2: Confirm the starting state**

```bash
node -p "require('./node_modules/@bsv/sdk/package.json').version"
```

Expected: `2.1.9`

- [ ] **Step 3: Capture baseline signatures from the patched 2.1.9**

Write and run this scratch script. It signs the 27 project vectors with fixed keys
through the routed (patched) SDK calls and records the DER hex.

```bash
cat > /tmp/capture-baseline.js <<'EOF'
const { BigNumber, ECDSA, PrivateKey } = require('@bsv/sdk')
const vectors = require('./native-secp-poc/fixtures/vectors.json')
const out = []
for (let i = 0; i < 27; i++) {
  const key = new PrivateKey(new BigNumber(i + 1).toArray('be', 32))
  const msg = new BigNumber(require('crypto').createHash('sha256').update('v' + i).digest().toJSON().data)
  const sig = ECDSA.sign(msg, key, true)
  out.push({ i, pub: key.toPublicKey().toString(), der: Buffer.from(sig.toDER()).toString('hex') })
}
console.log(JSON.stringify({ sdk: require('@bsv/sdk/package.json').version, vectorCount: vectors.length, out }, null, 2))
EOF
node /tmp/capture-baseline.js > /tmp/sdk-upgrade-baseline.json
head -12 /tmp/sdk-upgrade-baseline.json
```

Expected: JSON with `"sdk": "2.1.9"` and 27 entries each having a `der` hex string.

- [ ] **Step 4: Run the full suite to confirm a green starting point**

```bash
npm test
```

Expected: all suites pass. If anything fails **before** the upgrade, stop and fix or
document that separately — do not carry a pre-existing failure into this branch, or the
upgrade will be blamed for it.

- [ ] **Step 5: Commit the branch point**

```bash
git commit --allow-empty -m "chore(sdk): branch point for @bsv/sdk 2.4.0 upgrade"
```

---

### Task 2: Bump the dependency and remove the stale patch

**Files:**
- Modify: `package.json` (the `@bsv/sdk` entry under `dependencies`)
- Modify: `package-lock.json` (regenerated)
- Delete: `patches/@bsv+sdk+2.1.9.patch`

**Interfaces:**
- Consumes: the branch from Task 1
- Produces: an installed, **unpatched** `@bsv/sdk` 2.4.0 in `node_modules`, ready for Task 3 to re-apply the native-secp changes by hand.

- [ ] **Step 1: Pin 2.4.0 in package.json**

Change the dependency line from `"@bsv/sdk": "^2.1.9"` to:

```json
    "@bsv/sdk": "2.4.0",
```

Pin exactly, not with a caret. A wallet should not float its cryptography dependency.

- [ ] **Step 2: Delete the stale patch**

```bash
git rm patches/@bsv+sdk+2.1.9.patch
```

`patch-package` matches patches to packages by the version in the filename. Leaving the
2.1.9 file in place would mean it is silently never applied — the most dangerous possible
outcome, because the app would run on unpatched pure-JS crypto while the repo still looks
patched.

- [ ] **Step 3: Reinstall**

```bash
rm -rf node_modules/@bsv/sdk && npm install
```

Expected: `patch-package` reports applying `@bsv/wallet-toolbox-mobile@2.4.3` only, with
no mention of `@bsv/sdk`.

- [ ] **Step 4: Verify the new version is installed and unpatched**

```bash
node -p "require('./node_modules/@bsv/sdk/package.json').version"
ls node_modules/@bsv/sdk/dist/cjs/src/primitives/NativeSecp.js 2>&1
```

Expected: `2.4.0`, then `No such file or directory` — confirming the patch is genuinely
absent and Task 3 has real work to do.

- [ ] **Step 5: Confirm the binary-body fix is present in 2.4.0**

```bash
sed -n '/normalizeBodyToNumberArray(body)/,/^    }/p' \
  node_modules/@bsv/sdk/dist/cjs/src/auth/clients/AuthFetch.js | head -20
```

Expected: the first branch after the null check is `Array.isArray(body)`, **not**
`typeof body === 'object'`. This is the fix the backup client depends on.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json patches/
git commit -m "chore(sdk): bump @bsv/sdk to 2.4.0 and drop the 2.1.9 patch"
```

---

### Task 3: Rebase the native-secp patch onto 2.4.0

**Files:**
- Modify: `node_modules/@bsv/sdk/dist/{cjs,esm}/src/primitives/ECDSA.js`
- Create: `node_modules/@bsv/sdk/dist/{cjs,esm}/src/primitives/NativeSecp.js`
- Modify: `node_modules/@bsv/sdk/dist/{cjs,esm}/src/primitives/{PrivateKey,PublicKey,Schnorr,Signature}.js`
- Modify: `node_modules/@bsv/sdk/dist/{cjs,esm}/src/script/templates/P2PKH.js`
- Modify: `node_modules/@bsv/sdk/dist/{cjs,esm}/src/transaction/Transaction.js`
- Create: `patches/@bsv+sdk+2.4.0.patch` (generated)

**Interfaces:**
- Consumes: unpatched 2.4.0 from Task 2; the old patch body from git history at
  `HEAD~1:patches/@bsv+sdk+2.1.9.patch`
- Produces: `patches/@bsv+sdk+2.4.0.patch`, and a `secpBackend()` / `nativeSecp()` /
  `bnToBuf32()` / `numsToBuf()` / `warnCustomKOnce()` / `warnForceLowSOnce()` seam in
  `NativeSecp.js` with the same exported names as before, so `__tests__/nobleBackend.test.ts`
  keeps working unmodified.

`NativeSecp.js` is added wholesale by the patch and has no upstream counterpart, so it
copies across verbatim. The other seven files are hunks against upstream code that may
have moved.

- [ ] **Step 1: Recover the old patch for reference**

```bash
git show HEAD~1:patches/@bsv+sdk+2.1.9.patch > /tmp/old-sdk.patch
grep -c '^diff --git' /tmp/old-sdk.patch
```

Expected: `16` (8 files × cjs + esm).

- [ ] **Step 2: Copy NativeSecp.js across unchanged**

This file is entirely ours; extract it from the old patch rather than retyping.

```bash
node -e "
const fs=require('fs');
const p=fs.readFileSync('/tmp/old-sdk.patch','utf8').split(/^diff --git /m);
for (const h of p) {
  const m=h.match(/^a\/node_modules\/(\S+NativeSecp\.js)/);
  if(!m) continue;
  const body=h.split('\n').filter(l=>l.startsWith('+')&&!l.startsWith('+++')).map(l=>l.slice(1)).join('\n');
  fs.writeFileSync('node_modules/'+m[1], body+'\n');
  console.log('wrote', m[1]);
}"
```

Expected: two lines, one for `dist/cjs/...` and one for `dist/esm/...`.

- [ ] **Step 3: Try the old patch and collect the rejects**

```bash
git apply --directory=. --reject /tmp/old-sdk.patch 2>&1 | tail -30
find node_modules/@bsv/sdk -name '*.rej' | sed 's|.*sdk/||'
```

Expected: some hunks apply, some produce `.rej` files. Any file with no `.rej` is already
done. The `.rej` list is the exact work remaining.

- [ ] **Step 4: Apply each rejected hunk by hand**

For every `.rej` file, open the corresponding 2.4.0 source and re-apply the change at the
new location. The transformation in each case is the same shape: import the seam, then
insert the native/noble route ahead of the pure-JS body, falling through on any error.

The canonical example, in `dist/cjs/src/primitives/ECDSA.js` — after the existing
message-length guard inside `sign`, before the pure-JS work:

```js
const NativeSecp_js_1 = require("./NativeSecp.js");
// ... inside sign(msg, key, forceLowS = false, customK):
{
    const n = (0, NativeSecp_js_1.secpBackend)();
    if (n != null) {
        if (customK != null) {
            (0, NativeSecp_js_1.warnCustomKOnce)();
        }
        else if (!forceLowS) {
            (0, NativeSecp_js_1.warnForceLowSOnce)();
        }
        else {
            try {
                const der = n.ecdsaSign((0, NativeSecp_js_1.bnToBuf32)(msg), (0, NativeSecp_js_1.bnToBuf32)(key));
                return Signature_js_1.default.fromDER(Array.from(der));
            }
            catch (e) { /* fall through to pure JS */ }
        }
    }
}
```

The `esm` variant is identical except `require(...)` becomes a top-level
`import { secpBackend, ... } from './NativeSecp.js'` and `Signature_js_1.default` becomes
`Signature`. Mirror every change into both `dist/cjs` and `dist/esm` — they are separate
files and the app can load either.

Rules while doing this:
- Never change the pure-JS fallback body. It is the reference implementation and the
  thing byte-exactness is measured against.
- Every native call is wrapped in `try/catch` that falls through to pure JS.
- `customK` and `forceLowS=false` always take the pure-JS path.

- [ ] **Step 5: Remove the reject files**

```bash
find node_modules/@bsv/sdk -name '*.rej' -delete
find node_modules/@bsv/sdk -name '*.orig' -delete
```

- [ ] **Step 6: Verify every expected file is modified**

```bash
for f in primitives/ECDSA primitives/NativeSecp primitives/PrivateKey primitives/PublicKey \
         primitives/Schnorr primitives/Signature script/templates/P2PKH transaction/Transaction; do
  for d in cjs esm; do
    p="node_modules/@bsv/sdk/dist/$d/src/$f.js"
    grep -q "NativeSecp" "$p" && echo "OK   $d/$f" || echo "MISS $d/$f"
  done
done
```

Expected: 16 lines, all `OK`. Any `MISS` means a hunk was dropped — go back to Step 4.

- [ ] **Step 7: Generate the new patch**

```bash
npx patch-package @bsv/sdk
ls -l patches/
grep -c '^diff --git' patches/@bsv+sdk+2.4.0.patch
```

Expected: `patches/@bsv+sdk+2.4.0.patch` exists and reports `16`.

- [ ] **Step 8: Prove the patch reapplies from clean**

This is the step that catches a patch generated against accidental local edits.

```bash
rm -rf node_modules/@bsv/sdk && npm install 2>&1 | grep -i "bsv/sdk"
grep -c "NativeSecp" node_modules/@bsv/sdk/dist/cjs/src/primitives/ECDSA.js
```

Expected: patch-package reports applying `@bsv/sdk@2.4.0`, and the grep returns a non-zero
count.

- [ ] **Step 9: Commit**

```bash
git add patches/@bsv+sdk+2.4.0.patch
git commit -m "chore(sdk): rebase native-secp256k1 patch onto @bsv/sdk 2.4.0"
```

---

### Task 4: Prove byte-exactness against the 2.1.9 baseline

**Files:**
- Test: `__tests__/nobleBackend.test.ts` (existing gate, run unmodified)
- Create: `/tmp/verify-upgrade.js` (scratch)

**Interfaces:**
- Consumes: `/tmp/sdk-upgrade-baseline.json` from Task 1; the rebased patch from Task 3
- Produces: proof that signing output is unchanged across the version bump. Nothing may
  depend on 2.4.0 until this passes.

- [ ] **Step 1: Re-run the identical capture against 2.4.0**

```bash
node /tmp/capture-baseline.js > /tmp/sdk-upgrade-after.json
node -p "require('/tmp/sdk-upgrade-after.json').sdk"
```

Expected: `2.4.0`

- [ ] **Step 2: Diff the signature vectors**

```bash
node -e "
const a=require('/tmp/sdk-upgrade-baseline.json').out;
const b=require('/tmp/sdk-upgrade-after.json').out;
let bad=0;
for (let i=0;i<a.length;i++){
  if(a[i].der!==b[i].der){bad++;console.log('DER MISMATCH at',i);}
  if(a[i].pub!==b[i].pub){bad++;console.log('PUBKEY MISMATCH at',i);}
}
console.log(bad===0?'BYTE-EXACT: '+a.length+' vectors match':'FAILED: '+bad+' mismatches');
process.exit(bad===0?0:1);
"
```

Expected: `BYTE-EXACT: 27 vectors match`, exit 0.

A mismatch here is a hard stop. It means the rebased patch changed signing behaviour, and
shipping it would produce transactions that differ from what the wallet produced before.

- [ ] **Step 3: Run the byte-parity gate**

```bash
npx jest __tests__/nobleBackend.test.ts -v
```

Expected: PASS. This suite forces the native probe to fail and asserts that noble's
RFC 6979 low-S DER and public keys are byte-identical to the SDK's pure-JS path.

- [ ] **Step 4: Run the full suite**

```bash
npm test 2>&1 | tail -20
```

Expected: same pass count as the Task 1 baseline, zero failures.

- [ ] **Step 5: Typecheck and lint**

```bash
npx tsc --noEmit && npm run lint
```

Expected: both clean. `tsc` is what surfaces any genuine API drift between 2.1.9 and
2.4.0 in app code.

- [ ] **Step 6: Commit**

```bash
git commit --allow-empty -m "test(sdk): byte-exactness verified across 2.1.9 to 2.4.0 upgrade

27/27 signature vectors and public keys byte-identical.
nobleBackend byte-parity gate green. Full suite green."
```

---

### Task 5: Lock in the binary-body fix with a regression test

**Files:**
- Create: `__tests__/sdkAuthFetchBinaryBody.test.ts`

**Interfaces:**
- Consumes: `@bsv/sdk` 2.4.0
- Produces: a guard that fails loudly if a future SDK bump reintroduces the
  `typeof body === 'object'` ordering bug. The backup client's raw-binary upload depends
  entirely on this behaviour.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Guards the @bsv/sdk 2.4.0 fix to AuthFetch.normalizeBodyToNumberArray.
 *
 * On 2.1.9 the method tested `typeof body === 'object'` FIRST and returned
 * Utils.toArray(JSON.stringify(body)). Arrays, Uint8Array, ArrayBuffer and Blob are all
 * typeof 'object', so every binary branch below it was dead code and a Uint8Array body
 * was serialised as {"0":12,"1":255,...}.
 *
 * The encrypted wallet backup log POSTs raw ciphertext as an octet-stream body. If this
 * regresses, every backup blob is silently corrupted on upload, so this is a hard gate.
 */
import { AuthFetch, CompletedProtoWallet, PrivateKey } from '@bsv/sdk'

// normalizeBodyToNumberArray is private; reach it deliberately rather than reimplement.
function normalize (body: unknown): Promise<number[]> {
  const client = new AuthFetch(new CompletedProtoWallet(PrivateKey.fromRandom()))
  return (client as unknown as {
    normalizeBodyToNumberArray: (b: unknown) => Promise<number[]>
  }).normalizeBodyToNumberArray(body)
}

describe('AuthFetch binary body handling (SDK 2.4.0)', () => {
  it('passes a Uint8Array through as raw bytes', async () => {
    const bytes = new Uint8Array([0, 12, 127, 128, 255])
    expect(await normalize(bytes)).toEqual([0, 12, 127, 128, 255])
  })

  it('does not JSON-stringify a Uint8Array', async () => {
    const result = await normalize(new Uint8Array([255, 254]))
    const asText = Buffer.from(result).toString('utf8')
    expect(asText).not.toContain('{"0"')
  })

  it('honours byteOffset and byteLength on a subarray view', async () => {
    // 2.1.9 did new Uint8Array(body.buffer), ignoring both — returning the whole
    // backing buffer instead of the view, silently corrupting chunked payloads.
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    expect(await normalize(backing.subarray(2, 5))).toEqual([3, 4, 5])
  })

  it('passes a number[] through unchanged', async () => {
    expect(await normalize([1, 2, 3])).toEqual([1, 2, 3])
  })

  it('still encodes a plain object as JSON', async () => {
    const result = await normalize({ hello: 'world' })
    expect(Buffer.from(result).toString('utf8')).toBe('{"hello":"world"}')
  })
})
```

- [ ] **Step 2: Run it**

```bash
npx jest __tests__/sdkAuthFetchBinaryBody.test.ts -v
```

Expected: PASS on 2.4.0. (These same tests fail on 2.1.9 — that asymmetry is the point.
If they pass before the bump, the test is not actually reaching the method and needs
fixing.)

- [ ] **Step 3: Commit**

```bash
git add __tests__/sdkAuthFetchBinaryBody.test.ts
git commit -m "test(sdk): guard AuthFetch binary-body handling on 2.4.0"
```

---

### Task 6: Check whether the wallet-toolbox patch can shed its batch-derivation code

**Files:**
- Read: `patches/@bsv+wallet-toolbox-mobile+2.4.3.patch`
- Read: `node_modules/@bsv/sdk/dist/types/src/wallet/KeyDeriver.d.ts`

**Interfaces:**
- Consumes: `@bsv/sdk` 2.4.0
- Produces: either a reduced toolbox patch, or a recorded decision to keep it as is.

2.4.0's `KeyDeriver` gains an optional `derivePrivateKeys?(derivations: readonly
PrivateKeyDerivation[]): PrivateKey[]` — upstream's version of what the local toolbox
patch implements by hand via `batchBrc42DeriveChild`. If upstream's hook is sufficient,
part of a 220-line patch can be retired rather than maintained.

- [ ] **Step 1: Read upstream's batch hook**

```bash
sed -n '25,60p' node_modules/@bsv/sdk/dist/types/src/wallet/KeyDeriver.d.ts
grep -rn "PrivateKeyDerivation" node_modules/@bsv/sdk/dist/types/src/wallet/*.d.ts
```

- [ ] **Step 2: Read what the local patch does**

```bash
grep -n "batchBrc42DeriveChild" -B5 -A25 patches/@bsv+wallet-toolbox-mobile+2.4.3.patch | head -60
```

- [ ] **Step 3: Decide and record**

Answer in a commit message: does upstream's `derivePrivateKeys` cover the same batching,
and does it cross to native off the JS thread the way `batchBrc42DeriveChild` does? The
local patch exists specifically to make **one async native crossing per counterparty**. If
upstream's hook is synchronous and JS-side, it does **not** replace the patch, and the
patch stays.

Do not change the toolbox patch in this branch either way — this task only produces the
decision. Retiring it is its own change with its own performance verification.

- [ ] **Step 4: Commit the finding**

```bash
git commit --allow-empty -m "chore(sdk): record whether KeyDeriver.derivePrivateKeys can replace batchBrc42DeriveChild

<state the finding and the decision here>"
```

---

### Task 7: Device smoke test and merge

**Files:** none modified

**Interfaces:**
- Consumes: everything above
- Produces: a merged `master` on 2.4.0, unblocking the backup client plan.

Jest runs the noble backend, never the Nitro native path. Only a device build exercises
the tier that actually ships.

- [ ] **Step 1: Build and run on a device**

```bash
npm run ios-dev-device
```

Per project convention the corporate firewall blocks LAN Metro, so the tunnel variant is
the working one.

- [ ] **Step 2: Run the native proof harness**

Launch the dev build with `EXPO_PUBLIC_SECP_PROOF=1`. It runs all 27
`native-secp-poc/fixtures/vectors.json` vectors through the routed SDK calls, verifies via
a call-counting proxy that the native path was genuinely taken, and micro-benches routed
versus pure-JS.

Expected: all 27 vectors pass, the proxy confirms native was used (not silently falling
through to noble), and the timings are in line with the figures in
`native-secp-poc/M2-SIMULATOR-RESULTS.md`.

- [ ] **Step 3: Send a real transaction**

On the device, send a small payment on mainnet and confirm it broadcasts and confirms.
This is the end-to-end proof that signing still produces valid transactions — the property
every unit test above is a proxy for.

- [ ] **Step 4: Run the Android emulator pass**

```bash
npm run android
```

Project convention: always run the Android emulator, since it has previously caught races
that iOS did not.

- [ ] **Step 5: Merge**

```bash
git checkout master && git merge --no-ff chore/bsv-sdk-2.4.0
```

- [ ] **Step 6: Confirm the merged state**

```bash
node -p "require('./node_modules/@bsv/sdk/package.json').version"
ls patches/
```

Expected: `2.4.0`, and `patches/` containing `@bsv+sdk+2.4.0.patch` and
`@bsv+wallet-toolbox-mobile+2.4.3.patch` — with no 2.1.9 file.

---

## Acceptance

- `@bsv/sdk` 2.4.0 installed and pinned exactly; no 2.1.9 patch file remains
- 27/27 signature vectors and public keys byte-identical to the 2.1.9 baseline
- `__tests__/nobleBackend.test.ts` green
- `__tests__/sdkAuthFetchBinaryBody.test.ts` green, proving raw binary upload works
- Full suite, `tsc --noEmit` and lint clean
- Native proof harness green on a real device, native path confirmed taken
- A real mainnet transaction sent and confirmed from a device build
