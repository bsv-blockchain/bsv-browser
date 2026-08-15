# R1-K1 Vault — design

Date: 2026-08-15
Status: approved design, not yet implemented. Carries one **deployment
prerequisite** — see §0.

## 0. Deployment prerequisite: arcade's script-size policy

Miner policy for max script size is **100,000,000 bytes**, ~100× our ~960 KB scripts,
so the network itself is not a constraint. But **arcade's own default is 500,000
bytes** and must be raised before go-live. This is an operator action, tracked here
because until it lands, R1-K1 outputs can be created and never spent.

`MaxScriptSizePolicy: 500000` is hardcoded at `validator/validator.go:219` with no
config override — `validatorPolicyFromConfig` (`app/app.go:294`) only ever sets
`MinFeePerKB`, and teranode's `maxscriptsizepolicy` env key is inert because arcade
constructs `settings.Settings` literally rather than calling `settings.NewSettings()`.
Raising it means patching that line; the BDK accepts any value in
`[0, 4294967295]`, and `0` means unlimited.

### Why it matters, precisely

Verified by disassembling the prebuilt BDK archives arcade links against, not inferred
from upstream. The limit is enforced **per script, on the spend**: `VerifyScript`
invokes `EvalScript` twice — once with the scriptSig, once with the prevout
scriptPubKey — and each invocation re-reads the limit (`interpreter.cpp.o` @ 0x685c,
calls at 0x6950 and 0x6af0; check at @ 0x338-0x354, `size <= max`, failing
`SCRIPT_ERR_SCRIPT_SIZE`). So under an unraised arcade:

- **Deposits succeed.** A transaction's own output scripts are never evaluated. Only
  `MaxTxSizePolicy` (10 MB) and standardness apply, and `RequireStandard: false`
  discards the standardness verdict entirely.
- **Every spend fails.** The 959,632-byte *locking* script busts the limit by itself,
  so the K1 recovery path dies too despite its 107-byte unlocking script.

That asymmetry is a funds-lock trap, which drives a hard sequencing rule:

> **Prove a spend end-to-end against the actually-deployed arcade configuration
> before enabling any deposit path.** Both branches, on the target network.

This is not merely prudence about the policy — it is also the only way to settle
`MaxStackMemoryUsagePolicy: 104857600`, whose headroom for a ~960 KB P-256 verifier
cannot be determined from source.

Note `AcceptNonStdOutputs: true` / `RequireStandard: false` do **not** relax the
script-size check — they gate `implCheckStandardness`, which never reaches script
evaluation. teranode's own `TestMaxScriptSizePolicy`
(`services/validator/TxValidator_test.go:543`) demonstrates the limit biting with
exactly those defaults, so do not read them as an escape hatch.

Cleared as non-issues by the same investigation: `MaxOpsPerScriptPolicy: 1000000`
cannot bind (only opcodes above `OP_16` are counted, each is one byte, and script has
no loops, so executed ops < script length < 1M; the counter is a per-`EvalScript`
stack local, so it never accumulates across scripts or inputs), and
`MaxScriptNumLengthPolicy: 10000` is irrelevant to 32-byte P-256 field elements.

One diagnostic wrinkle to expect while the policy is still unraised: arcade's
`classifyByMessage` (`validator/errmap.go:60-66`) matches `"too big"` before its
`"script"` case, so the rejection surfaces as `StatusTxSize`, not
`StatusUnlockingScripts`. A misleading "transaction size" error is the symptom of a
script-size rejection.
Supersedes: the sealing/ceremony half of `2026-08-12-yubikey-vault-design.md` and
`2026-08-14-vault-key-from-wallet-entropy.md`. The derivation half of the latter
(`vaultDerivation.ts`, `vaultPassphrase.ts`) survives intact.

## 1. Goal

Replace the vault's encrypted-key scheme with the `R1K1Wallet` script template from
`@bsv/templates`. Vault outputs become a half-multisig locking script with two
independent spending branches:

- **R1** — an ECDSA signature over the P-256 (secp256r1) curve, produced directly by
  the YubiKey's PIV key. The everyday spending path.
