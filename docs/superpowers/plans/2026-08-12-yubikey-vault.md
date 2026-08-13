# YubiKey Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hardware-gated `admin vault` basket: a vault privileged key sealed to a YubiKey 5C's PIV P-256 slot, unsealed only via insert+PIN+touch ceremony, wired into `PrivilegedKeyManager`, with internal transfers, ceremony UX, sounds and haptics.

**Architecture:** Wrap/gate (age-plugin-yubikey model): software-generated secp256k1 vault key sealed via ephemeral-P256-ECDH → HKDF → AES-GCM to the token pubkey; on-token ECDH (touch-gated) unseals. New Nitro native module wraps YubiKit (iOS legacy SDK ≥4.7 pod) / yubikit-android 3.2.0. Pure-TS service layer (sealing, store, ceremony controller, transfers) is fully unit-tested against a software mock driver.

**Tech Stack:** Expo SDK 55 / RN New Arch, Nitro modules (nitrogen 0.35.x), @bsv/wallet-toolbox-mobile 2.4.3, @bsv/sdk 2.1.x, @noble/curves (new dep), expo-secure-store, expo-audio, expo-haptics, Jest.

**Spec:** `docs/superpowers/specs/2026-08-12-yubikey-vault-design.md` — read it first.

## Global Constraints

- Basket name is exactly `admin vault`; all wallet calls for vault ops go through `managers.permissionsManager` with `adminOriginator` ('admin.com', from `context/config.tsx`).
- Vault BRC-42 params: `protocolID: [2, 'vault']`, `counterparty: 'self'`, `keyID: 'vault/<n>'` (n = monotonically increasing integer).
- PIV slot `0x82`, touchPolicy `always`, pinPolicy `once`. Policies immutable post-keygen.
- Seal format id `bsvb-vault-seal-v1` (HKDF info string).
- Not-enrolled behavior must be byte-identical to today: keyGetter returns the legacy root key.
- Native failure = graceful null/typed error, never crash (localpay-transport convention).
- `.easignore` must never be deleted; verify pack contents with `git ls-files --exclude-from .easignore --ignored --cached`.
- Sounds: respect silent switch, mixWithOthers, lazy expo-audio require, never throw (clone useConfirmationSound rules).
- No fractional opacity animation over LiquidGlass/Blur; springs/durations from `context/theme/motion.ts`; `PressableScale` for buttons; Celebration component NOT used.
- i18n: every user-visible string via `context/i18n/translations.tsx`, flat snake_case `vault_*` keys, en block authoritative + all 12 other languages.
- Never log key material, PINs, or ECDH secrets. Zero `V` (vault key bytes) after use where feasible.
- Commit after every green task; conventional commits `feat(vault): …` / `test(vault): …`.

---

### Task 1: Sealing crypto (pure TS) — HKDF + seal/unseal

**Files:**
- Create: `services/vault/sealing.ts`
- Create: `services/vault/types.ts`
- Test: `__tests__/vault/sealing.test.ts`
- Modify: `package.json` (add `@noble/curves: ^2.0.1` — check installed version with `npm view @noble/curves version`, pin caret at current major)

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  export interface SealedBlob {
    v: 1
    slot: number                 // 0x82
    ePub: string                 // hex, 65-byte uncompressed SEC1 P-256 point
    salt: string                 // hex, 32 bytes
    c: string                    // hex, SymmetricKey AES-GCM output (iv|ct|tag)
    yubiSerial: string
    yubiPubSha256: string        // hex sha256 of token pubkey (sanity check)
  }
  export type VaultErrorCode =
    | 'unsupported-platform' | 'no-key' | 'wrong-key' | 'pin-required'
    | 'pin-invalid' | 'pin-locked' | 'touch-timeout' | 'key-removed-mid-op'
    | 'mgmt-key-custom' | 'slot-occupied' | 'seal-corrupt' | 'serial-mismatch'
    | 'user-cancelled' | 'not-enrolled' | 'driver-unavailable'
  export class VaultError extends Error {
    constructor(public code: VaultErrorCode, message?: string, public retriesLeft?: number)
  }
  // sealing.ts
  export function hkdfSha256(ikm: number[], salt: number[], info: string, length?: number): number[]
  export function sealVaultKey(v: number[], yubiPubHex: string, meta: { slot: number; serial: string }): SealedBlob
  export function unsealVaultKey(blob: SealedBlob, sharedSecretHex: string): number[]  // throws VaultError('seal-corrupt')
  export function softwareEcdh(privHex: string, pubHex: string): string // hex x-coord, 32B — used by seal + mock
  ```

- [ ] **Step 1: Write failing tests** — RFC 5869 HKDF vectors (Test Case 1 & 2), seal→unseal round-trip (software ECDH both sides), tamper detection (flip byte in `c` → `seal-corrupt`), wrong shared secret → `seal-corrupt`, ePub is valid P-256 point, output lengths.

```ts
import { p256 } from '@noble/curves/nist'
import { hkdfSha256, sealVaultKey, unsealVaultKey, softwareEcdh } from '../../services/vault/sealing'

