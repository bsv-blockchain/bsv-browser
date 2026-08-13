# YubiKey Vault — Design Spec

**Date:** 2026-08-12
**Status:** Approved for implementation (autonomous session; user review pending)
**Feature branch:** `feat/yubikey-vault`

## 1. Summary

A high-value **Vault** inside the BSV Browser wallet, cryptographically gated by a
YubiKey 5C. Funds moved into the vault are locked to keys derived from a dedicated
**vault privileged key** that exists in plaintext only (a) for a bounded retention
window after a physical YubiKey ceremony (insert → PIN → touch), or (b) as an
offline paper backup. The BRC-100 `privileged: true` key universe is re-pointed at
this key, so privileged derivations and signing anywhere in the wallet — including
requests from in-tab web apps — require the YubiKey ceremony.

Deposits into the vault are ordinary wallet payments and need **no YubiKey**.
Withdrawals require the ceremony. Both directions are internal transfers between
the `default` change basket and the `admin vault` basket.

## 2. Research verdicts that shape the design

These were verified against Yubico source/docs and the SDKs on disk (see
`docs/superpowers/specs/` research references; full reports in session archive):

1. **FIDO2 hmac-secret is unreachable on iPhone + YubiKey 5C.** Over USB the FIDO
   applet is HID-only (iOS gives apps no USB-HID API); the 5C has no NFC; Apple's
   ASAuthorization strips PRF/extension data for roaming authenticators. Dead end.
2. **PIV over CCID works on both platforms.**
   - iOS 16+: `YKFSmartCardConnection` (yubikit-ios ≥ 4.3, built on
     CryptoTokenKit/TKSmartCard) with the `com.apple.security.smartcard`
     entitlement. Smart-card applets only — exactly what we need (PIV).
   - Android: `com.yubico.yubikit:android` + `:piv` 3.2.0 — USB CCID
     (`UsbYubiKeyDevice` → `SmartCardConnection`) with SDK-managed permission
     dialog, plus NFC for NFC-capable keys. minSdk 21.
