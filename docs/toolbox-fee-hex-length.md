# The wallet prices a page-supplied unlocking script by its hex length

Recorded 2026-10-14. Issue: bsv-blockchain/bsv-browser#161. Pull request (draft): bsv-blockchain/bsv-browser#162.

## The defect

A page that spends a script it unlocks itself passes `createAction` an input with `unlockingScript` as a hex string and no `unlockingScriptLength` (the BRC-100 shape). The toolbox signer strips the script before the storage plan and records its length; storage funds and prices the input on that length. It records the hex string's length, twice the bytes.

## The versions and the line

| copy | where | `removeUnlockScripts` |
| --- | --- | --- |
| locked here, `@bsv/wallet-toolbox-mobile` 2.14.4 (`package-lock.json`, range `^2.14.4`) | `node_modules/@bsv/wallet-toolbox-mobile/out/index.mobile.cjs` lines 9669-9686, the measure at 9679 | `unlockingScriptLength: i.unlockingScript !== void 0 ? i.unlockingScript.length : i.unlockingScriptLength` |
| latest published, 2.14.9 (npm `latest`, 2026-10-13) | `out/index.mobile.cjs:9754` | the same: **present in 2.14.9** |
| 3.0.0-alpha.0 | `out/src/signer/methods/createAction.js:88` | the same |
| source, `bsv-blockchain/ts-stack` `main` | `packages/wallet/wallet-toolbox/src/signer/methods/createAction.ts:296` | the same |

`i.unlockingScript` is the validated hex string; the SDK's `validateCreateActionInput` had already set `unlockingScriptLength` to `length / 2`, and this line overwrites it.

## The arithmetic

The registration `2a114fa80fdcd3fc31831f41ef1c3de9528c230160f174282aaf4ea01d5071fd`, signed on this app at 100 sat/kB: 78,369 bytes; input 0's unlocking script 36,401 bytes; two P2PKH funding inputs (107 bytes each); outputs of 27,395, 25, 14,134 and 25 script bytes.

Storage sizes a transaction from script lengths (per input `36 + varint(len) + len + 4`):

- the true size: 78,369 B, `ceil(78,369 * 100 / 1000)` = **7,837 sats**;
- input 0 at 72,802 (the hex length): 78,369 + 36,401 + 2 (the varint grows from 3 bytes to 5) = 114,772 B = **11,478 sats**, the fee paid, to the sat.

Overpaid: 3,641 sats on one registration. Its desktop twin `bf3ed257f27eb21ad838944fe110832c911e3ed538857cd848773d25cd410270` (Rust toolbox, 78,221 B) paid 7,901. A 14,437-byte unlock overpays about 1,444 sats.

## The test

`__tests__/unlockingScriptLength.test.ts` drives the real `Wallet.createAction` to the storage plan with a 36,401-byte unlocking script. On 2.14.4 it is RED: storage receives 72,802 (expected 36,401), and the registration prices at 11,478 (expected 7,837). It goes green on the toolbox release that fixes `removeUnlockScripts`.

## What is next

No workaround here: no in-place patch of the dependency, no fork pin. The fix belongs in ts-stack (`removeUnlockScripts`, `i.unlockingScript.length / 2`); when `@bsv/wallet-toolbox-mobile` publishes it, #162 bumps to that release, regenerates the lockfile, drops the `"//"` note in `package.json`, and is marked ready.