- **K1** — an ordinary secp256k1 `OP_CHECKSIG`, keyed from the vault HD node. The
  recovery path for a lost or destroyed YubiKey.

Today the YubiKey is a *key-wrapping* device: it performs PIV-ECDH to unwrap a sealed
secp256k1 key, which then signs. After this change it is a *signing* device — the
private key never leaves the card and nothing is sealed. This removes an entire class
of failure (seal corruption, seal/meta version skew, key material transiting JS).

No backwards compatibility is required or provided.

## 2. Decisions

Recorded with rationale so the next reader does not relitigate them.

| # | Decision | Rationale |
|---|---|---|
| D1 | Add a native `signEcdsa` to the YubiKeyPiv Nitro module (iOS + Android + mock) | The module exposes only `ecdh`. The R1 branch cannot exist without a raw-digest P-256 signature. |
| D2 | K1 root is the vault HD node (mnemonic + vault passphrase), **not** the ordinary wallet key | "K1 applies if the YubiKey is lost" only means something if K1 is reachable without the YubiKey *and* unreachable from the plain wallet key. Otherwise the vault is not a security boundary. |
| D3 | K1 per-output keys stay BIP32 xpub children | BRC-42 self-derivation needs the private key, which is offline at deposit time. The existing xpub path is already public-derivable and already tested. |
| D4 | `TouchPolicy.CACHED` on the PIV slot | R1-K1 needs one signature per input. `ALWAYS` costs one physical touch per input; `CACHED` collapses a multi-input withdraw to one touch. |
| D5 | Append-only deposits with a 200,000-sat floor; withdraw consolidates | Keeps deposits hardware-free. The floor is economic dust: an output should be worth more than the ~96,000 sats it costs to spend. |
| D6 | `customInstructions` carries a BIP32 `keyID`, not BRC-29 prefix/suffix | Follows from D3. Supersedes the "prefix and suffix" wording in the original request. |
| D7 | Wallet fee model unchanged at 100 sat/kb | Vault actions cost ~96,000 sats (~3¢). Not worth a per-action fee override. |
| D8 | Fix the RN gzip gap with `patch-package`, not a global polyfill | Six patched lines and one small dependency versus shimming four web APIs globally. |
| D9 | **No input cap** — a withdrawal spends every vault output | Measured (§3.7): peak heap is flat regardless of input count, because signing is sequential and each preimage is collected before the next. The binding constraint is broadcast payload size — a server limit to be found by testing, not a client memory limit. |

### Non-goals

- Migrating existing vault outputs. Funds under the old P2PKH-to-xpub scheme must be
  swept out via the existing recovery flow before upgrading.
- Any change to `vaultDerivation.ts` or `vaultPassphrase.ts`.
- Changing which originators may reach privileged operations.

## 3. Verified facts

Everything in this section was measured, not inferred. Re-measure before trusting it
after any dependency bump.

### 3.1 Dependency versions

`R1K1Wallet` first ships in **`@bsv/templates@1.10.0`**; the repo currently pins
`^1.9.6`. Its peer range is `@bsv/sdk ^2.1.6`, and the pinned **2.1.9** provides every
API it touches — the four-argument `Script` constructor with `rawBytesCache`/`parsed`,
`Script.toUint8Array()`, `TransactionSignature.format`, `Signature.fromDER`,
`Hash.hash160`. A probe run against exactly `templates@1.10.0` + `sdk@2.1.9` produced
valid, interpreter-accepted scripts on both branches. **No SDK bump is required.**

### 3.2 Script sizes

Measured by building a real output and spending it:

| | bytes |
|---|---|
| locking script | **959,632** |
| R1 unlocking script | **959,871** |
| K1 unlocking script | 107 (template estimates 109) |

`R1_K1_TEMPLATE_BYTE_LENGTH` is 959,592; `lock()` expands two 1-byte constructor slots
into two 21-byte pushes, giving 959,632. The template is an in-script P-256 verifier,
which is why it is large.

The R1 branch's code separator sits at baked offset 59, so the sighash subscript is
`lockingBytes.subarray(60)` — almost the whole script — and `unlockR1` pushes that
entire preimage into the unlocking script. R1 therefore pays the script size twice:
once to create the output, once to spend it. K1 is a plain `OP_CHECKSIG` and pays it
only once.