3. **PIV has no secp256k1** (P-256/P-384/RSA only). Therefore the token cannot sign
   BSV transactions. Every shipping product (age-plugin-yubikey, systemd-cryptenroll
   PKCS#11, Casa) uses a **wrap/gate pattern**: the token holds a P-256 key whose
   on-token ECDH unwraps the actual secret. We do the same.
4. **PIV ECDH is available in both SDKs**: `calculateSecretKeyInSlot:` (iOS) /
   `PivSession.calculateSecret(slot, peerPublicKey)` (Android), honoring the
   slot's PIN and touch policy. Touch policy ALWAYS = physical touch per
   operation, ~15 s timeout, key LED blinks while waiting.
5. **PIN/touch policies are immutable after keygen**; PIN retry 3 → PUK retry 3 →
   PIV applet reset (keys wiped). A YubiKey-only vault can brick funds → an
   independent recovery path is mandatory.
6. **The app already wires `PrivilegedKeyManager`** degenerately
   (`WalletContext.tsx:1221,1267` — keyGetter returns the root key). The toolbox
   `Wallet` routes every `privileged: true` BRC-100 call (getPublicKey, encrypt,
   decrypt, create/verify Hmac, create/verify Signature, key linkage) through it,
   with `privilegedReason` passed to the keyGetter and a 120 s retention window
   with scheduled destruction. `WalletPermissionsManager` is already configured
   with `differentiatePrivilegedOperations: true`.
7. **Baskets:** the app's spendable balance and change allocation are scoped to
   the `default` basket; outputs in a named basket are invisible to the balance
   spec-op and never auto-spent. Basket names starting with `admin` are reserved
   to the admin originator by `WalletPermissionsManager.isAdminBasket()` — web
   pages cannot list, insert into, or relinquish them.
8. **No RN wrapper worth depending on** (`react-native-yubikit` abandoned 2020;
   `@doko/react-native-yubikit` is 0.0.4/3-star New-Arch-only — reference code
   only). We build our own Nitro module following the in-repo
   `packages/react-native-localpay-transport` pattern.

## 3. Alternatives considered

- **FIDO2 hmac-secret (+largeBlob)** — rejected: iOS dead end (verdict 1). Would
  also make deposits require the token (symmetric secret), worse UX.
- **OTP applet HMAC-SHA1 challenge-response** (KeePassXC model) — works, simpler,
  but symmetric (deposits would need the key or a cached secret), only 2 OTP
  slots (user may already use them), weaker ceremony semantics (no PIN policy,
  no per-slot policies). Rejected in favor of PIV ECDH.
- **OpenPGP applet secp256k1 on-token signing** (fw ≥ 5.2.3) — on-token signing of
  actual transaction inputs. Rejected for v1: OpenPGP applet support in the
  mobile SDKs is thin, one signature per touch makes multi-input spends
  miserable, and key backup/rotation stories are worse. The wrap/gate pattern is
  the proven design. Revisit only if per-input hardware signing becomes a
  requirement.
- **Policy-only gating** (keep root-derived keys, just prompt) — rejected: not a
  cryptographic guarantee; malware with the root key ignores policy.

## 4. Architecture

```
┌────────────────────────────── UI layer ──────────────────────────────┐
│ /vault screen        VaultCeremonySheet         wallet-config rows   │
│ (balance, deposit,   (insert → PIN → touch      (enroll, recovery,   │
│  withdraw, activity)  state machine + sound/     disable)            │
│                       haptics)                                       │
└───────────────┬──────────────────┬───────────────────────────────────┘
                │                  │ ceremony requests (promise)
┌───────────────▼──────────────────▼───────────────────────────────────┐
│ services/vault/                                                      │
│  VaultKeyService  — enroll / seal / unseal / recover / disable       │
│  VaultTransfers   — deposit (default→vault), withdraw (vault→default)│
│  vaultStore       — sealed blob + metadata (SecureStore/AsyncStorage)│
│  ceremony.ts      — CeremonyController: one in-flight ceremony,      │
│                     queues concurrent privileged requests            │
└───────────────┬──────────────────────────────────────────────────────┘
                │ PrivilegedKeyManager keyGetter = unsealViaCeremony()
┌───────────────▼───────────────────────────────┐  ┌───────────────────┐
│ @bsv/wallet-toolbox-mobile                    │  │ packages/          │
│  Wallet(…, privilegedKeyManager)              │  │ react-native-      │
│  · privileged:true ops → PKM (120 s retention)│  │ yubikey (Nitro)    │
│  WalletPermissionsManager ('admin vault')     │  │  iOS: YubiKit PIV  │
└───────────────────────────────────────────────┘  │  Android: yubikit  │
                                                   │  + Mock driver     │
                                                   └───────────────────┘
```

### 4.1 Native module — `packages/react-native-yubikey`

Nitro module, exact clone of the localpay-transport shipping pattern (nitro.json,
`src/specs/YubiKeyPiv.nitro.ts`, committed nitrogen glue, podspec with
`add_nitrogen_files`, Android `build.gradle` applying the generated autolinking
gradle, empty `ReactPackage` whose companion init loads the native lib, `file:`
dep in root package.json).

Surface (all methods reject with typed error codes, never crash):

```ts
interface YubiKeyPiv extends HybridObject {
  // availability
  isSupported(): boolean            // iOS ≥16 / Android USB-host or NFC
  // discovery lifecycle — one session at a time
  startDiscovery(): void            // USB (+NFC on Android) listeners
  stopDiscovery(): void
  onKeyEvent(cb: (e: KeyEvent) => void): () => void
  // e: { type: 'attached'|'detached', serial?: string, transport: 'usb'|'nfc' }

  // PIV operations (each opens/uses the current connection)
  getKeyInfo(): Promise<KeyInfo>    // serial, firmware, pin retries
  verifyPin(pin: string): Promise<PinResult>          // { ok, retriesLeft }
  changePin(oldPin: string, newPin: string): Promise<PinResult>
  generateVaultKey(args: {
    slot: number                    // 0x82
    managementKey?: string          // hex; default key tried when omitted
    touchPolicy: 'always'|'cached'
    pinPolicy: 'once'|'always'
  }): Promise<{ publicKey: string }>                  // 65-byte SEC1 hex
  readVaultPublicKey(slot: number): Promise<{ publicKey: string } | null>
  ecdh(args: { slot: number, peerPublicKey: string }): Promise<{ secret: string }>
  // ^ the touch-gated call: blocks until touch or ~15 s timeout
}
```

- **iOS**: CocoaPods dep on Yubico's `YubiKit` (legacy yubikit-ios 4.7.x —
  pod-distributed, mature; yubikit-swift is SPM-first). `YKFSmartCardConnection`
  → `YKFPIVSession`. Entitlement `com.apple.security.smartcard` added via a new
  config plugin `plugins/withSmartCardEntitlement.js` **and** the tracked
  `ios/BSVBrowser.entitlements` (both, or prebuild/tracked drift — known trap).