test('hkdf rfc5869 case 1', () => {
  const ikm = Array(22).fill(0x0b)
  const salt = Array.from({length:13},(_,i)=>i)
  const okm = hkdfSha256(ikm, salt, '', 42)   // info = 0xf0..f9 in the RFC — encode via bytes overload or hex helper
  // expected OKM: 3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865
})
test('seal/unseal round trip', () => {
  const yubi = p256.keygen()   // simulates on-token key
  const v = Array.from(crypto.getRandomValues(new Uint8Array(32)))
  const blob = sealVaultKey(v, hex(yubi.publicKey), { slot: 0x82, serial: '12345678' })
  const shared = softwareEcdh(hex(yubi.secretKey), blob.ePub)  // what the token computes
  expect(unsealVaultKey(blob, shared)).toEqual(v)
})
```

(Note: RFC 5869 info is bytes `f0f1…f9`; give `hkdfSha256` a `number[] | string` info overload, string = UTF-8.)

- [ ] **Step 2: Run** `npx jest __tests__/vault/sealing.test.ts` — expect module-not-found failures.
- [ ] **Step 3: Implement.** HKDF per RFC 5869 over `@bsv/sdk` `Hash.sha256hmac`. `softwareEcdh` = `p256.getSharedSecret(priv, pub, false).slice(1, 33)` (x-coordinate). `sealVaultKey`: ephemeral `p256.keygen()` (or `utils.randomSecretKey`), shared = softwareEcdh(ephPriv, yubiPub), KEK = hkdf(shared, salt32, 'bsvb-vault-seal-v1'), `new SymmetricKey(KEK).encrypt(v)`. Random bytes via a tiny `randomBytes(n)` helper that prefers `expo-crypto` and falls back to `crypto.getRandomValues` under Jest.
- [ ] **Step 4: Run tests** — PASS.
- [ ] **Step 5: Commit** `feat(vault): sealing crypto (HKDF-SHA256 + P-256 ECDH seal/unseal)`

### Task 2: Vault store — persistence of seal + metadata

**Files:**
- Create: `services/vault/vaultStore.ts`
- Test: `__tests__/vault/vaultStore.test.ts` (mock expo-secure-store + AsyncStorage — jest moduleNameMapper/mocks already exist in repo for AsyncStorage)

**Interfaces:**
- Produces:
  ```ts
  export interface VaultMeta {
    v: 1
    enrolledAt: number
    yubiSerial: string
    nickname: string
    slot: number
    nextKeyIndex: number                     // next unused vault/<n>
    depositKeys: { keyID: string; pkh: string }[]   // hex hash160 queue
    lastUsedAt?: number
  }
  export const vaultStore: {
    isEnrolled(): Promise<boolean>
    getSeal(): Promise<SealedBlob | null>          // SecureStore 'vault_seal_v1'
    setSeal(b: SealedBlob): Promise<void>
    getMeta(): Promise<VaultMeta | null>           // AsyncStorage 'vault_meta_v1'
    setMeta(m: VaultMeta): Promise<void>
    popDepositKey(): Promise<{ keyID: string; pkh: string } | null>  // pops + persists
    pushDepositKeys(keys: {keyID:string; pkh:string}[], nextKeyIndex: number): Promise<void>
    clear(): Promise<void>                          // disable vault
  }
  ```
- SecureStore options: `{ keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }` — same as mnemonic (LocalStorageProvider.tsx:122-137). No biometric gate here (ceremony IS the gate); do not route through LocalStorageProvider's ensureAuth.

- [ ] **Step 1: Tests** — round-trip seal + meta, isEnrolled false→true, popDepositKey drains then null, clear() removes both.
- [ ] **Step 2: Run — fail. Step 3: Implement. Step 4: Run — pass.**
- [ ] **Step 5: Commit** `feat(vault): sealed-blob + metadata persistence`

### Task 3: Native module package scaffold — `packages/react-native-yubikey`

**Files:**
- Create: `packages/react-native-yubikey/package.json`, `nitro.json`, `YubiKeyPiv.podspec`, `tsconfig.json`
- Create: `packages/react-native-yubikey/src/specs/YubiKeyPiv.nitro.ts`, `src/index.ts`, `src/types.ts`
- Create: `packages/react-native-yubikey/ios/HybridYubiKeyPiv.swift`
- Create: `packages/react-native-yubikey/android/build.gradle`, `android/src/main/AndroidManifest.xml`, `android/src/main/java/com/margelo/nitro/yubikeypiv/YubiKeyPivPackage.kt`, `.../HybridYubiKeyPiv.kt`
- Create: committed `packages/react-native-yubikey/nitrogen/generated/**` (run nitrogen)
- Modify: root `package.json` (`"react-native-yubikey": "file:./packages/react-native-yubikey"`)
- Verify (no edit expected): `.gitignore` + `.easignore` negations `!/packages/**/android` + `!/packages/**/android/**` already cover the new dir — prove with `git ls-files --exclude-from .easignore --ignored --cached | grep react-native-yubikey` (must print nothing after `git add`).

**Interfaces:**
- Produces (Nitro spec — exact):
  ```ts
  // src/specs/YubiKeyPiv.nitro.ts
  import type { HybridObject } from 'react-native-nitro-modules'
  export interface YubiKeyPiv extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
    isSupported(): boolean
    startDiscovery(): void
    stopDiscovery(): void
    setKeyListener(listener: (eventType: string, serial: string, transport: string) => void): void
    clearKeyListener(): void
    getKeyInfo(): Promise<string>       // JSON: {serial, firmwareVersion, pinRetries}
    verifyPin(pin: string): Promise<string>            // JSON: {ok, retriesLeft}
    changePin(oldPin: string, newPin: string): Promise<string>
    generateVaultKey(slot: number, touchPolicy: string, pinPolicy: string): Promise<string>  // JSON: {publicKey} 65B SEC1 hex
    readVaultPublicKey(slot: number): Promise<string>  // JSON: {publicKey} or {publicKey:null}
    ecdh(slot: number, pin: string, peerPublicKey: string): Promise<string>  // JSON: {secret} 32B hex x-coord; touch-gated
    // errors reject with message `VAULT_ERR:<code>:<detail>` — TS layer parses to VaultError
  }
  ```
  JSON-string returns keep the Nitro surface primitive-only (same dodge localpay uses for structs it doesn't share).
- iOS impl: pod dep `s.dependency 'YubiKit', '~> 4.7'`; `YKFSmartCardConnection` session; `YKFPIVSession` `verifyPin`, `generateKeyInSlot(.init(rawValue: 0x82), type: .ECCP256, pinPolicy:, touchPolicy:)`, `calculateSecretKeyInSlot(peerPublicKey:)`; management key: try firmware default (TDES `010203…` fw<5.7, AES-192 default fw≥5.7) → on auth failure reject `VAULT_ERR:mgmt-key-custom`. `isSupported` = `#available(iOS 16, *)`.
- Android impl: gradle deps `com.yubico.yubikit:android:3.2.0`, `com.yubico.yubikit:piv:3.2.0`; `YubiKitManager.startUsbDiscovery(UsbConfiguration(), listener)` + best-effort `startNfcDiscovery`; `device.requestConnection(SmartCardConnection::class.java)` → `PivSession`; `generateKey(Slot.RETIRED1…, KeyType.ECCP256, PinPolicy.ONCE, TouchPolicy.ALWAYS)`; `calculateSecret(slot, publicKeyValues)`. Manifest: `<uses-feature android:name="android.hardware.usb.host" android:required="false"/>`, `<uses-permission android:name="android.permission.NFC"/>` (+`<uses-feature android:name="android.hardware.nfc" android:required="false"/>`).
- Kotlin package class: empty `ReactPackage` with companion-init pattern **copied from LocalPayTransportPackage.kt including the load-bearing comment** (no C++ here, so init only ensures Nitro autolinking registration — mirror whatever LocalPayTransport's generated autolinking requires; no `System.loadLibrary` needed for pure-Kotlin Nitro? — nitrogen generates it; follow generated `YubiKeyPiv+autolinking.gradle`).
- `src/index.ts`: `export function getYubiKeyPiv(): YubiKeyPiv | null` — lazy, try/catch `NitroModules.createHybridObject<YubiKeyPiv>('YubiKeyPiv')`, null on web/jest/missing native (clone localpay-transport getter shape).

- [ ] **Step 1:** Scaffold package files; copy localpay-transport's package.json/nitro.json/podspec/build.gradle shapes; write the spec + Swift + Kotlin implementations.
- [ ] **Step 2:** `cd packages/react-native-yubikey && npx nitrogen` (or `npm run codegen` matching localpay's script) — commit generated glue.
- [ ] **Step 3:** Root `npm install` (materializes file: dep). `npx tsc --noEmit` on the package (its own tsconfig) and root.
- [ ] **Step 4:** Ignore-file verification command above; `npx jest __tests__` still green (getter returns null under Jest).
- [ ] **Step 5: Commit** `feat(vault): react-native-yubikey Nitro module (PIV over CCID, iOS+Android)`

### Task 4: Driver abstraction + software mock

**Files:**
- Create: `services/vault/driver.ts` (driver selection + VaultError parsing + event fan-out)
- Create: `services/vault/mockYubiKey.ts`
- Test: `__tests__/vault/mockYubiKey.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // driver.ts — the ONLY surface the rest of vault code sees
  export interface VaultDriver {
    isSupported(): boolean
    start(): void
    stop(): void
    onKeyEvent(cb: (e: { type: 'attached' | 'detached'; serial?: string; transport: 'usb' | 'nfc' | 'mock' }) => void): () => void
    getKeyInfo(): Promise<{ serial: string; firmwareVersion: string; pinRetries: number }>
    verifyPin(pin: string): Promise<{ ok: boolean; retriesLeft: number }>
    changePin(oldPin: string, newPin: string): Promise<{ ok: boolean; retriesLeft: number }>
    generateVaultKey(slot: number): Promise<{ publicKey: string }>
    readVaultPublicKey(slot: number): Promise<{ publicKey: string } | null>
    ecdh(slot: number, pin: string, peerPublicKey: string): Promise<{ secret: string }>
  }
  export function getVaultDriver(): VaultDriver | null      // real > mock(dev toggle) > null
  export function setMockDriverEnabled(on: boolean): void   // DEV settings toggle, AsyncStorage-backed
  ```
- Mock: software P-256 key per "inserted" virtual token; `mock.insertKey(serial)` / `mock.removeKey()` / `mock.setTouchBehavior('instant'|'delay'|'timeout')` / PIN '123456' default with retry counting → exposes same VaultDriver + test controls. ECDH via `softwareEcdh` from Task 1.

- [ ] **Step 1: Tests** — mock full happy path (insert→pin→generate→ecdh matches softwareEcdh), pin retries decrement + lock at 0, touch timeout → VaultError('touch-timeout'), detach mid-op → 'key-removed-mid-op', driver.getVaultDriver() null under jest unless mock enabled.
- [ ] **Steps 2-4:** fail → implement → pass.
- [ ] **Step 5: Commit** `feat(vault): driver abstraction + software mock YubiKey`

### Task 5: Ceremony controller (UI-free state machine)

**Files:**
- Create: `services/vault/ceremony.ts`
- Test: `__tests__/vault/ceremony.test.ts` (drive with mock driver + fake store)

**Interfaces:**
- Consumes: `VaultDriver`, `vaultStore`, `unsealVaultKey`.
- Produces:
  ```ts
  export type CeremonyPhase = 'idle' | 'waiting-for-key' | 'connecting' | 'pin-entry'
    | 'awaiting-touch' | 'unsealing' | 'armed' | 'error'
  export interface CeremonyState {
    phase: CeremonyPhase
    reason?: string            // privilegedReason / transfer summary shown in sheet
    error?: { code: VaultErrorCode; retriesLeft?: number }
    armedUntil?: number        // epoch ms, for countdown chip
  }
  export class CeremonyController {
    constructor(deps: { getDriver: () => VaultDriver | null; store: typeof vaultStore; retentionMs: number })
    subscribe(cb: (s: CeremonyState) => void): () => void
    request(reason: string): Promise<PrivateKey>   // concurrent calls share one ceremony
    submitPin(pin: string): void
    cancel(): void                                  // rejects pending with 'user-cancelled'
    notifyKeyDetached(): void                       // → onRelock hook fires
    onArmed?: (key: PrivateKey) => void             // transfers replenish hook
    onRelock?: (why: 'timeout' | 'detached' | 'manual') => void
  }
  export const ceremony: CeremonyController        // module singleton (imperative-host pattern, like showAlert)
  export function requestCeremony(reason: string): Promise<PrivateKey>
  ```
- Transition rules: `request()` → if driver null → reject 'driver-unavailable'; start discovery; already-attached key skips waiting; serial ≠ seal.yubiSerial → error 'serial-mismatch' (stay in error, allow retry on key swap); PIN wrong → back to pin-entry with retriesLeft; touch timeout → error 'touch-timeout' with Retry (re-runs ecdh; PIN cached by pinPolicy=once so no re-prompt within session); success → phase 'armed', schedules `armedUntil = now + retentionMs`, resolves ALL queued requesters, fires onArmed. 'armed' phase auto-returns to 'idle' at armedUntil (UI countdown), controller does NOT hold the key (PKM does).

- [ ] **Step 1: Tests** — full transition table incl.: two concurrent request() resolve from one ceremony; cancel rejects; detach during awaiting-touch → 'key-removed-mid-op' error then retry works after re-insert; wrong serial; pin lockout surfaces 'pin-locked'; armed→idle timer (jest fake timers); onRelock('detached') when notifyKeyDetached during armed window.
- [ ] **Steps 2-4:** fail → implement → pass.
- [ ] **Step 5: Commit** `feat(vault): ceremony controller state machine`

### Task 6: VaultKeyService — enroll / recover / disable + PKM keyGetter

**Files:**
- Create: `services/vault/VaultKeyService.ts`
- Create: `services/vault/privileged.ts`
- Test: `__tests__/vault/vaultKeyService.test.ts`, `__tests__/vault/privileged.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // VaultKeyService.ts
  export async function enrollVault(args: {
    nickname: string
    onPhase: (p: 'connecting'|'pin-check'|'generating'|'sealing'|'done') => void
    requestPinChange?: (retries: number) => Promise<{ oldPin: string; newPin: string }>
    getPin: () => Promise<string>
  }): Promise<{ backupMnemonic: string }>          // BIP39 24 words of V (@bsv/sdk Mnemonic.fromEntropy)
  export async function recoverVaultKey(mnemonic: string): Promise<PrivateKey>   // phrase → V
  export async function resealToNewKey(v: PrivateKey, nickname: string, getPin: () => Promise<string>): Promise<void>
  export async function disableVault(): Promise<void>   // clear() only — sweep handled by transfers first
  // privileged.ts
  export function makePrivilegedKeyGetter(opts: {
    getLegacyRootKey: () => PrivateKey
  }): (reason: string) => Promise<PrivateKey>
  // not enrolled → legacy root key; enrolled → requestCeremony(reason)
  export const VAULT_RETENTION_MS = 120_000
  ```
- enroll: driver.getKeyInfo → default-PIN probe (verifyPin('123456'): ok → force requestPinChange) → generateVaultKey(0x82) (touch) → V = randomBytes(32) (re-roll if ≥ secp256k1 order — compare against `PrivateKey` validity) → sealVaultKey → vaultStore.setSeal/setMeta → mnemonic = Mnemonic.fromEntropy? (verify sdk API: `Mnemonic.fromEntropy(entropy)`; fallback `Mnemonic.fromSeed`-style — whichever encodes 32 bytes ↔ 24 words losslessly, must round-trip in test) → return; zero V array.
- Enrollment doesn't arm PKM; deposit-key queue seeds on first ceremony (Task 7 hook) OR immediately post-enroll via a temporary in-memory ProtoWallet-style derivation from V **before zeroing** — do it immediately: derive 64 pubkeys from V directly with `KeyDeriver(new PrivateKey(V))` (protocolID [2,'vault'], keyID vault/0..63, counterparty self) then zero V. No extra touch at enroll.

- [ ] **Step 1: Tests** — enroll happy path against mock (seal stored, meta correct, 64 deposit keys queued, mnemonic round-trips to V — capture V via mock ecdh + unseal in test); default-PIN forces change; recover(mnemonic) == V; keyGetter: not enrolled → root key identity; enrolled → resolves via ceremony (mock) and returns PrivateKey whose derived pubkeys match the enroll-time queue.
- [ ] **Steps 2-4:** fail → implement → pass.
- [ ] **Step 5: Commit** `feat(vault): enrollment, recovery, and privileged keyGetter`

### Task 7: WalletContext wiring + relock-on-unplug

**Files:**
- Modify: `context/WalletContext.tsx:1219-1222` and `:1266-1268` (both PKM constructions)
- Modify: `context/WalletContext.tsx` (managers effect: start driver discovery + detach subscription once wallet built)
- Test: `__tests__/vault/privileged.test.ts` (extend — factory used identically in both paths; no WalletContext render test needed, logic lives in privileged.ts)

**Interfaces:**
- Consumes: `makePrivilegedKeyGetter`, `VAULT_RETENTION_MS`, `ceremony`.
- Replacement (mnemonic path; recovered-key path mirrors with `recoveredKey`):
  ```ts
  const privilegedKeyManager = new PrivilegedKeyManager(
    makePrivilegedKeyGetter({ getLegacyRootKey: () => rootKey }),
    VAULT_RETENTION_MS
  )
  ```
- Relock: one effect after managers set — `driver.onKeyEvent(e => { if (e.type === 'detached') { pkmRef.current?.destroyKey(); ceremony.notifyKeyDetached() } })`. Keep a ref to the PKM created in build path.
- `ceremony.onRelock` → `sounds.vaultClose()` + `haptics.confirm()` + toast `t('vault_locked')` (wired in Task 10's context, hook the callback there — WalletContext stays sound-free).

- [ ] **Step 1:** Extend privileged tests (both key types). **Step 2-4:** fail → implement → pass; full suite `npx jest` green; `npx tsc --noEmit` green.
- [ ] **Step 5: Commit** `feat(vault): wire ceremony-backed PrivilegedKeyManager into wallet build`

### Task 8: Transfers — deposit, withdraw, balance, key queue replenish

**Files:**
- Create: `services/vault/transfers.ts`
- Test: `__tests__/vault/transfers.test.ts` (fake permissionsManager capturing args; real @bsv/sdk for script/sighash verification)

**Interfaces:**
- Consumes: `vaultStore`, `ceremony.onArmed`, permissionsManager via injection.
- Produces:
  ```ts
  export interface VaultWallet {   // subset of WalletInterface we call, injected
    createAction(args: any, originator: string): Promise<any>
    signAction(args: any, originator: string): Promise<any>
    listOutputs(args: any, originator: string): Promise<any>
    getPublicKey(args: any, originator: string): Promise<{ publicKey: string }>
    createSignature(args: any, originator: string): Promise<{ signature: number[] }>
    abortAction(args: any, originator: string): Promise<any>
  }
  export const VAULT_BASKET = 'admin vault'
  export const VAULT_PROTOCOL: [2, string] = [2, 'vault']
  export async function getVaultBalance(w: VaultWallet, adminOriginator: string): Promise<number>
  export async function depositToVault(w: VaultWallet, adminOriginator: string, satoshis: number): Promise<{ txid: string }>
  export async function withdrawFromVault(w: VaultWallet, adminOriginator: string, satoshis: number | 'all', reason: string): Promise<{ txid: string }>
  export async function replenishDepositKeys(w: VaultWallet, adminOriginator: string): Promise<void>  // ceremony.onArmed hook; tops queue to 64 via privileged getPublicKey
  export async function sweepVaultWithKey(w: VaultWallet, adminOriginator: string, v: PrivateKey): Promise<{ txid: string } | null>  // recovery path: signs directly with V
  ```
- deposit: `popDepositKey()` (null → throw VaultError('not-enrolled') if no meta, or trigger replenish-needed error `'pin-required'`? NO — distinct behavior: queue empty → caller runs ceremony then replenish then retry); `createAction({ description: 'Move to vault', outputs: [{ lockingScript: new P2PKH().lock(pkh).toHex(), satoshis, basket: VAULT_BASKET, outputDescription: 'Vault deposit', customInstructions: JSON.stringify({ v: 1, keyID }), tags: ['vault'] }], labels: ['vault', 'vault-deposit'] }, adminOriginator)`.
- withdraw: `listOutputs({ basket: VAULT_BASKET, include: 'entire transactions', limit: 1000 }, adminOriginator)` → outputs with `customInstructions.keyID`, `outpoint`, `satoshis`, result `.BEEF`; select oldest-first covering amount (or all); remainder = selected − amount; outputs = remainder > 546 ? one fresh vault deposit output for remainder : []; `createAction({ description: reason, inputBEEF, inputs: sel.map(o => ({ outpoint: o.outpoint, unlockingScriptLength: 108, inputDescription: 'Vault withdrawal' })), outputs, labels: ['vault','vault-withdraw'], options: { randomizeOutputs: false } }, adminOriginator)` → `signableTransaction { tx, reference }`; `Transaction.fromAtomicBEEF(tx)`; per input i: derived pubkey = `getPublicKey({ privileged: true, privilegedReason: reason, protocolID: VAULT_PROTOCOL, keyID, counterparty: 'self', forSelf: true }, adminOriginator)`; preimage = `TransactionSignature.format({ sourceTXID, sourceOutputIndex, sourceSatoshis, transactionVersion: tx.version, otherInputs, inputIndex: i, outputs: tx.outputs, inputSequence: input.sequence, subscript: P2PKH().lock(hash160(pubkey)), lockTime: tx.lockTime, scope: TransactionSignature.SIGHASH_ALL | SIGHASH_FORKID })`; `hashToDirectlySign = sha256(sha256(preimage))` ⚠ verify single-vs-double against sdk P2PKH.unlock source in Step 1's test (test validates the finished input with sdk `Spend` — the test, not the plan, is the arbiter); `createSignature({ hashToDirectlySign, protocolID: VAULT_PROTOCOL, keyID, counterparty: 'self', privileged: true, privilegedReason: reason }, adminOriginator)` → DER sig + append scope byte → `new UnlockingScript([pushSig, pushPubkey])`; `signAction({ reference, spends: { [i]: { unlockingScript } } }, adminOriginator)`. On any throw after createAction: `abortAction({ reference })` then rethrow.
- Fake wallet in tests: implements VaultWallet with an in-memory ledger; `createSignature` derives from a fixed test V via KeyDeriver (mirrors PKM behavior — same derivation the real PKM does); test asserts the assembled unlocking script **actually validates** via `new Spend({...}).validate()` against the lock script for a constructed source tx.

- [ ] **Step 1: Tests** — deposit args exact (basket, customInstructions, labels); queue drains; withdraw: selection oldest-first, partial withdraw creates vault change-back output, full 'all' has outputs []; unlock script validates with sdk Spend (this pins the sighash single/double question empirically); abortAction on signature failure; replenish tops to 64 with monotonically increasing keyIDs; sweepVaultWithKey signs everything with raw V.
- [ ] **Steps 2-4:** fail → implement → pass.
- [ ] **Step 5: Commit** `feat(vault): internal transfers between default and vault baskets`

### Task 9: Sounds + haptic pairings

**Files:**
- Create: `scripts/generate-vault-sounds.mjs` (pure Node WAV synthesis, no deps)
- Create: `assets/sounds/vault-open.wav`, `assets/sounds/vault-close.wav` (committed output)
- Modify: `hooks/useConfirmationSound.ts` → generalize internal player cache to `playTone(assetId)`; export `sounds.vaultOpen`, `sounds.vaultClose` (keep `sounds.confirmation`/`release` API identical)
- Test: `__tests__/useConfirmationSound.test.ts` (extend: new tones lazy-load, never throw, share audio-mode init)

**Interfaces:**
- Produces: `sounds.vaultOpen(): void`, `sounds.vaultClose(): void`.
- Sound design (spec §5.3): vault-open ~0.7 s D3→F3 soft-mallet dyad + faint metallic tail, peak ≤ −6 dBFS; vault-close ~0.5 s single A2 thunk, fast decay. Synthesis: sine partials + exponential envelopes, 44.1 kHz 16-bit mono; script writes RIFF header by hand.
- Pairing rule (doc comment): vaultOpen ↔ haptics.success (ceremony 'armed'); vaultClose ↔ haptics.confirm (relock). Never fire one for the other; never alongside Toast(success) auto-haptic.

- [ ] **Step 1:** Write generator; run `node scripts/generate-vault-sounds.mjs`; commit wavs. Listen-check waveform stats (duration, peak) in script output.
- [ ] **Step 2:** Extend sound module tests → fail. **Step 3:** refactor module (multi-tone map, single audio-mode latch, per-tone player cache). **Step 4:** pass.
- [ ] **Step 5: Commit** `feat(vault): vault-open/vault-close tones + generator`

### Task 10: Ceremony sheet + vault React context

**Files:**
- Create: `context/VaultContext.tsx` (subscribes to `ceremony`, exposes state + submitPin/cancel; wires onArmed → replenishDepositKeys + sounds.vaultOpen + haptics.success; onRelock → sounds.vaultClose + haptics.confirm + toast)
- Create: `components/vault/VaultCeremonySheet.tsx` (Sheet-based, global)
- Modify: `app/_layout.tsx` (mount `<VaultCeremonySheet/>` beside PermissionSheet; wrap with VaultProvider)
- Modify: `context/i18n/translations.tsx` (en block: all `vault_*` keys used below)
- Test: `__tests__/vault/vaultContext.test.tsx` (react-test-renderer pattern used elsewhere in repo; assert state plumbing + sound/haptic firing via jest mocks)

**Interfaces:**
- Consumes: `ceremony`, `sounds`, `haptics`, `Sheet`, theme/motion tokens.
- Produces: `useVault(): { state: CeremonyState; submitPin(p: string): void; cancel(): void }`.
- Sheet content per phase (copy = i18n keys): waiting-for-key `vault_insert_key` + port illustration (static SVG/Ionicons composition, pulse via scale loop ≤ springs.settle, reduced-motion → static); connecting `vault_reading_key`; pin-entry `vault_enter_pin` + secure TextInput + `vault_pin_retries` when retriesLeft < 3; awaiting-touch `vault_touch_contact` + 15 s countdown ring (Reanimated, UI-thread) + pulsing gold disc; unsealing `vault_unlocking`; armed → sheet dismisses, `/vault` shows countdown chip `vault_unlocked_until`; error states: `vault_err_wrong_key` (+ serial), `vault_err_touch_timeout` + retry button, `vault_err_pin_locked` → link to recovery, `vault_err_removed`, generic `vault_err_generic`. Reason line always visible: `state.reason`.
- Haptics: attach → `tap`; pin ok → `confirm`; pin fail → `error`; touch start → `tap`; armed → success (fired in context with vaultOpen); errors → `warning`.

- [ ] **Step 1:** Tests (context wiring, sound/haptic pairing rules). **Steps 2-4:** fail → implement → pass.
- [ ] **Step 5: Commit** `feat(vault): ceremony sheet + vault context with sounds/haptics`

### Task 11: /vault screen, enrollment wizard, transfer UI, settings entry

**Files:**
- Create: `app/vault.tsx` (route: hero/enroll state OR balance + deposit/withdraw + key card + activity)
- Create: `components/vault/EnrollWizard.tsx` (intro → insert → PIN change if factory → generate (touch) → backup phrase → confirm quiz → done)
- Create: `components/vault/TransferSheet.tsx` (amount via `AmountInput`/`AmountDisplay`, direction, confirm; deposit runs immediately, withdraw runs `requestCeremony` first)
- Create: `hooks/useVaultBalance.ts` (listOutputs sum; refresh on `txStatusVersion` + after transfers)
- Modify: `app/wallet-config.tsx` (Data & Security section: ListRow `vault_row_title`, icon `lock-closed`, → `/vault`; hidden when `!driver?.isSupported() && !__DEV__`)
- Modify: `app/settings.tsx` (Activity section row → `/vault` when enrolled)
- Modify: `context/i18n/translations.tsx` (en keys for all of the above)
- Test: `__tests__/vault/useVaultBalance.test.ts`

**Interfaces:**
- Consumes: `useVault`, transfers API, `useWalletContext` (`managers.permissionsManager`, `adminOriginator`, `txStatusVersion` selector hooks), GroupedList/ListRow/PressableScale/Sheet, EnrollWizard consumes `enrollVault`/`recoverVaultKey`.
- Backup-phrase step reuses the reveal-then-confirm interaction from `app/auth/mnemonic.tsx` (grid of words, then confirm 3 random positions); copy warns `vault_backup_warning`.
- Withdraw reason string (shown in ceremony sheet): `t('vault_withdraw_reason', { amount })` — e.g. "Withdraw 12 500 sats from vault".

- [ ] **Step 1:** useVaultBalance tests. **Steps 2-4:** fail → implement screens → pass; `npx tsc --noEmit` green.
- [ ] **Step 5: Commit** `feat(vault): vault screen, enrollment wizard, transfers UI`

### Task 12: iOS entitlement plugin, app config, dev toggle, i18n sweep, verify

**Files:**
- Create: `plugins/withSmartCardEntitlement.js` (withEntitlementsPlist → `com.apple.security.smartcard: true`)
- Modify: `app.json` (plugins array + nothing else)
- Modify: `ios/BSVBrowser/BSVBrowser.entitlements` (add the key — tracked project must not drift from prebuild)
- Modify: `app/wallet-config.tsx` (DEV-only ListRow toggle "Mock YubiKey" → `setMockDriverEnabled`)
- Modify: `context/i18n/translations.tsx` (add `vault_*` keys to zh/hi/es/fr/ar/pt/bn/ru/id/ja/pl — machine translations; en already done)
- Test: full suite + typecheck + lint

**Steps:**
- [ ] **Step 1:** Plugin (clone `withWebBrowserEntitlement.js` shape) + entitlements edit + app.json.
- [ ] **Step 2:** DEV mock toggle row.
- [ ] **Step 3:** i18n: translate the en `vault_*` block into the 12 other blocks (subagent-friendly; mark with `// vault (machine-translated, needs native review)` comment).
- [ ] **Step 4:** `npx tsc --noEmit && npx jest && npx expo lint` — all green. Ignore-file verification command re-run.
- [ ] **Step 5: Commit** `feat(vault): smartcard entitlement, dev mock toggle, i18n`

### Task 13 (pending hardware — NOT this session): device matrix

Enroll/deposit/withdraw/unplug/PIN-lockout on iPhone 15+ (USB-C), Android USB-C, Android NFC (5C NFC); EAS build with entitlement through a real Deliver upload (ITMS-90683 precedent). Tracked as follow-up; blocks release, not merge to feature branch.

## Self-review notes

- Spec §4.2 mgmt-key detection: folded into Task 3 (native) + surfaced as `mgmt-key-custom` in Task 4/5 error paths. ✓
- Spec §4.5 disable/recover: Task 6 (service) + Task 11 wizard entry points (recovery via overflow menu → phrase input → `sweepVaultWithKey` or `resealToNewKey`). ✓
- Spec §6 "never log": enforced by convention; sealing/ceremony files carry a header comment. ✓
- Sighash single-vs-double SHA256 ambiguity: resolved empirically by Task 8's Spend-validation test — implementation must satisfy the interpreter, not an assumption. ✓
- Type check: `CeremonyState`/`VaultDriver`/`SealedBlob` names consistent across Tasks 1-10. ✓