### 3.3 The unlocking-script lengths are constants

Every field of the sighash preimage that varies with transaction shape
(`hashPrevouts`, `hashSequence`, `hashOutputs`) is hashed to a fixed 32 bytes, so the
preimage length never moves:

```
preimage = 4 + 32 + 32 + 36 + (5 + 959_572) + 8 + 4 + 32 + 4 + 4 = 959_733
R1 unlock = push(64) + push(33) + push(32) + push(959_733) + 1
          =    65    +    34    +    33    + (5 + 959_733)  + 1  = 959_871
```

This matches the measured value exactly. It means `unlockingScriptLength` for
`createAction` is a literal, not an estimate — the usual chicken-and-egg problem
(needing the transaction to size the script that goes in the transaction) does not
arise here.

```ts
export const R1K1_LOCK_LEN = 959_632
export const R1K1_R1_UNLOCK_LEN = 959_871
export const R1K1_K1_UNLOCK_LEN = 109
```

### 3.4 Both branches validate, and high-S is accepted

Run through the SDK's `Spend` interpreter:

| | verdict | wall clock |
|---|---|---|
| K1 | `true` | 65 ms |
| R1, low-S signature | `true` | 298 ms |
| R1, high-S signature | `true` | 234 ms |

Two consequences:

1. **No low-S normalisation.** The in-script P-256 verifier accepts both S values, so
   the YubiKey's DER signature passes straight through `normalizeP256Signature`
   untouched. Do not add a normalisation step; do add a test that pins this, so a
   future template revision cannot silently break it.
2. **Real script execution belongs in the unit suite.** At sub-300 ms per validation
   there is no reason to settle for structural assertions.

The K1 path is fast because the `OP_1` branch selector short-circuits past the P-256
code entirely.

### 3.7 Signing does not scale memory with input count

Signing N R1 inputs sequentially, measuring peak RSS and peak heap on a 5 ms sampler:

| inputs | sign time | peak heap | peak RSS | retained unlock hex | spending tx |
|---|---|---|---|---|---|
| 1 | 61 ms | 30.7 MB | 109 MB | 1.8 MB | 0.9 MB |
| 4 | 208 ms | 30.2 MB | 110 MB | 7.3 MB | 3.7 MB |
| 10 | 529 ms | 30.4 MB | 110 MB | 18.3 MB | 9.2 MB |
| 25 | 1296 ms | 30.5 MB | 110 MB | 45.8 MB | 22.9 MB |

**Peak heap is flat.** Each input's ~960 KB preimage — and the intermediate `number[]`
forms of it inside `TransactionSignature.format` and `Array.from(preimage)` — is
allocated and collected before the next input starts. There is no scenario where N
preimages are live at once. Sign time is linear at ~52 ms/input and irrelevant.

What does grow linearly is **retained** state: 1.8 MB of unlocking-script hex per input
(hex is two chars per byte) held in the `spends` map until `signAction`, plus the
transaction itself at 0.92 MB per input.

The real ceiling is therefore the **broadcast payload**, not device memory. Arcade and
TAAL are fed extended format, not BEEF — `arcadeBroadcastProvider.ts:59` posts
`new Uint8Array(tx.toEF())`. EF inlines each input's *source locking script* alongside
its unlocking script, and for a vault input both are ~0.92 MB, so the payload is
almost exactly double the raw transaction:

| inputs | raw tx | EF posted |
|---|---|---|
| 1 | 0.92 MB | **1.83 MB** |
| 2 | 1.83 MB | 3.66 MB |
| 4 | 3.66 MB | 7.32 MB |
| 10 | 9.15 MB | 18.31 MB |

Exactly 1.83 MB per input, linear. Neither the SDK's `ARC` broadcaster nor the app
imposes a client-side limit.