- **Android**: `com.yubico.yubikit:android:3.2.0` + `piv:3.2.0`.
  `YubiKitManager.startUsbDiscovery` (SDK-managed USB permission dialog) +
  `startNfcDiscovery` (best-effort; benefits 5C NFC owners). No C++ → no
  16 KB-page-size flag needed; plain Kotlin + Java deps.
- **Ignore rules**: verify `!/packages/**/android` + `!/packages/**/android/**`
  negations already cover the new package in **both** `.gitignore` and
  `.easignore`; confirm with `git ls-files --exclude-from .easignore --ignored --cached`.
- **Mock driver**: `src/mock.ts` — an in-memory `YubiKeyPiv` implementation
  backed by a software P-256 keypair (@noble/curves), emulating touch delays,
  PIN retries, and serial. Selectable in dev settings; used by Jest. Real module
  getter returns `null` when unavailable (web/Expo Go/simulator), mirroring
  `getLocalPayTransport()`.

### 4.2 Sealing scheme (services/vault/VaultKeyService)

Format `bsvb-vault-seal-v1`:

```
enroll(pin?):
  1. connect; getKeyInfo() → serial, firmware, pinRetries
  2. if PIN is factory default (123456): force changePin (UI wizard step)
  3. generateVaultKey(slot=0x82, touch=always, pin=once) → yubiPub (P-256)
  4. V ← 32 random bytes (expo-crypto getRandomBytes) — the vault privileged key
     (secp256k1 scalar; re-roll in the vanishingly rare ≥ curve-order case)
  5. seal(V, yubiPub) → blob                                   [no token needed]
  6. show BIP39 mnemonic of V once (recovery); require confirm quiz
  7. persist blob + meta; zero V in memory

seal(V, yubiPub):                                   # software-only, repeatable
  e ← ephemeral P-256 keypair
  S ← ECDH(e.priv, yubiPub)                         # x-coordinate
  KEK ← HKDF-SHA256(ikm=S, salt=32 rand bytes, info='bsvb-vault-seal-v1')
  C ← AES-256-GCM(KEK, V)
  blob = { v:1, slot, ePub, salt, C, yubiSerial, yubiPubSha256 }

unseal(blob, pin):                                  # the ceremony
  1. connect; getKeyInfo(); if serial ≠ blob.yubiSerial → 'wrong-key' error
  2. verifyPin(pin)                                 # pinPolicy=once per session
  3. S ← ecdh(slot, blob.ePub)                      # ← TOUCH (LED blinks, 15 s)
  4. KEK ← HKDF(S, blob.salt, info); V ← AES-GCM-decrypt(KEK, blob.C)
  5. return PrivateKey(V)
```

- Storage: blob ciphertext + meta in **expo-secure-store** (`vault_seal_v1`),
  same `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` accessibility as the mnemonic;
  non-secret UI metadata (enrolled?, serial, nickname, enrolledAt, deposit key
  queue) in AsyncStorage (`vault_meta_v1`). The blob alone is useless without
  the physical key; SecureStore is defense-in-depth.
- Crypto primitives: ephemeral P-256 ECDH via `@noble/curves` (new dep; sibling
  of the existing `@noble/secp256k1`); AES-256-GCM via `@bsv/sdk` `SymmetricKey`
  (its AES-GCM is curve-agnostic — takes raw 32-byte keys); HKDF-SHA256
  implemented in-repo per RFC 5869 (~15 lines over `@bsv/sdk` Hash, tested
  against RFC vectors); randomness from `expo-crypto` getRandomBytes.
- Management key: attempt factory-default management key for keygen
  (TDES `0102…08×3` pre-5.7 fw, AES-192 default post-5.7 — try per firmware);
  if rejected → explicit error telling the user their PIV management key is
  customized and how to proceed. v1 does NOT rotate the management key
  (age-plugin-yubikey's PIN-protected-metadata trick deferred; risk accepted:
  default mgmt key allows an attacker with the token to wipe/regen the slot —
  that *denies*, never *reveals*; funds recoverable via backup phrase).
- Retired slot 0x82 chosen (age-plugin-yubikey convention: slots 82–95 are
  "retired" and otherwise unused; 9a/9c/9d/9e left for real smart-card use).

### 4.3 PrivilegedKeyManager integration

`WalletContext.tsx` (both build paths):