Arcade's limit is **32 MiB** on the single-tx submit endpoint —
`maxSingleTxBytes = 32 << 20` at `services/api_server/handlers.go:645`, applied at
line 672 via `http.MaxBytesReader` on `POST /tx`. (Batch submit is 256 MiB, unused
here.) At 1.83 MB of EF per input that permits **~18 vault inputs** per withdrawal,
far above anything the 200,000-sat floor makes reachable in practice. Arcade's
transaction-size policy is a separate and looser bound: `MaxTxSizePolicy: 10485760`
(10 MB) at `validator/validator.go:216`, against a raw transaction of 0.92 MB per
input, i.e. ~10 inputs.

TAAL's ARC is a second, independent broadcaster (`WalletContext.tsx:743`) whose limits
are not visible from this repo and are not assumed here.

### 3.5 The template throws on device as shipped

`R1K1Wallet.loadTemplateBytes()` decompresses its artifact with:

```js
new Blob([compressed.buffer]).stream()
  .pipeThrough(new DecompressionStream('gzip'))
```

React Native 0.83 / Hermes provides none of `DecompressionStream`, `ReadableStream`,
or `Blob.prototype.stream`. Every `lock()` **and** every `unlockR1`/`unlockK1` (via
`validateLockingScript`) reaches this function, so the template is entirely
non-functional on device until fixed. See §8.

### 3.6 Native signing APIs

Both platforms can sign a raw, pre-computed 32-byte digest — which is precisely what
`R1K1P256DigestSigner` hands over.

- **Android**, yubikit-android 3.2.0:
  `PivSession.rawSignOrDecrypt(Slot, KeyType.ECCP256, byte[32])` is public and sends
  the payload verbatim. Note `sign(Slot, KeyType, byte[], Signature)` was removed in
  3.x; only the raw primitive remains.
- **iOS**, YubiKit 4.4.0 (the Objective-C SDK — the class is `YKFPIVSession`, there is
  no Swift `PIVSession` here): `signWithKeyInSlot:type:algorithm:message:` with
  `.ECCP256` and `kSecKeyAlgorithmECDSASignatureDigestX962SHA256`. `YKFPIVPadding`
  reduces that combination to `hash = [data mutableCopy]`, i.e. raw passthrough.

Both return DER, which `normalizeP256Signature` already accepts. Neither verifies the
PIN for you.

## 4. On-chain format

### 4.1 Locking script

```ts
const lockingScript = await new R1K1Wallet().lock(
  Hash.hash160([...r1PublicKey33, ...salt32]),   // R1 commitment
  Hash.hash160(k1PublicKey33)                     // K1 commitment
)
```

`salt` is a fresh `randomBytes(32)` per deposit. The YubiKey holds one key for the
vault's whole life, so without the salt every output would carry an identical R1
commitment and be trivially linkable. The salt is not secret — it appears in the
unlocking script when spent — it only prevents linkage before the spend.

### 4.2 customInstructions

Written on every vault output, read on every vault spend. JSON-encoded string,
matching the existing vault convention (note other subsystems in this repo store
`customInstructions` as an object; the vault has always used a string).

```json
{
  "v": 2,
  "type": "R1K1",
  "keyID": "bip32/7",
  "salt": "<64 hex chars>",
  "r1PublicKey": "<66 hex chars, compressed>",
  "slot": 130
}
```

- `v` is the customInstructions format version, bumped from 1 to 2. **This is a
  separate counter from the vault meta version** (§5.1), which goes to 3. They have
  always been independent — meta v1 and v2 both wrote `customInstructions` `v: 1` —
  and the numbers coinciding or not carries no meaning. `type` is redundant with `v`
  today but makes an output self-identifying if the vault ever carries more than one
  template.
- `r1PublicKey` is stored **per output**, not read from vault meta. This keeps an
  output spendable after a re-enrollment to a different YubiKey, and gives
  `unlockR1`'s commitment check everything it needs without touching global state.
- `slot` is recorded for the same reason.
- An output whose `customInstructions` is absent, unparseable, or not `v: 2` is
  excluded from the spendable set — same defensive posture as the current
  `keyIDFromInstructions`.

Basket, tags and labels are unchanged: `admin vault`, `tags: ['vault']`, labels
`['vault','vault-deposit']` / `['vault','vault-withdraw']`.

## 5. Key material

| | R1 leg | K1 leg |
|---|---|---|
| root | YubiKey PIV slot `0x82`, P-256, non-extractable | `HD.fromSeed(Mnemonic.toSeed(vaultPassphrase))` |
| per-output | one pubkey, unique salt | `HD.fromString(xpub).deriveChild(n)` |
| public derivation at deposit | pubkey from vault meta | existing xpub path |
| spend requires | YubiKey + PIN + touch | mnemonic + vault passphrase |

The two legs are fully independent: neither can produce the other, and losing either
one leaves the funds reachable.

### 5.1 Vault meta v3

```ts
export interface VaultMetaV3 {
  v: 3
  enrolledAt: number
  yubiSerial: string
  nickname: string
  slot: number
  nextKeyIndex: number
  lastUsedAt?: number
  xpub: string
  r1PublicKey: string   // 33-byte compressed P-256, hex
}
```

`VaultMetaV1`, `VaultMetaV2`, `SealedBlob` and the `depositKeys` queue are deleted.
`vaultStore` keeps only the AsyncStorage meta record; the `vault_seal_v1` SecureStore
entry is deleted on `clear()`.

`generateVaultKey` returns a 65-byte uncompressed SEC1 point; compress it to 33 bytes
before storing.

## 6. Native module

### 6.1 New Nitro method

```ts
signEcdsa(slot: number, pin: string, digest: string): Promise<string>
// resolves JSON {"signature":"<DER hex>"}
```

Modelled directly on `ecdh` — same `withSession`/`withPiv` plumbing, same
`VAULT_ERR:<code>:<detail>` error convention, same `vaultErrorFromNative` mapping on
the TS side. `driver.ts` gains a matching
`signEcdsa(slot, pin, digest): Promise<{ signature: string }>`.

### 6.2 Mandatory guards

These are not defensive polish; each corresponds to a verified defect or a silent
wrong answer.

1. **Digest length.** Reject anything that is not exactly 32 bytes, in TS *and* again
   natively. On iOS, an unrecognised `SecKeyAlgorithm` leaves the padding buffer nil
   and the code path signs **32 zero bytes** rather than erroring — the
   `"EC padding algorithm not supported."` branch is unreachable dead code. On
   Android, `rawSignOrDecrypt` silently truncates an over-long EC payload to 32 bytes.
   Both produce a valid signature over the wrong message.
2. **`hasSettled` guard on iOS.** YubiKit 4.4.0's `signWithKeyInSlot:` calls
   `completion(nil, padError)` and then falls through — there is no `return` — so it
   invokes the completion block a second time via `usePrivateKeyInSlot:`. A double
   resolve/reject on a Nitro `Promise<String>` is a crash risk.
3. **Explicit `verifyPin` before every sign.** Neither SDK does it. Yubico's own JCA
   wrapper verifies the PIN immediately before `rawSignOrDecrypt`; do the same. On
   Android this must happen inside *every* call, because `withPiv` opens a fresh
   `SmartCardConnection`/`PivSession` per operation.

### 6.3 Touch policy

`driver.ts:120` currently hardcodes `native.generateVaultKey(slot, 'always', 'once')`.
Change the touch policy to `cached`. This requires regenerating the slot key, i.e.
re-enrollment — acceptable, since no backwards compatibility is being kept.

Touch is enforced by the applet, never by the SDK. A required-but-unmet touch surfaces
as SW `0x6982`/`0x6985`, which both `mapError` implementations already fold into
`touch-timeout`.

### 6.4 Mock driver

`mockYubiKey.ts` gains a software P-256 `signEcdsa` over `@noble/curves`, so the whole
Jest suite and the simulator exercise the real signing path without hardware. The mock
must enforce the same digest-length rejection and PIN gate as the native modules, or
it will hide the bugs it exists to catch.

## 7. Ceremony becomes a signing session

The ceremony's terminal state changes from "produced a `PrivateKey`" to "holds an
armed session that can sign digests".