```ts
const privilegedKeyManager = buildPrivilegedKeyManager({
  legacyRootKey: rootKey,        // pre-vault behavior
  requestCeremony,               // from VaultCeremonyContext
})
// inside:
new PrivilegedKeyManager(async (reason: string) => {
  if (!(await vaultStore.isEnrolled())) return legacyRootKey   // unchanged today
  return requestCeremony(reason)  // resolves with PrivateKey after unseal
}, VAULT_RETENTION_MS)            // 120_000, one constant
```

- **Not enrolled → exactly today's behavior.** Zero migration risk.
- Enrolled → every privileged op (ours or a web page's) runs the ceremony; PKM
  retains the key 120 s (its own obfuscated storage), so a burst of operations
  (multi-input withdrawal) needs one touch.
- `CeremonyController` serializes ceremonies: concurrent privileged calls await
  the same in-flight ceremony promise.
- **Relock on unplug:** `onKeyEvent('detached')` → `pkm.destroyKey()` + vault-close
  sound + subtle haptic. The vault relocks the moment the key leaves the phone.
- Privileged identity changes when the vault is enabled (was root key). BRC-100
  privileged ops are effectively unused today (degenerate PKM, no ceremony), so
  no continuity issue; document in release notes.

### 4.4 Vault basket + funds model (services/vault/VaultTransfers)

- **Basket:** `admin vault` — admin-reserved name; all wallet calls for vault
  operations go through `managers.permissionsManager` with `adminOriginator`
  (same pattern as `Balance.tsx`). Web pages are denied by `isAdminBasket`.
- **Vault key derivation:** BRC-42 via toolbox privileged path,
  `protocolID: [2, 'vault']`, `counterparty: 'self'`, `keyID: 'vault/<n>'`.
- **Deposit addresses without the token:** at enrollment (and on every unseal)
  the service derives a queue of N=64 future deposit public keys
  (`getPublicKey({ privileged: true, forSelf: true, … })` — key already in PKM
  retention window, so no extra touches) and stores `{keyID, pubKeyHash}` in
  vault meta. Deposits pop from the queue. Queue empty → deposit asks for one
  touch to replenish ("Vault needs your key to mint fresh addresses").
- **Deposit (default → vault):** ordinary
  `createAction({ outputs: [{ lockingScript: P2PKH(pubKeyHash), satoshis,
  basket: 'admin vault', customInstructions: JSON({v:1, keyID}),
  outputDescription: 'Vault deposit' }], description, labels: ['vault','deposit'] })`
  — funded and change-managed by the toolbox from the default basket. Spending
  authorization sheet applies as usual. **No YubiKey.**
- **Withdraw (vault → default):**
  1. select vault outputs (oldest-first) covering the requested amount;
     `listOutputs({ basket: 'admin vault', include: 'entire transactions' })`
     supplies the BEEF.
  2. ceremony (one touch) → PKM armed.
  3. `createAction({ inputBEEF, inputs: [{ outpoint, unlockingScriptLength: 108,
     inputDescription }...], outputs: [] , description, labels: ['vault','withdraw'] })`
     → `signableTransaction`. All input value minus fee returns to the
     **default basket as change** — that IS the internal transfer.
     Partial withdrawal (amount < selected outputs): add one change-back output
     to a fresh vault deposit key so the remainder stays vaulted.
  4. for each input: compute the BIP143-style sighash with @bsv/sdk
     `TransactionSignature`, then `createSignature({ hashToDirectlySign,
     protocolID: [2,'vault'], keyID, counterparty: 'self', privileged: true,
     privilegedReason })` — PKM signs, raw key never touches vault code —
     assemble P2PKH unlocking script (sig+type, derived pubkey).
  5. `signAction({ spends, reference })` → broadcast via normal rails.
- **Balance:** `listOutputs({ basket: 'admin vault' })` sum; separate
  `useVaultBalance` hook refreshed on `txStatusVersion` bumps + after vault ops.
  Main balance semantics unchanged (vault funds intentionally excluded).

### 4.5 Recovery & lifecycle

- **Backup phrase (mandatory at enroll):** BIP39 of V, shown once, confirm-quiz
  (reuse mnemonic-screen patterns). UI copy: losing YubiKey + phrase = losing
  vault funds.
- **Recover flow:** enter phrase → V; options: (a) re-seal to a new YubiKey
  (fresh enroll with existing V), (b) sweep vault → default (signs with V
  directly through a temporary in-memory PKM), then disable.
- **Disable vault:** requires ceremony (or backup phrase); sweeps funds to
  default, deletes seal + meta, PKM reverts to legacy behavior.
- **Wrong key inserted:** serial mismatch → explicit error with enrolled key
  nickname/serial.
- **PIN lockout:** surface `retriesLeft` after every failure; at 0 → guidance
  screen (PUK via YubiKey Manager is out of scope for v1; recommend recovery
  phrase path).
- **Firmware/mgmt-key edge cases:** explicit error states, never silent.

## 5. UX design

### 5.1 Surfaces

- **`/vault` screen** (expo-router route; entry rows in `app/settings.tsx`
  Activity section and `wallet-config.tsx` Data & Security):
  - Not enrolled → hero explainer ("A safe inside your wallet") + Enroll CTA.
  - Enrolled → vault balance (AmountDisplay, `display` type scale), Deposit /
    Withdraw buttons, key card (nickname, serial, last used), activity list
    (vault-labeled actions), overflow: recovery phrase check, re-key, disable.
- **Enrollment wizard** (within /vault): intro → insert key → (PIN change if
  factory) → generate (touch) → backup phrase → confirm quiz → done.
- **VaultCeremonySheet** — global Sheet (mounted in `app/_layout.tsx` beside
  PermissionSheet), driven by `VaultCeremonyContext`. Shows **why** (the
  `privilegedReason` string / transfer summary), **what to do** (state below),
  and **who's asking** (origin — `admin.com` renders as "BSV Browser").

### 5.2 Ceremony state machine

```
idle → waiting-for-key → connecting → pin-entry → awaiting-touch
     → unsealing → armed(success) | error(code) → retry/cancel
```

| state | copy (en) | visual | haptic | sound |
|---|---|---|---|---|
| waiting-for-key | "Insert your YubiKey" | key-into-port illustration, port pulses | `tap` on attach | — |
| connecting | "Reading key…" | spinner | — | — |
| pin-entry | "Enter your PIV PIN" | secure field + retriesLeft when <3 | `confirm` on ok, `error` on fail | — |
| awaiting-touch | "Touch the gold contact" | disc pulses in sync with the key's LED, 15 s countdown ring | gentle `tap` at start | — |
| unsealing | "Unlocking vault…" | brief | — | — |
| armed | "Vault unlocked · relocks in 2:00" | countdown chip persists on /vault | `success` | **vault-open** |
| relocked (timeout or unplug) | toast "Vault locked" | — | `confirm` | **vault-close** |
| error | specific, actionable | — | `warning`/`error` | — |

Design rules honored: Quiet Precision motion tokens (springs.settle for the
sheet, ≤350 ms), no fractional-opacity animation over glass (scale/translate
only), reduced-motion collapses pulses to static states, `PressableScale` for
buttons, Celebration NOT used (its three-moment policy stands; enrollment
completion uses Toast success + vault-open sound instead).

### 5.3 Sounds — "delightful but serious"

Two new assets under `assets/sounds/`, same non-negotiables as
`payment-confirmed.wav` (respect silent switch, mixWithOthers, never block or
throw, lazy expo-audio):

- **vault-open.wav** (~0.7 s): low, rounded two-note motif rising minor third
  (~D3→F3), soft mallet timbre + faint metallic tail — a heavy door swinging
  open, not a slot machine.
- **vault-close.wav** (~0.5 s): single lower thunk (~A2) with fast decay —
  bolt sliding home. Plays on relock (timeout, unplug, manual).

Generated in-repo (scripted synthesis, committed wav + generator script), tuned
below full scale like the existing chime. `sounds` module gains
`vaultOpen()` / `vaultClose()`; pairing rule documented: vault-open pairs with
`haptics.success`, vault-close with `haptics.confirm` — never double-fire.

### 5.4 i18n

All strings through `context/i18n/translations.tsx`: `vault_*` keys added to
the `en` block (authoritative) **and all 12 other language blocks** (machine
translations, flagged for native review).

## 6. Security analysis

| Threat | Mitigation |
|---|---|
| Phone malware exfiltrates vault funds | Vault outputs locked to privileged-derived keys; plaintext V exists only during PKM retention after physical touch. Malware must wait for/coax a ceremony — game changed from "silent theft" to "physical presence + user action per window". |
| Stolen phone (unlocked) | Same: vault spends need the YubiKey + PIN + touch. |
| Stolen phone + YubiKey | PIV PIN (3 retries) gates ECDH. |
| Malicious web page | `admin vault` basket invisible/untouchable to non-admin originators; privileged sigs require ceremony (page-triggered ceremony shows origin + reason — user declines). |
| Sealed blob leaks (backup, cloud) | Blob useless without on-token ECDH; AES-GCM + HKDF from token-bound secret. |
| YubiKey lost/bricked (PIN/PUK exhaustion) | Backup phrase recovers V → re-key or sweep. |
| Wrong/second YubiKey | Serial binding + explicit error. |
| Attacker with token wipes slot (default mgmt key) | Denial only, never disclosure; recover via phrase. Documented residual risk v1. |
| Ceremony fatigue / prompt spam | One controller, queued requests share a ceremony; reason string always shown; page-originated requests rate-limited by their permission prompts upstream. |
| Key material hygiene | V zeroed after seal/handoff; PKM chunked-XOR retention + scheduled destruction; unseal path never logs; PIN never persisted. |

Out of scope v1 (documented): management-key rotation, multi-YubiKey
recipients, per-input on-token signing, hard mode (retention 0 — touch per
signature), desktop pairing ceremony (WalletConnection RPC keeps working — a
privileged RPC call raises the ceremony on the phone, which is correct).

## 7. Component inventory (isolation & interfaces)

| unit | does | depends on |
|---|---|---|
| `packages/react-native-yubikey` | PIV APDU surface (spec above) | YubiKit iOS / yubikit-android |
| `services/vault/sealing.ts` | pure crypto: seal/unseal/HKDF (no I/O) | @noble/curves p256, @bsv/sdk |
| `services/vault/vaultStore.ts` | persistence of seal + meta | SecureStore, AsyncStorage |
| `services/vault/VaultKeyService.ts` | enroll/unseal/recover/disable orchestration | module, sealing, store |
| `services/vault/ceremony.ts` | CeremonyController state machine (UI-free) | VaultKeyService |
| `context/VaultContext.tsx` | React wiring: ceremony state → sheet, keyGetter factory | ceremony, WalletContext |
| `services/vault/transfers.ts` | deposit/withdraw/balance/selection | permissionsManager, @bsv/sdk |
| `components/vault/*` | screen, wizard, ceremony sheet, key card | ui kit, theme, i18n |
| `hooks/useVaultSounds` (ext. of `sounds`) | vaultOpen/vaultClose | expo-audio |

Each service unit is plain TS with injected dependencies — unit-testable without
React or native modules.

## 8. Error handling

Typed `VaultError` codes end-to-end: `unsupported-platform`, `no-key`,
`wrong-key`, `pin-required`, `pin-invalid(retriesLeft)`, `pin-locked`,
`touch-timeout`, `key-removed-mid-op`, `mgmt-key-custom`, `slot-occupied`,
`seal-corrupt`, `serial-mismatch`, `user-cancelled`. Every code maps to a
ceremony-sheet state with copy + next action. Transfers are atomic at the
BRC-100 layer (createAction/signAction abort on failure → `abortAction`);
interrupted withdrawals resume nothing — outputs stay unspent, retry is safe.

## 9. Feature gating

- Runtime: `isSupported()` false (iOS <16, no USB host, simulator, web) → vault
  rows hidden behind "requires a YubiKey and a compatible device" explainer.
- Dev: settings toggle "Use mock YubiKey" (DEV builds only) drives the whole
  stack against the software mock.

## 10. Testing

- **Jest (this session):** sealing round-trip vectors (seal→unseal, tamper →
  GCM failure); HKDF RFC 5869 test vectors; ceremony state machine transitions
  incl. detach/timeout/PIN-retry; keyGetter fallback (not enrolled → root key);
  deposit key queue pop/replenish; withdrawal builder (input selection, sighash,
  unlock script correctness against @bsv/sdk P2PKH verify, partial-withdraw
  change-back); vaultStore round-trip; mock-driver parity with module surface.
- **Device matrix (pending, hardware required):** enroll/deposit/withdraw on
  iPhone 15+/iOS 26, Android USB-C, Android NFC (5C NFC), unplug-mid-ceremony,
  PIN lockout, cold-start with armed PKM. Same discipline as the local-payments
  matrix. **`com.apple.security.smartcard` entitlement must be validated
  through a real Deliver upload early** (ITMS-90683 precedent: Transporter
  Verify does not catch entitlement rejections).

## 11. Rollout

1. Feature lands behind enrollment (nothing changes for non-enrolled users).
2. Device matrix pass with real 5C hardware (user).
3. TestFlight/internal track; watch the entitlement through App Store review.