```ts
export interface VaultR1Signer {
  publicKey: number[]                            // 33-byte compressed P-256
  sign(digest: Uint8Array): Promise<number[]>    // DER
  release(): void
}

// was: request(reason): Promise<PrivateKey>
requestSigner(reason: string): Promise<VaultR1Signer>
```

- The PIN lives in the session closure for its lifetime. This is not a new exposure —
  `unsealViaTap` already holds the PIN in a local across the tap — but it now spans
  several signatures rather than one operation.
- The existing `RETRYABLE_TAP_ERRORS` retry loop (`touch-timeout`, `nfc-lost`,
  `key-removed-mid-op`) moves from once-per-ceremony to **once per `sign` call**. On
  iOS a CoreNFC session can drop between inputs; on Android every call reopens the
  connection anyway.
- Phase reporting, the armed-window timer, `onArmed`/`onRelock`, serial matching, and
  the PIN-before-tap NFC ordering are all unchanged.
- `release()` stops discovery on session-based transports (iOS), matching the current
  post-arm `stop()` behaviour.

## 8. React Native runtime fix

Patch `@bsv/templates` via `patch-package` (already wired into `postinstall`, already
carrying patches for `@bsv/sdk` and `@bsv/wallet-toolbox-mobile`), replacing the
`Blob`/`DecompressionStream`/`Response` chain in `loadTemplateBytes` with
`fflate.gunzipSync`. Patch both `dist/src/R1K1Wallet.js` and `.cjs`.

Add `fflate` — pure JS, Hermes-safe, no native dependency.

The function's own length and SHA-256 assertions against
`R1_K1_TEMPLATE_BYTE_LENGTH` / `R1_K1_TEMPLATE_SHA256` stay in place, so a patch that
silently stops working fails loudly rather than producing a wrong script.

Rejected alternative: polyfilling `DecompressionStream`, `ReadableStream`,
`TransformStream` and `Blob.prototype.stream` globally. Four shims to maintain against
six patched lines, with a much larger blast radius.

The decompressed template is cached module-side by the library's own
`templateBytesPromise`, so the cost is paid once per app launch.

## 9. Flows

### 9.1 Deposit

No YubiKey, no passphrase. Minimum **200,000 sats**, rejected below — an economic-dust
floor, since an output should be worth more than it costs to move. Replaces the
current `DUST_LIMIT` check of 546 for deposits.

```
n           = vaultStore.takeNextIndex()
k1Pub       = HD.fromString(meta.xpub).deriveChild(n).pubKey
salt        = randomBytes(32)
lockingScript = R1K1Wallet.lock(hash160(meta.r1PublicKey ‖ salt), hash160(k1Pub))
createAction({ outputs: [{ satoshis, lockingScript, basket: 'admin vault',
                           tags: ['vault'], customInstructions }],
               labels: ['vault','vault-deposit'] })
```

### 9.2 Withdraw — R1 path

`listOutputs` is called **without** `include: 'entire transactions'`. The locking
script is rebuilt locally from `salt` + `r1PublicKey` + the xpub child, so
`unlockR1({ sourceSatoshis, lockingScript })` never needs the source transaction. This
is what keeps megabytes of BEEF out of JS memory; if `createAction` turns out to
require `inputBEEF` despite `trustSelf: 'known'`, that is an implementation-time
finding to resolve, not a design change.

Selection: **spend every vault output, no cap.** The remainder is re-vaulted as one
consolidated output when it clears the 200,000-sat floor, and folded into the
withdrawal when it does not. The vault therefore converges to at most one UTXO after
any withdrawal, which is what keeps subsequent withdrawals cheap and single-tap.

There is no input cap because there is no memory reason for one — §3.7 shows peak heap
flat across 1 to 25 inputs, since inputs are signed sequentially and each preimage is
collected before the next. The only scaling concern is the 1.83 MB per input of
extended format posted at broadcast, which is a server-side limit at Arcade/TAAL,
unknown until tested (§14). If a ceiling turns up, bound by *EF payload size* against
the measured limit — not by an arbitrary input count.

```
createAction({ inputs: [{ outpoint, unlockingScriptLength: R1K1_R1_UNLOCK_LEN, … }], … })
  → signableTransaction
  → for each input: signer.sign(digest) via the ceremony session
  → signAction({ reference, spends })
```

The existing `WERR_REVIEW_ACTIONS` double-spend self-heal and the `abortAction` on
signing failure both carry over unchanged.

### 9.3 Recovery — K1 path

Entry point unchanged (`vault-recover`). Per output:

```ts
tpl.unlockK1({
  privateKey: depositPrivKey(hd, indexFromKeyID(ci.keyID)),
  sourceSatoshis, lockingScript
})
```

107-byte unlocking scripts, so a full sweep stays cheap regardless of output count.
The 4-input cap does not apply to the K1 sweep.

## 10. Deletions

The vault's `PrivilegedKeyManager` exists solely to serve vault withdrawals — every
consumer was checked. With the YubiKey signing directly, none of it is reachable.

**Removed:** `services/vault/sealing.ts` and `__tests__/vault/sealing.test.ts`;
`SealedBlob`; the `vault_seal_v1` SecureStore entry; `VaultKeyService.resealHDToNewKey`,
`resealToNewKey`, `recoverVaultKeyV1`, `deriveVaultKey`, `deriveDepositKeys`; all v1
meta handling (`depositKeys`, `popDepositKey`, `pushDepositKeys`,
`replenishDepositKeys`, `sweepVaultWithKey`); `buildVaultUnlockingScript` and the
`VaultSigner` interface in `transfers.ts`, both superseded by the template; the vault
branch of `makePrivilegedKeyGetter`; the `destroyPrivilegedKey()` calls in `vault.tsx`
and `vault-recover.tsx`.

**Kept:** a `PrivilegedKeyManager` returning the plain root key — the toolbox requires
`providePrivilegedKeyManager`. `guardVaultAccess` stays and becomes *more* important,
not less: privileged now means the root key, so blocking non-admin originators is the
only thing standing between a web page and it.

**Untouched:** `vaultDerivation.ts`, `vaultPassphrase.ts`, `session.ts`, `guard.ts`,
`random.ts`, `types.ts` (minus `SealedBlob`).

This also retires the v2 ceremony defect — `hd.toBinary()` sealed at
`VaultKeyService.ts:130` but unsealed as `new PrivateKey(...)` at `ceremony.ts:289`,
so a v2 YubiKey withdrawal derived a key that could never match what the deposit
locked to — by deleting the code containing it rather than repairing it. It was
untested because every `transfers` fixture used v1 `vault/<n>` keyIDs.

## 11. Error handling

`signEcdsa` reuses the existing `VaultErrorCode` vocabulary — `no-key`, `pin-invalid`,
`pin-locked`, `touch-timeout`, `nfc-lost`, `key-removed-mid-op`, `wrong-key` — plus
**one new code**, `template-invalid`, because `seal-corrupt` becomes a misnomer once
§10 deletes sealing.

| Condition | Code |
|---|---|
| digest not exactly 32 bytes | `template-invalid` — programmer error, must never reach a user |
| commitment mismatch in `unlockR1` | `wrong-key` — the YubiKey present is not the one that locked this output |
| template gzip / length / SHA-256 failure | `template-invalid` |
| tap dropped mid-signature | `nfc-lost`, retried per §7 |

A commitment mismatch is the user-visible signal for "wrong YubiKey", and is caught
before any APDU is sent, so it costs no tap.

One caution on `wrong-key`: `vaultErrorFromNative` reclassifies it to `nfc-lost` when
the detail string matches `NFC_LOST_PATTERN` (`types.ts:71`). Commitment mismatches
are raised in TS, never across the native bridge, so they are not subject to that
reclassification — but a native-side `wrong-key` still is. Do not route the digest
-length rejection through `wrong-key` for this reason.

## 12. Testing

Real script execution, not structural assertions, since `Spend.validate()` runs in
under 300 ms.

**Script correctness**
- R1 round trip validates through `Spend`; single-input and multi-input.
- K1 round trip validates through `Spend`.
- A high-S R1 signature validates. This pins §3.4 so a template revision cannot
  silently introduce a normalisation requirement.
- Wrong salt, wrong `r1PublicKey`, and wrong K1 key are each rejected by the
  commitment checks before signing.
- `lock()` output is exactly 959,632 bytes with the two 20-byte commitments at the
  expected offsets.
- `R1K1_R1_UNLOCK_LEN` equals the length of a genuinely signed unlocking script —
  catches template drift on a version bump.

**Flows**
- Deposit below 200,000 sats rejected; at or above, accepted, with
  `customInstructions` carrying `v:2`, `keyID`, `salt`, `r1PublicKey`, `slot`.
- Withdraw spends *every* vault output, re-vaults the remainder as one output when it
  clears the floor, and folds a sub-floor remainder into the withdrawal — so the vault
  converges to at most one UTXO.
- Signing 10 inputs stays within a flat heap ceiling (guards the §3.7 finding against
  a future change that accidentally holds all preimages live).
- Withdraw never requests `include: 'entire transactions'`.
- `abortAction` still fires on signing failure; the `WERR_REVIEW_ACTIONS` heal still
  works.
- K1 sweep spends every output regardless of count.

**Native / ceremony**
- Mock `signEcdsa` produces a signature the template accepts.
- Digest-length rejection asserted at the TS boundary and in the mock.
- Ceremony signs N digests within one armed session; a `nfc-lost` on input 2 retries
  that signature without restarting the ceremony or re-collecting the PIN.
- Serial mismatch still aborts before any signing.

**Hardware matrix** (cannot be automated)
- iOS NFC and Android NFC + USB: enroll with `CACHED`, deposit, 1-input withdraw,
  4-input withdraw, tap dropped mid-withdraw, wrong PIN, PIN lockout.

## 13. Rollout

0. Raise arcade's `MaxScriptSizePolicy` (§0), then prove a spend of both branches
   end-to-end against the deployed configuration. **Gates enabling the deposit path**,
   and settles `MaxStackMemoryUsagePolicy` at the same time. Can run against a
   software P-256 signer, so it does not wait on step 2.
1. Bump `@bsv/templates` to `^1.10.0`; add `fflate`; add the patch. `@bsv/sdk` stays
   at 2.1.9.
2. Native module change, nitrogen regen, new dev builds for both platforms.
3. TS rewrite behind the existing vault screens — no new UI surface.
4. Hardware matrix.

Existing enrollments must re-enroll, which is required anyway for `TouchPolicy.CACHED`.
Any funds under the old P2PKH-to-xpub vault outputs must be swept out via the existing
recovery flow **before** upgrading — the new code will not recognise them. This needs a
release note.

## 14. Open risks

| Risk | Handling |
|---|---|
| `createAction` may demand `inputBEEF` despite `trustSelf: 'known'`, reintroducing multi-MB BEEF | Resolve at implementation. Worst case, accept the BEEF cost on withdraw only; deposits are unaffected. |
| The iOS Swift spelling of `signWithKeyInSlot:type:algorithm:message:completion:` is importer-derived and carries no `NS_SWIFT_NAME` | Let the compiler name it. Sibling selectors in the same class import inconsistently (`calculateSecretKey(in:…)` vs `getCertificateIn(_:)`), so do not guess. |
| `patch-package` drift on a future `@bsv/templates` bump | The template's own length + SHA-256 assertions fail loudly rather than silently. |
| Arcade's `MaxScriptSizePolicy: 500000` makes every spend fail until raised | Operator action, owned outside this repo; miner policy is already 100,000,000. See §0 for the sequencing rule it imposes. |
| `MaxStackMemoryUsagePolicy: 104857600` headroom for a ~960 KB P-256 verifier | Not determinable from source. Falls out of the §0 spend proof for free. |
| TAAL's ARC limits are not visible from this repo | A second independent broadcaster (`WalletContext.tsx:743`). Assume it enforces the same 500,000 default until shown otherwise. |
| Storage: ~1 MB per vault transaction in SQLite | Exercise alongside the §0 spend test. |
| `readVaultPublicKey` returns null unconditionally for slot `0x82` on iOS, so the slot-occupancy guard is inert there | Pre-existing, unchanged by this work. Re-enrollment will silently overwrite an occupied slot on iOS. Worth a separate fix. |
