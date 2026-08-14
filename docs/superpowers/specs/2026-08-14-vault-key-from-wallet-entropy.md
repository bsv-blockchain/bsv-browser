# Vault Key from Wallet Entropy — Security Design & Implementation Spec

**Date:** 2026-08-14
**Status:** Spec only — no code written. Requires product-owner decisions (§10) before implementation.
**Supersedes (partially):** `docs/superpowers/specs/2026-08-12-yubikey-vault-design.md` §"Recovery"
**Verdict:** **Sound with conditions.** The cryptographic core (BIP39 passphrase domain separation) is fine. The plan *as literally specified* — bare `Mnemonic.toSeed(userPassword)`, no app-side stretch, no verifier, "print your recovery shares first" — **must not ship**. Four mandatory conditions in §5.

---

## 0. Executive summary

| | Verdict |
|---|---|
| Is domain separation between the main key and V cryptographically sound? | **Yes.** No key-recovery relation exists in either direction. §3.1 |
| Is `toSeed(password)` *sufficient* protection? | **No, not on its own.** 2048 PBKDF2 rounds against an attacker holding the mnemonic ≈ 2·10⁶ guesses/s/GPU. §3.3 |
| Does it eliminate the second secret? | **No.** It replaces a 24-word, 256-bit generated secret with a shorter secret that is *weaker unless generated*. Be honest about this in the product framing: the achievable win is **24 words → 6 words**, not **24 words → nothing**. §3.3, §5 |
| Does it regress failure independence? | **Yes, materially.** The main mnemonic becomes a single point of failure for the entire estate. §3.2(e) |
| Biggest *implementation* hazard | Not the password — it is that **the stated recovery promise is false today**. `sweepVaultWithKey` sources UTXOs from local wallet storage, and the recovery UI is unreachable without a device-local seal. §3.5, §7.3 |
| Second biggest | **Backup Recovery Shares do not back up the mnemonic.** They split `m/0'/0'`. The proposed advisory would tell users something untrue, and share-restored wallets have no mnemonic at all. §3.6, §8.1 |

---

## 1. Current derivation, exactly as implemented

### 1.1 Main wallet

`utils/mnemonicWallet.ts:25-64` — `generateMnemonicWallet(config)`:

```
utils/mnemonicWallet.ts:26   const { passphrase = '' } = config
utils/mnemonicWallet.ts:35   mnemonicInstance = Mnemonic.fromRandom()          // 128 bits → 12 words
utils/mnemonicWallet.ts:42   const seed = mnemonicInstance.toSeed(passphrase)  // passphrase === ''
utils/mnemonicWallet.ts:45   const hdKey = HD.fromSeed(seed)
utils/mnemonicWallet.ts:52   const derivedHdKey = hdKey.derive("m/0'/0'")
utils/mnemonicWallet.ts:53   const primaryKey = derivedHdKey.privKey.toArray()
```

`recoverMnemonicWallet(mnemonic, passphrase = '')` (`utils/mnemonicWallet.ts:69-74`) forwards to the same function.

`context/WalletContext.tsx:1230` calls it with **one argument**:

```ts
const { rootKey, primaryKey } = recoverMnemonicWallet(mnemonic)
```

**Confirmed: the main wallet uses an empty BIP39 passphrase today. There is no code path anywhere in the app that passes a non-empty `passphrase`.** The main wallet mnemonic is **12 words / 128 bits** (`Mnemonic.fromRandom()` default; `app/auth/mnemonic.tsx:61` calls `generateMnemonicWallet()` with no config).

Storage: `context/LocalStorageProvider.tsx`
- Mechanism: **`expo-secure-store`** (iOS Keychain / Android Keystore-backed), key name **`'mnemonic'`** (`LocalStorageProvider.tsx:32`), accessibility class `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` (`:127`, matching the vault seal's class at `vaultStore.ts:33`).
- Gate: `ensureAuth()` (`LocalStorageProvider.tsx:67-89`) → `expo-local-authentication`'s `LocalAuthentication.authenticateAsync({ disableDeviceFallback: false })` — Face ID / Touch ID **with device-passcode fallback**.
- **Session latch:** `authenticatedRef` (`:64`, checked at `:74`) means **after the first successful auth in a process lifetime, every subsequent `getMnemonic()` returns plaintext with no prompt.** There is also an `AsyncStorage` `hasWalletKeys` flag short-circuit at `:141-142`.
- Runtime residency: the plaintext mnemonic is **not** retained in memory after unlock. `buildWalletFromMnemonic` holds it in a local `const` (`WalletContext.tsx:1221`), derives from it (`:1230`), writes it back (`:1266`), and lets it go. `useWallet()` exposes no mnemonic. What *is* long-lived in memory is `primaryKey` (= `m/0'/0'`) inside `SimpleWalletManager` (`WalletContext.tsx:1254`) and `rootKey` captured in the privileged-key-getter closure (`:1240`) — neither of which can be inverted back to the seed or the mnemonic.

### 1.2 Vault key V (v1, current)

`services/vault/VaultKeyService.ts:35-39`:

```ts
/** V = BIP32 master private key of the backup mnemonic's seed. */
function deriveVaultKey(mnemonic: string): number[] {
  const seed = Mnemonic.fromString(mnemonic).toSeed('')      // :37
  return HD.fromSeed(seed).privKey.toArray()                 // :38
}
```

Enrollment (`VaultKeyService.ts:104-126`):

```ts
const backupMnemonic = Mnemonic.fromRandom(256).toString()   // :104  fresh 24 words / 256 bits
const v = deriveVaultKey(backupMnemonic)                     // :105
const seal = sealVaultKey(v, publicKey, { slot, serial })    // :112
const meta: VaultMeta = { v: 1, …, depositKeys: deriveDepositKeys(v, 0, 64) }  // :113-121
v.fill(0)                                                    // :124
```

Deposit keys (`VaultKeyService.ts:41-51`) — **BRC-42/BRC-43, not BIP32/BIP44**:

```ts
const kd = new KeyDeriver(new PrivateKey(v))
const keyID = `vault/${i}`                                   // :46
const pub = kd.derivePublicKey([2,'vault'], keyID, 'self', /* forSelf */ true)  // :47
out.push({ keyID, pkh: pub.toHash('hex') })                  // :48
```

Recovery (`VaultKeyService.ts:137-141`):

```ts
const trimmed = mnemonic.trim().replace(/\s+/g, ' ')
if (!Mnemonic.isValid(trimmed)) throw new VaultError('seal-corrupt', …)  // :139
return new PrivateKey(deriveVaultKey(trimmed))
```

### 1.3 The seal is not a password oracle; the deposit-key queue is

`services/vault/sealing.ts:77-96` seals V with `KEK = HKDF-SHA256(ECDH(e, yubiPub), salt, 'bsvb-vault-seal-v1')`. `unsealVaultKey(blob, sharedSecretHex)` (`sealing.ts:101-108`) **requires the token-computed ECDH secret**. The AES-GCM tag authenticates the *KEK*, not V. **So the seal alone gives no offline check of a candidate V.**

`VaultMeta.depositKeys` (`vaultStore.ts:29`) **does**. Each entry is `{ keyID, pkh }` where `pkh = hash160(KeyDeriver(V).derivePublicKey([2,'vault'], keyID, 'self', true))`. Meta lives in **plaintext AsyncStorage** (`vaultStore.ts:18, 64-66`). Any `(keyID, pkh)` pair in that array is a complete, YubiKey-free verifier for a candidate V today.

Caveats that make it unsuitable as *the* verifier: the queue drains (`popDepositKey`, `vaultStore.ts:70-76`) and can reach length 0; replenishment appends only higher indices (`transfers.ts:435-455`); and the whole array is AsyncStorage, which is wiped by app-data clears and by the DB import path. **A dedicated, stable fingerprint field is required — §5.3.**

### 1.4 `@bsv/sdk` `Mnemonic.toSeed` — verified on disk

`node_modules/@bsv/sdk/dist/esm/src/compat/Mnemonic.js:245-262`:

```js
mnemonic2Seed (passphrase = '') {
  if (!this.check()) throw new Error('Mnemonic does not pass the check …')
  if (typeof passphrase !== 'string') throw new TypeError(…)
  mnemonic   = mnemonic.normalize('NFKD')
  passphrase = passphrase.normalize('NFKD')
  const mbuf = toArray(mnemonic, 'utf8')
  const pbuf = [...toArray('mnemonic','utf8'), ...toArray(passphrase,'utf8')]
  this.seed  = Hash.pbkdf2(mbuf, pbuf, 2048, 64, 'sha512')     // :260
}
```

**Confirmed: standard BIP39. PBKDF2-HMAC-SHA512, salt = `"mnemonic" || passphrase`, 2048 iterations, 64-byte output, NFKD normalization on both inputs.** `toSeed(passphrase)` (`:160-163`) is a thin wrapper. Note the argument roles: the *mnemonic* is the PBKDF2 password; the *passphrase* is part of the salt.

Three sharp edges found in the SDK:

1. **`Mnemonic.isValid(mnemonic, passphrase)` does not validate the passphrase.** `Mnemonic.js:269-278` returns `true` whenever `mnemonic2Seed(passphrase)` does not throw, and it only throws on a bad *mnemonic* checksum or a non-string passphrase. **`VaultKeyService.ts:139` must not be mistaken for password validation, and no new code may lean on it for that.**
2. **No whitespace normalization on the passphrase.** The mnemonic is trimmed/collapsed by the caller (`VaultKeyService.ts:138`); a passphrase is used verbatim after NFKD. A trailing space silently yields a different seed.
3. **`Hash.pbkdf2` runs natively in this app.** `node_modules/@bsv/sdk/dist/esm/src/primitives/Hash.js:1833-1846` prefers `NODE_CRYPTO?.pbkdf2Sync`, and `metro.config.js:8,19` + `index.js:8` route `crypto` → `react-native-quick-crypto` (0.7.17, `pbkdf2Sync` present). **A high-iteration app-side stretch is therefore cheap and available with zero new dependencies.**

`HD.fromSeed` (`@bsv/sdk/dist/esm/src/compat/HD.js:109-125`) is standard BIP32: `HMAC-SHA512("Bitcoin seed", seed)`, `privKey = hash[0..32]`, `chainCode = hash[32..64]`; accepts 16–64 byte seeds.

---

## 2. Proposed derivation (v2)

### 2.1 Recommended pseudocode

```ts
import { Mnemonic, HD, PrivateKey, Hash, Utils } from '@bsv/sdk'

const VAULT_KDF_DOMAIN   = 'bsvb-vault-v2'              // BIP39-passphrase namespace prefix
const VAULT_KDF_SALT     = 'bsvb-vault-kdf-v2'          // FIXED, NOT random — see §2.3
const VAULT_KDF_ROUNDS   = 600_000                      // app-side stretch
const VAULT_FP_DOMAIN    = 'bsvb-vault-fp-v2'

/** V for a v2 vault. Never logged. Callers zero the return value when done. */
function deriveVaultKeyV2(mainMnemonic: string, vaultPassword: string): number[] {
  if (vaultPassword.length === 0) throw new VaultError('vault-password-required')

  // (1) BIP39 domain separation. Prefixing guarantees the vault passphrase is
  //     never '' at the BIP39 layer even if the policy check is bypassed, and
  //     hard-separates the vault from any BIP39 passphrase the main wallet may
  //     one day adopt.
  const s1 = Mnemonic.fromString(mainMnemonic)
                     .toSeed(`${VAULT_KDF_DOMAIN}:${vaultPassword}`)   // 64 bytes, PBKDF2 2048

  // (2) App-side stretch. Native via react-native-quick-crypto (metro alias).
  const k = Hash.pbkdf2(
    s1,                                       // password  = the 64-byte BIP39 seed
    Utils.toArray(VAULT_KDF_SALT, 'utf8'),    // salt      = fixed domain string
    VAULT_KDF_ROUNDS,
    64,
    'sha512'
  )

  // (3) BIP32 master of the stretched material.
  const v = HD.fromSeed(k).privKey.toArray()
  s1.fill(0); k.fill(0)
  return v
}

/** Non-secret verifier. Deliberately costs one secp256k1 point multiplication
 *  so it is no cheaper an oracle than the deposit-pkh oracle that already
 *  exists (§3.4). 8 bytes → 2^-64 false accept. */
function vaultFingerprint(v: number[]): string {
  const pub = new PrivateKey(v).toPublicKey().encode(true) as number[]   // compressed SEC1
  const h   = Hash.sha256([...Utils.toArray(VAULT_FP_DOMAIN, 'utf8'), ...pub])
  return Utils.toHex(h.slice(0, 8))
}
```

Everything downstream is unchanged: `sealVaultKey(v, yubiPub, …)`, `deriveDepositKeys(v, 0, 64)`, the ceremony, `withdrawFromVault`, `sweepVaultWithKey`. **V is still a 32-byte secp256k1 scalar; only its provenance changes.**

### 2.2 What the plan says vs what is recommended

| Plan as briefed | Recommendation | Why |
|---|---|---|
| `Mnemonic.toSeed(userVaultPassword)` | `Mnemonic.toSeed('bsvb-vault-v2:' + password)` | Empty-password fail-safe + namespace isolation. Free. |
| No app-side KDF | + PBKDF2-SHA512 600 000 rounds | §3.3. Worth ~8 bits. Native, ~0.4–1.2 s on device. |
| No verifier | + 8-byte `vaultFingerprint` in seal **and** meta **and** on a printed recovery card | §3.4. Only defence against silent-typo loss. |
| User invents the password | App **generates** a 6-word BIP39-wordlist passphrase (66 bits); free-typing allowed only above a hard 55-bit floor | §3.3. Human-chosen passwords are 25–40 bits. |
| "Print your Backup Recovery Shares first" | Copy must say shares back up the **wallet**, not the vault; the vault's second path is the **12-word wallet phrase** + password | §3.6. Shares split `m/0'/0'`, not the mnemonic. |

### 2.3 Hard constraint discovered: no per-device randomness in the derivation

Any random salt, device ID, or install-time nonce in `deriveVaultKeyV2` **destroys the mnemonic+password recovery path**, because that material lives only on the lost device (seal → SecureStore, meta → AsyncStorage). The salt must be a fixed domain string. Losing per-user salting costs nothing here: the stretch's "password" input is already the 64-byte `s1`, unique per `(mnemonic, password)` pair, so cross-user precomputation is impossible regardless.

**Design rule to enforce in review: `deriveVaultKeyV2` must be a pure function of `(mainMnemonic, vaultPassword)` and compile-time constants. Nothing else.**

---

## 3. Security analysis

### 3.1 Domain separation — sound

Let `M` be the mnemonic, `S₀ = PBKDF2-SHA512(M, "mnemonic", 2048, 64)` the main seed, `S₁ = PBKDF2-SHA512(M, "mnemonic" ‖ p, 2048, 64)` the vault seed for passphrase `p`.

- **`S₀ → S₁` without `M`:** infeasible. PBKDF2 is an iterated HMAC-SHA512 chain keyed by `M`; the salt participates only as the first-block input. Producing the output for a *different salt* requires the key. No known relation exists for HMAC-SHA512 under the standard PRF assumption.
- **`S₁ → S₀`:** identically infeasible.
- **`S₀ → M` or `S₁ → M`:** requires inverting 2048 rounds of HMAC-SHA512. Infeasible.
- **`V → M`:** `V = truncate₃₂(HMAC-SHA512("Bitcoin seed", K))` where `K` itself is a PBKDF2 output. Two one-way steps plus a 512→256-bit truncation. **Vault-key compromise therefore does not endanger the main wallet.** This is a genuine improvement in one direction and worth stating.
- **Main root key `↔` V:** they are BIP32 masters of two seeds that share a key but not a salt. They are computationally independent *to anyone who does not hold `M`*. To anyone who *does* hold `M`, `S₁` is computable for any candidate `p` at 2048 PBKDF2 rounds. **That is the entire security question — see §3.3.**

One nit against the current v1 doc comment (`VaultKeyService.ts:8-9`, "V is always a valid secp256k1 scalar"): BIP32 permits `IL ≥ n` or `IL = 0` with probability ≈2⁻¹²⁷; `HD.fromSeed` does not check, `new PrivateKey(hash.slice(0,32))` would. Negligible, unchanged by this proposal, not worth code.

**Verdict on question 1: sound. `toSeed(password)` is correct, standard, well-analysed domain separation. It is the *work factor*, not the *separation*, that is deficient.**

### 3.2 Threat-model delta vs the v1 random second mnemonic

| Scenario | v1 (random 24-word vault phrase) | v2 (main mnemonic + password) | Delta |
|---|---|---|---|
| **(a) Main mnemonic compromised** (paper backup photographed, SecureStore extracted from a jailbroken/rooted device, `getMnemonic()` abused via the session latch) | Hot wallet drained. **Vault untouched** — V is unrelated to `M`. | Hot wallet drained. **Vault falls to an offline grind whose only cost is the password's entropy.** With the recommended stretch and a ≥55-bit password: ~10⁴+ years/rig. With a user-invented password (~30 bits): **minutes**. | ⚠️ **Regression, magnitude entirely determined by password entropy.** |
| **(b) Vault password compromised alone** (shoulder-surf, keylogger, iCloud Keychain sync, clipboard) | N/A (no password exists) | **Vault safe** — the password is useless without `M` *and* the attacker still faces the YubiKey for the ceremony path. | ✅ Neutral/positive: the password is a genuine second factor, not a standalone key. |
| **(c) YubiKey stolen** | Attacker needs the PIN (3 tries → PUK → applet reset wipes slot 0x82) *and* the phone, since the seal is device-local. Vault safe. | Identical — sealing is unchanged. | ➖ No change. |
| **(d) YubiKey bricked / lost** | Recover with the 24-word vault phrase → `sweepVaultWithKey`. | Recover with `M` + password → `sweepVaultWithKey`. | ➖ Equivalent *in principle*. **Both are broken in practice if the phone is also gone — §3.5.** |
| **(e) Correlated loss** | Losing `M` costs the hot wallet only; the vault survives on its own phrase. Losing the vault phrase costs the vault only. **Two independent backup artefacts.** | Losing `M` costs the hot wallet **and** the mnemonic-path vault recovery in one stroke; only device+PIN remains. Losing `M` *and* the YubiKey = **total, correlated loss of the entire estate.** | ⚠️ **Real regression in failure independence. One piece of paper now unlocks everything.** |
| **(f) Malicious web origin / in-tab CWI bridge** | Blocked by `guardVaultAccess` (`services/vault/guard.ts:57-73`). | Unchanged. | ➖ No change. |
| **(g) Memory scrape of the running app** | V present only inside the PKM's obfuscated store during the 120 s armed window. `M` not resident. | Same, **plus** a new transient window: `M` and the password are both in JS heap during enrollment and during mnemonic-path recovery. | ⚠️ Small new exposure; bounded and mitigable (§6). |

**The single sentence the product owner must read and sign off on:**

> Under v2, the 12-word wallet recovery phrase becomes a single point of failure for the hot wallet *and* (given the vault password) the vault. Compartmentalisation between the everyday balance and the high-security vault, which was the v1 design's principal safety property for paper backups, is gone.

### 3.3 Password strength — quantified

**Cost of one candidate password to an attacker holding `M`.**
`toSeed` = PBKDF2-HMAC-SHA512, c=2048, dkLen=64 → exactly one output block → 2048 HMAC evaluations → **≈4096 SHA-512 compressions**.

Assumptions (state them; they are the load-bearing numbers):
- Top consumer GPU, 2026: ~10¹⁰ SHA-512 compressions/s.
- → **≈2.4 × 10⁶ candidates/s per GPU** for bare BIP39.
- 8-GPU rig (~$30k, or rented for ~$10/h): **≈2 × 10⁷/s ≈ 6 × 10¹⁴/year ≈ 2⁴⁹·³/year**.

| Password | Entropy | Time to exhaust, 1 rig, **bare BIP39** | …with **600 000-round stretch** |
|---|---|---|---|
| `Tr0ub4dor&3`-class human password | ~28 bits | **<1 second** | ~4 minutes |
| "strong" human password, 12–14 chars | ~35–40 bits | **1 min – 15 hours** | ~9 days – 5 years |
| 4 random BIP39 words | 44 bits | ~10 hours | ~120 years |
| 5 random BIP39 words | 55 bits | ~2.3 years | **~250 000 years** |
| 6 random BIP39 words | 66 bits | ~4 700 years | ~5 × 10⁸ years |
| 12-char random alphanumeric | 71 bits | ~1.5 × 10⁵ years | ~4 × 10⁷ years |

**The app-side stretch is worth ≈8.2 bits (600 000 / 2048 ≈ 293×) — about three-quarters of one passphrase word.** That is a real, cheap, worth-taking win, and it is emphatically **not** a substitute for entropy.

Setting a target of "≥100 years against a 100-rig adversary" (2⁴¹·⁰/rig-year × 10⁴ ≈ 2⁵⁴·³):
- **With the stretch: 55 bits minimum, 66 bits recommended.**
- Without the stretch: 63 bits minimum, 77 recommended.

**Do I recommend the app-side stretch? Yes, unequivocally.** The usual objection — "a non-standard stretch means the vault key can no longer be re-derived by a standard BIP39 tool" — **does not apply to this codebase and should be dismissed.** The vault's spendable keys are already **BRC-42/BRC-43** derivations (`KeyDeriver.derivePublicKey([2,'vault'], 'vault/<n>', 'self', forSelf=true)`, `VaultKeyService.ts:47`), which no BIP39/BIP44 wallet in existence can enumerate or spend. Even under v1 today, Electrum/Sparrow/Ian Coleman cannot find one satoshi of vault funds. The only software that can recover a vault is this app or a purpose-built BRC-42 tool — which will implement whatever KDF the spec names. **The compatibility cost of the stretch is exactly zero.** Take the 8 bits.

**Do I recommend letting the user invent the password? No.** Human-chosen secrets land at 25–40 bits. That range is `<1 second` to `5 years` even *with* the stretch, and every empirical study of user-chosen passwords says the mode is far below the mean. A vault whose second recovery path collapses in an afternoon is security theatre, and worse than v1's honest "here are 24 words, guard them".

**Recommended primary design: the app generates a 6-word passphrase from the BIP39 English wordlist (2048 words, 11 bits/word, 66 bits), shown once, written down, confirmed by a 2-word quiz.** Free-typing may be offered as an advanced option behind a hard entropy floor of 55 bits.

**Be honest in the product framing.** This does not eliminate the second secret. It shrinks it from 24 words to 6 and reframes it as "a vault password" rather than "a second wallet". That is a genuine and defensible UX win. Claiming more than that would be false.

The truly-zero-second-secret alternative is §10 Option C.

### 3.4 The no-typo-recovery problem — the biggest UX hazard, and its exact mitigation

BIP39 passphrases have **no checksum**. `Mnemonic.toSeed('correct')` and `Mnemonic.toSeed('c0rrect')` both succeed and both yield perfectly valid, entirely different vaults. `Mnemonic.isValid(m, p)` (`Mnemonic.js:269-278`) checks *only the mnemonic's* checksum — it returns `true` for every passphrase and is worthless here. A typo at recovery today would produce: valid V → `deriveDepositKeys` → different pkhs → `spendVaultOutputs` finds nothing → **`VaultError('vault-empty')`**, rendered by `RecoverSheet.tsx:41-43` as the generic *"Could not recover. Check the phrase and try again."* The user cannot distinguish "wrong password" from "vault is genuinely empty".

**Does an existing field already let you verify a candidate password offline without the YubiKey?**

- **`SealedBlob` — no.** `unsealVaultKey` (`sealing.ts:101-108`) needs the token's ECDH x-coordinate; `blob.c`'s GCM tag authenticates the KEK, not V. `yubiPubSha256` commits to the *token* key, not to V.
- **`VaultMeta.depositKeys` — yes, today.** Each `{ keyID, pkh }` (`vaultStore.ts:29`, produced at `VaultKeyService.ts:42-51`) is a full commitment to V, checkable with pure JS. Given any surviving entry you can recompute `hash160(KeyDeriver(candidateV).derivePublicKey([2,'vault'], keyID, 'self', true))` and compare.
- **But it is not a usable contract.** The array drains to empty via `popDepositKey` (`vaultStore.ts:70-76`), replenishes only at higher indices (`transfers.ts:435-455`), lives in plaintext AsyncStorage that app-data clears and `importWalletDatabase` can lose, and nothing in the code documents it as a verifier.

**Specified mitigation — all four parts are required:**

1. **Double entry at enrollment.** Two fields, byte-equal after NFKD, mismatch blocks submit. (If the app generates the passphrase, this becomes a 2-of-6-word confirmation quiz instead — same purpose, better retention.)
2. **A stable, explicit, non-secret verifier.** New field `vaultFingerprint: string` — 8 bytes hex of `SHA-256("bsvb-vault-fp-v2" ‖ compressedPubKey(V))`, written to **both**:
   - `SealedBlob.vaultFingerprint` — SecureStore, survives AsyncStorage wipes (this is the authoritative copy);
   - `VaultMeta.vaultFingerprint` — AsyncStorage, so a pre-flight check needs no SecureStore round-trip.

   It is a *public-key* fingerprint deliberately, not a hash of V's bytes: it costs the attacker one secp256k1 point multiplication, exactly like the deposit-pkh oracle that already exists, so it grants no speed-up (a raw hash of V would have handed the attacker ~1 bit by removing the EC work).
3. **Check it before doing anything.** `recoverVaultKeyV2` derives V, computes the fingerprint, compares against the stored one, and throws a **new, distinct** `VaultError('vault-password-wrong')` on mismatch — rendered as *"That password does not match this vault"*, never as "vault empty".
4. **A printable, non-secret Vault Recovery Card.** Offered right after enrollment succeeds, containing: vault nickname, YubiKey serial, enrollment date, `vaultFingerprint`, the two-path recovery statement, and **a QR of the first 64 deposit `pkh`s** (public data — they appear on-chain the moment they are funded). This is what restores typo protection *and* fund discoverability on a replacement device (§3.5). It must state in bold that it contains no secrets and that it is **not** a substitute for the wallet phrase or the vault password.

An attacker who steals the fingerprint gains nothing they did not already have: with `M` they can enumerate the wallet's own on-chain history, find the deposit transactions the hot wallet signed, read the vault output addresses off the chain, and grind against those. **The offline oracle is unavoidable; it is not created by the verifier.** All the more reason the entropy floor must carry the weight.

### 3.5 The recovery promise is currently false — highest-severity finding

The briefed copy says: *"funds in the Vault are recoverable via (hardware device + PIN) OR (main mnemonic + vault password). There is no third path."* **As implemented, the second path does not work once the phone is gone**, and neither did v1's 24-word phrase.

- `sweepVaultWithKey` (`transfers.ts:411-431`) → `spendVaultOutputs` (`transfers.ts:245-262`) sources UTXOs from **`w.listOutputs({ basket: 'admin vault' }, adminOriginator)`** — i.e. from the toolbox's **local SQLite storage** (`storageUrl: 'local'`, `WalletContext.tsx:1366`). Fresh device, fresh storage → zero outputs → `VaultError('vault-empty')`. **Correct V, nothing to spend.**
- The deposit `pkh` index is in AsyncStorage meta — also device-local.
- The `RecoverSheet` is only mounted on the **enrolled** branch of `app/vault.tsx` (rendered at `:257`, reachable from the manage section at `:238-253`, which is inside the `enrolled === true` return at `:184`). `vaultStore.isEnrolled()` is `SecureStore.getItemAsync('vault_seal_v1') != null`. **On a replacement device there is no seal, so the not-enrolled hero at `app/vault.tsx:161-181` renders instead and there is no way to reach recovery at all.**

Net: today the only real recovery is *device intact* + (YubiKey+PIN or the phrase). This is a pre-existing gap, but v2 makes it acute because the whole pitch of v2 is "your wallet phrase is enough".

**Required before the "no third path" copy may ship** (pick at least one):
- **(R1) Device-independent sweep** — a `sweepVaultFromChain(v)` that derives `vault/0..N`, queries WhatsOnChain address UTXOs for each `pkh`, and builds the spend from raw UTXOs instead of `listOutputs`. This is the real fix and reuses `buildVaultUnlockingScript` (`transfers.ts:159`) unchanged.
- **(R2) A "Recover a vault from another device" entry point** on the not-enrolled screen (`app/vault.tsx:161-181`), gated on the user supplying the fingerprint or the recovery card QR.
- **(R3)** At minimum: the Vault Recovery Card (§3.4.4) plus explicit copy telling the user to keep wallet-database exports (`exportAllWalletDatabases`, `app/wallet-config.tsx:163-176`) current.

If none of these ship, the recovery copy must be downgraded to name the device-intact precondition explicitly.

### 3.6 Backup Recovery Shares do **not** back up the mnemonic

`utils/backupShares.ts:20-27`:

```ts
export function generateBackupShares(primaryKeyBytes: number[], threshold = 2, totalShares = 3) {
  const key = new PrivateKey(primaryKeyBytes)
  return key.toBackupShares(threshold, totalShares)     // @bsv/sdk Shamir, 2-of-3
}
```

Scheme: **Shamir's Secret Sharing, threshold 2, total 3**, via `PrivateKey.toBackupShares`. Share wire format `base58(x).base58(y).threshold.integrity` (`backupShares.ts:18, 43-53`). What is printed, one page per share (`generatePrintHTML`, `:118-282`): the identity key + QR, the share string + QR, a date stamp, and recovery instructions. Triggered from **Settings → `app/wallet-config.tsx:130-161`** (`handlePrintRecoveryShares`) and from **`app/auth/mnemonic.tsx:123-137`** during first-run onboarding. Restore path: `app/auth/scan-shares.tsx:86` → `recoverKeyFromShares` → WIF → `setRecoveredKey` → `buildWalletFromRecoveredKey`.

**The secret being split is `primaryKey` = `m/0'/0'` (`mnemonicWallet.ts:52-53`, consumed at `wallet-config.tsx:139` and `auth/mnemonic.tsx:129`) — not the mnemonic, not the seed, not the BIP32 root.** BIP32 hardened derivation is one-way: `m/0'/0'` cannot be inverted to `m`, let alone to the seed or the 12 words.

Two hard consequences:

1. **The briefed advisory would be false.** Telling a user "print your Backup Recovery Shares before choosing your vault password" implies the shares protect the vault. They do not. Two shares reconstruct the hot wallet's primary key and nothing else; they cannot reconstruct the mnemonic and therefore cannot reconstruct V. Copy must be corrected — §8.1.
2. **Share-restored wallets have no mnemonic at all.** `buildWalletFromRecoveredKey` (`WalletContext.tsx:1278-1327`) stores only a WIF under `'recoveredKey'`; `getMnemonic()` returns `null` forever after. Such a user **cannot enroll a v2 vault** (no `M` to derive from) and, worse, a user who enrolls a v2 vault on device A and later restores on device B *from shares* has **permanently lost the mnemonic recovery path**. **v2 enrollment must be hard-gated on `getMnemonic() != null`, and the enrollment copy must warn that restoring from shares alone will not restore the vault.**

---

## 4. Verdict

**Sound with conditions.**

- The cryptography is correct. BIP39 passphrase separation is standard, well-analysed, and there is no key-recovery relationship in either direction between the main root key and V.
- The plan **as briefed** is **not safe to ship**, for three independent reasons: (i) 2048 PBKDF2 rounds against a user-invented password is a 30-bit vault; (ii) no verifier means a typo silently destroys funds and the UI blames "empty vault"; (iii) the recovery-shares advisory asserts something factually untrue and the mnemonic path is unreachable on a replacement device.
- With the four conditions in §5 it is safe, and it is a defensible product improvement — provided the product framing is "**24 words → 6 words**", not "**24 words → nothing**".

---

## 5. Conditions (all mandatory)

**C1 — App-side stretch.** `Hash.pbkdf2(s1, 'bsvb-vault-kdf-v2', 600_000, 64, 'sha512')` after `toSeed`. Native via quick-crypto; no new dependency. The BIP39-tool-compatibility objection is void (§3.3). Run it off the interaction path with a progress indicator; measure on the slowest supported device and lower the round count only if it exceeds ~1.5 s (never below 200 000).

**C2 — Password policy with a real floor.**
- **Default (recommended): app-generated 6-word BIP39-wordlist passphrase, 66 bits.** Generated with `services/vault/random.ts`'s CSPRNG, rejection-sampled to avoid modulo bias, joined by single spaces, lower-case ASCII only.
- **Advanced (opt-in): user-typed**, accepted only at **≥55 bits** by a conservative estimator (see §9 for the estimator contract). No warn-and-allow. Hard block.
- Reject empty, and reject leading/trailing whitespace outright (do not silently trim — silent trimming is another way to make two different-looking passwords collide). Internal spaces allowed.
- Field config: `secureTextEntry`, `autoCapitalize="none"`, `autoCorrect={false}`, `spellCheck={false}`, `textContentType="none"`, `autoComplete="off"`, `importantForAutofill="no"`. **Do not use `textContentType="newPassword"`** — it invites iOS Strong Password autofill and iCloud Keychain sync, which would place a vault factor in Apple's cloud and make Apple-account compromise + mnemonic sufficient to open the vault.

**C3 — Verifier + double entry + recovery card.** As specified in §3.4, all four parts.

**C4 — Gates and honest copy.**
- v2 enrollment requires `getMnemonic() != null`; share/WIF-restored wallets are refused with an explanatory error (or offered v1 as a fallback — §10 Q4).
- Enrollment copy states plainly: shares back up the *wallet*, not the vault.
- The "device + PIN **or** mnemonic + password, no third path" statement ships only once §3.5 R1/R2/R3 is satisfied, or is amended to name the device-intact precondition.

---

## 6. Where the plaintext mnemonic must be available, and the logging rule

**Needed at exactly two moments, both explicitly user-initiated:**
1. **Enrollment** — `enrollVaultV2` derives V from `(M, password)`.
2. **Mnemonic-path recovery** — `recoverVaultKeyV2` in `app/vault.tsx`'s `runRecovery` (`:98-113`).

**Never needed** for: deposits (pre-derived pkhs from meta), withdrawals (ceremony → seal → V), balance, replenishment, or day-to-day operation. **The hot path is unchanged and touches neither `M` nor the password.** Worth saying out loud: v2 does not make the mnemonic hot.

**Is it available there today?** Yes — `useLocalStorage().getMnemonic()` (`LocalStorageProvider.tsx:139-149`), gated by `ensureAuth` → `LocalAuthentication.authenticateAsync` (Face ID / Touch ID, device-passcode fallback enabled). `app/vault.tsx` does not currently consume `LocalStorageContext`; it would need to.

**Two problems to fix, not to inherit:**

- **The auth latch.** `authenticatedRef` (`LocalStorageProvider.tsx:64, 74`) makes every `getMnemonic()` after the first a silent read. Enrolling or recovering a vault is exactly the operation that should re-assert presence. **Add `getMnemonic(opts?: { force?: boolean })`** (or a dedicated `getMnemonicForVault()`) that bypasses the latch and always prompts. Do not weaken the latch globally — cold start already pays for it once (`WalletContext.tsx:1220-1222`).
- **New architectural coupling.** `services/vault/*` currently imports nothing from React contexts, which is why `ceremony.ts`/`VaultKeyService.ts` are unit-testable against the mock driver. **Do not import `LocalStorageProvider` into the service layer.** Pass a callback, exactly like the existing `getPin` seam (`VaultKeyService.ts:56`):

  ```ts
  enrollVaultV2({ nickname, onPhase, getPin, requestPinChange,
                  getMnemonic: () => Promise<string>,     // NEW
                  getVaultPassword: () => Promise<string> // NEW
                })
  ```
  Both callbacks are awaited **before** `withKeySession` opens, alongside the PIN — the iOS NFC scan sheet is modal and covers the app (`session.ts:5-9`), so no prompt can appear during the tap. This is a non-negotiable ordering constraint.

**Holding the "never log V, the seed, or the mnemonic" rule (`VaultKeyService.ts:16`):**

| Site | Risk | Required action |
|---|---|---|
| `VaultKeyService.ts` | New locals `mnemonic`, `password`, `s1`, `k` | Zero `s1`/`k` (`.fill(0)`) as in the pseudocode; never interpolate `M` or the password into any string; keep both out of `PendingEnrollment`. |
| `EnrollWizard.tsx:85` | `setError(… String(e))` renders raw error text | Never construct a `VaultError` whose `message` embeds `M` or the password. Add a lint-visible comment. Note `mnemonic2Seed`'s own throw text is safe. |
| `EnrollWizard.tsx:44, 48` | v1 held the phrase in React state + a ref | v2 holds the *password* instead. Clear on unmount and on success, mirroring `:116-117`. Never put it in `pendingRef`. |
| `WalletContext.tsx:1222` | `__DEV__ console.warn` prints *timings only* | Safe today. Any new perf breadcrumb around the stretch must print elapsed ms only. |
| `console.log` in `transfers.ts` / `privileged.ts:26` | Logs keyIDs, txids, `reason` | Unchanged and safe — never widen these to key material. |
| OS keyboard learning | A typed password can enter the predictive dictionary | `autoCorrect={false}`, `spellCheck={false}`, `keyboardType="default"`, `textContentType="none"`. |
| Screenshots / app switcher | v1 showed 24 words; v2 shows a generated 6-word phrase | Same exposure class as `app/auth/mnemonic.tsx`; apply whatever protection that screen uses (or add `FLAG_SECURE` on Android for both). |
| `showToast` / i18n interpolation | Any `t(key, { … })` carrying the secret | Prohibited. |

**Net:** the change introduces a bounded, user-initiated in-memory window for `M` and the password during enrollment and recovery only. That is acceptable and no worse than what `app/wallet-config.tsx:115, 137` already does when it reveals the phrase or prints shares — provided the table above is honoured.

---

## 7. Migration plan for existing v1 enrollments

### 7.1 Versioning — put the marker in SecureStore, not AsyncStorage

The naive plan is "bump `VaultMeta.v` to 2". **That is not sufficient.** `VaultMeta` lives in AsyncStorage (`vaultStore.ts:18, 64-66`); the seal lives in SecureStore (`:17, 50-52`). AsyncStorage is the volatile one — app-data clears and the DB import path can lose it while the seal survives, and `getMeta()` already returns `null` on unparseable JSON (`:59-61`). Version detection that depends on meta will misclassify v1 vaults as unknown at exactly the wrong moment.

**Specified:**
- `SealedBlob.v: 1 | 2` (`types.ts:9`) is the **authoritative provenance marker**. `v: 1` (or absent) ⇒ legacy random-mnemonic vault. `v: 2` ⇒ wallet-entropy vault.
- `SealedBlob` gains `vaultFingerprint?: string` (v2 only).
- `VaultMeta.v: 1 | 2` plus `vaultFingerprint?: string` — a convenience mirror, never the source of truth.
- The **sealing scheme itself is unchanged** — `SEAL_INFO` stays `'bsvb-vault-seal-v1'`, `sealVaultKey`/`unsealVaultKey` are untouched. `SealedBlob.v` now denotes *key provenance*, and that reinterpretation must be documented in the `types.ts` doc comment.
- All readers treat missing/unknown `v` as **1**.

### 7.2 Do not force-migrate

**Recommendation: leave v1 enrollments exactly as they are. v2 applies to new enrollments only.**

Reasons:
1. The v1 24-word phrase is already written down and already works. There is no security defect in v1 — if anything it is *stronger* (§3.2).
2. A migration is a **fund-moving operation**: sweep the vault to `default`, tear down the vault, re-enroll. Every step can fail, and it burns fees.
3. **`enrollVault` refuses an occupied PIV slot** (`VaultKeyService.ts:90-92`, `resealToNewKey` likewise at `:154-156`). Re-enrolling on the same YubiKey after a v1 vault would hit `slot-occupied`. A migration therefore *also* requires a new "re-key slot 0x82" path that overwrites the slot when `sha256(currentSlotPubKey) === seal.yubiPubSha256` (proving it is our own key and no third-party identity is being destroyed) — a genuinely destructive operation that today the code deliberately refuses to perform. **Adding it for a migration nobody needs is a bad trade.**

**Can funds be stranded?** Only by deleting code. Specifically:
- `recoverVaultKey(mnemonic)` (`VaultKeyService.ts:137-141`) **must not be removed or repurposed.** It is the only path for v1 users who lose their YubiKey. Rename to `recoverVaultKeyV1` and keep it.
- `RecoverSheet` must **branch on `seal.v`**: `v: 1` → 24-word phrase field (current UI); `v: 2` → password field with the fingerprint check. If the seal is unreadable, offer both.
- `disableVault` (`:179-181`) and the balance>0 guard (`app/vault.tsx:67-78`) are provenance-agnostic. Unchanged.

**Optional, user-initiated "Upgrade this vault"** (only if §10 Q3 says yes): sweep → disable → re-enroll on a *different* YubiKey, or on the same key after the re-key path exists. Must display an explicit warning that the 24-word vault phrase becomes worthless once the sweep confirms, and must not delete the seal until the sweep txid is confirmed.

### 7.3 Migration risk register

| Risk | Mitigation |
|---|---|
| A v1 user's `RecoverSheet` shows the v2 password field → they cannot recover | Branch on `seal.v`; default to v1 when the seal is missing or `v` is absent. |
| Meta lost, seal present | `seal.v` carries provenance; `seal.vaultFingerprint` carries the verifier. Both in SecureStore. |
| Seal lost (phone gone) | §3.5. Vault Recovery Card + `sweepVaultFromChain`. |
| A share-restored user tries to recover a v2 vault | Hard-blocked at enrollment (C4); plus an explicit error string at recovery. |
| Mixed-version test fixtures | New tests in §9 cover a v1 seal read by v2 code. |

---

## 8. UX copy

New i18n keys, English source. All 12 locale blocks in `context/i18n/translations.tsx` (`en, zh, hi, es, fr, ar, pt, bn, ru, id, ja, pl`) need entries; ship English fallbacks for the rest if translations lag.

### 8.1 (a) Pre-password advisory — **corrected**

> ⚠️ **The briefed wording ("print your Backup Recovery Shares first") is factually wrong and must not ship as-is.** Shares split `m/0'/0'`; they cannot rebuild the 12 words and therefore cannot rebuild the vault (§3.6). Keep the button — printing shares is good hygiene and the owner is right that it belongs here — but the copy must not imply it protects the vault.

```ts
vault_pw_prep_title:  'Before you choose a vault password',
vault_pw_prep_body:   'Your vault key is built from two things: your wallet recovery phrase and the vault password you are about to choose. If you lose either one, the only way back into your vault is your security key and its PIN.\n\nMake sure your 12-word wallet recovery phrase is written down and stored somewhere safe before you continue.',
vault_pw_prep_confirm:'I have my wallet recovery phrase',

vault_pw_prep_shares_title: 'Also recommended: print your Backup Recovery Shares',
vault_pw_prep_shares_body:  'Backup Recovery Shares restore your everyday wallet on a new phone — any 2 of the 3 printed pages. They are a good idea, but they do not restore your vault: the vault needs your 12-word phrase and your vault password. Print them now if you have not already.',
vault_pw_prep_shares_cta:   'Print Backup Recovery Shares',
```

The `vault_pw_prep_confirm` control is a **checkbox that gates the Continue button** — not a passive line of text. Best version, if §10 Q2 allows: replace the checkbox with a 2-word quiz against the *main* mnemonic (the app has it in memory at this point), reusing the quiz mechanic already in `EnrollWizard.tsx:76-81`. It costs almost nothing and it is the only way to actually verify the claim.

### 8.2 (b) Password prompt + confirm

**Generated variant (recommended default):**

```ts
vault_pw_gen_title:    'Your vault password',
vault_pw_gen_body:     'These six words are your vault password. Write them down and keep them with — but separate from — your wallet recovery phrase. We cannot show them to you again, and nobody can reset them.',
vault_pw_gen_reroll:   'Give me different words',
vault_pw_gen_saved:    'I have written it down',
vault_pw_gen_quiz_title: 'Confirm your vault password',
vault_pw_gen_quiz_sub:   'Enter the words we ask for, to confirm you wrote them down.',
vault_pw_gen_quiz_wrong: 'That does not match. Check what you wrote down.',
```

**Typed variant (advanced, behind the 55-bit floor):**

```ts
vault_pw_title:        'Choose your vault password',
vault_pw_body:         'This password, together with your 12-word wallet recovery phrase, is what rebuilds your vault key. It is not stored anywhere and it cannot be reset or recovered — not by us, not by anyone.',
vault_pw_placeholder:  'Vault password',
vault_pw_confirm_placeholder: 'Type it again',
vault_pw_mismatch:     'The two entries do not match.',
vault_pw_empty:        'A vault password is required.',
vault_pw_whitespace:   'Remove the space at the start or end — invisible spaces change the password.',
vault_pw_too_weak:     'Too easy to guess. Anyone who finds your recovery phrase could break this one in under a day.',
vault_pw_strength_label: 'Strength',
vault_pw_strength_1:   'Not enough',
vault_pw_strength_2:   'Still not enough',
vault_pw_strength_3:   'Acceptable',
vault_pw_strength_4:   'Strong',
vault_pw_no_typos:     'There is no spell-check for this. A single wrong character produces a different, empty vault — so type it carefully and store it exactly as written.',
```

### 8.3 (c) Recovery-paths statement

Shown at the end of enrollment, on the Vault Recovery Card, and in the vault's manage section.

```ts
vault_paths_title: 'Two ways into your vault. There is no third.',
vault_paths_body:  '1 — Your security key and its PIN.\n2 — Your 12-word wallet recovery phrase together with your vault password.\n\nThat is the complete list. This vault is self-custodial: there is no reset, no support ticket, and no backdoor. If you lose your security key AND either your recovery phrase or your vault password, the funds in this vault are gone permanently.',
vault_paths_ack:   'I understand there is no way to reset this',
```

If §3.5 R1/R2 do not ship, this **must** be amended to:

```
2 — Your 12-word wallet recovery phrase and your vault password, used on a phone
    that still has this wallet's data. Keep your wallet data backups current.
```

### 8.4 Errors

```ts
vault_err_vault_password_wrong:     'That vault password does not match this vault. Check for typos, capitals, and extra spaces.',
vault_err_vault_password_required:  'A vault password is required.',
vault_err_no_mnemonic:              'This wallet was restored from backup shares, so it has no 12-word recovery phrase. A vault needs one. Restore this wallet from its recovery phrase first.',
```

`vault_recover_sub` (`translations.tsx:256`) needs a v2 sibling:

```ts
vault_recover_v2_sub: 'Lost or broken security key? Enter your vault password to move all vault funds to your everyday balance and clear the vault. Your wallet recovery phrase is read from this device.',
```

---

## 9. Implementation plan

Ordered. Each step is independently testable.

### Step 1 — `services/vault/types.ts`
- `SealedBlob.v: 1 | 2`; add `vaultFingerprint?: string`. Update the doc comment (`:6-7`) to say `v` denotes **key provenance**, not seal format, and that the seal crypto is identical across versions.
- Add error codes to `VaultErrorCode` (`:24-44`): `'vault-password-wrong'`, `'vault-password-required'`, `'no-mnemonic'`.

### Step 2 — `services/vault/vaultStore.ts`
- `VaultMeta.v: 1 | 2`; add `vaultFingerprint?: string`. No behavioural change; `getMeta`/`setMeta` are already opaque JSON.

### Step 3 — `services/vault/kdf.ts` (new, pure, no I/O, no React)
- `deriveVaultKeyV2(mainMnemonic, vaultPassword): number[]` — §2.1.
- `vaultFingerprint(v: number[]): string` — §2.1.
- `estimatePasswordBits(pw: string): number` — conservative estimator. Contract: charset-size × length as an upper bound, then subtract for repeats, keyboard runs, ascending/descending sequences, dates, and membership in a small embedded top-10k list; **BIP39-wordlist passphrases are scored as exactly 11 bits/word** so a generated phrase scores honestly. Do not add `zxcvbn` (≈800 kB); `@zxcvbn-ts/core` + the en dictionary is acceptable if bundle budget allows, but the in-house estimator must be *conservative* (under-estimate), never generous.
- `generateVaultPassphrase(words = 6): string` — CSPRNG from `services/vault/random.ts`, rejection-sampled against the BIP39 English wordlist (importable from `@bsv/sdk`'s `compat/bip-39-wordlist-en`), single-space joined.
- `normalizeVaultPassword(pw): string` — NFKD only. **Explicitly does not trim.** Whitespace at the edges is rejected upstream, not silently removed.
- Module header: the same `SECURITY: never log …` banner as `sealing.ts:16`.

### Step 4 — `services/vault/VaultKeyService.ts`
- Rename `deriveVaultKey` → `deriveVaultKeyV1` (keep it — v1 recovery depends on it).
- Rename `recoverVaultKey` → `recoverVaultKeyV1` (`:137-141`); keep the export name as an alias for one release to avoid breaking `app/vault.tsx:27` mid-refactor.
- New `recoverVaultKeyV2(mainMnemonic, vaultPassword, expectedFingerprint?): Promise<PrivateKey>` — derives, fingerprints, and throws `VaultError('vault-password-wrong')` on mismatch **before** returning.
- `enrollVault` → add `getMnemonic` and `getVaultPassword` callbacks. **Both awaited in the "ALL user input up front" block at `:65-78`, before `withKeySession`** — the NFC ordering constraint. Throw `VaultError('no-mnemonic')` if `getMnemonic()` resolves null/empty.
- Replace `:104-105`:
  ```ts
  const v = deriveVaultKeyV2(mainMnemonic, vaultPassword)
  const fp = vaultFingerprint(v)
  ```
  Return type drops `backupMnemonic`; `PendingEnrollment` is unchanged in shape.
- `sealVaultKey` call (`:112`) gains the `v: 2` + `vaultFingerprint` fields (threaded through `sealing.ts`'s `meta` argument).
- `meta` (`:113-121`): `v: 2`, `vaultFingerprint: fp`.
- Zero `mainMnemonic`-derived intermediates; `v.fill(0)` stays (`:124`).
- `resealToNewKey` (`:144-175`): stamp `v: 2` when the caller supplies a v2 fingerprint; keep writing `v: 1` otherwise. It is currently **unreferenced anywhere in the app** — decide in §10 Q5 whether to wire or delete it.

### Step 5 — `services/vault/sealing.ts`
- `sealVaultKey(v, yubiPubHex, meta: { slot, serial, version?: 1 | 2, vaultFingerprint?: string })` → emit those fields into the blob. **Do not touch `SEAL_INFO`, the HKDF, or the AES-GCM layer** — the seal crypto is deliberately unchanged so every existing seal still opens.

### Step 6 — `context/LocalStorageProvider.tsx`
- `getMnemonic(opts?: { force?: boolean })`; when `force`, bypass `authenticatedRef` (`:74`) and always run `authenticateAsync`. Extend `LocalStorageContextType` (`:18`) and the default context (`:47`).

### Step 7 — `components/vault/EnrollWizard.tsx`
- `Step` (`:26`) becomes `'intro' | 'prep' | 'password' | 'running' | 'confirm' | 'done'`. The `'backup'` word-grid step (`:187-207`) is **deleted**.
- New `'prep'` step: §8.1 copy, the Print-Shares button (extract `handlePrintRecoveryShares` from `app/wallet-config.tsx:130-161` into `utils/backupShares.ts` or a small hook so all three call sites share one implementation), and the gating checkbox or main-mnemonic quiz.
- New `'password'` step: generated-passphrase display + reroll + quiz, or the typed variant with double entry and the live strength meter. Field props per C2.
- `start()` (`:63-90`) passes `getMnemonic: () => getMnemonic({ force: true })` and `getVaultPassword`.
- `confirmQuiz` (`:106-123`) confirms the *vault password*, then `finalizeEnrollment`. Preserve the "nothing reaches disk until confirmation" invariant (`VaultKeyService.ts:107-110`) — it is the reason the current design is safe against a mid-flow abort.
- Clear the password from state and refs on success and on unmount (mirror `:116-117`).
- After `'done'`: offer the Vault Recovery Card print.

### Step 8 — `components/vault/RecoverSheet.tsx`
- Accept `sealVersion: 1 | 2` and `expectedFingerprint?: string`.
- `v: 1` → today's 24-word field and word-count check (`:31-35`), unchanged.
- `v: 2` → single password field + `getMnemonic({ force: true })` + fingerprint pre-check. **Surface `vault-password-wrong` distinctly** — the current blanket `catch` at `:41-43` collapses everything into `vault_recover_failed` and would re-introduce the exact hazard §3.4 exists to prevent.

### Step 9 — `app/vault.tsx`
- `runRecovery` (`:98-113`) branches on the seal version; reads it in `reload()` (`:51-55`) via `vaultStore.getSeal()`.
- Add the "Recover a vault from another device" entry to the not-enrolled branch (`:161-181`) — §3.5 R2.
- Add "Print Vault Recovery Card" to the manage section (`:238-253`).

### Step 10 — `context/i18n/translations.tsx`
- Add every key from §8 to all 12 locale blocks. Retire `vault_backup_*` (`:193-198`) only after v1 recovery copy is confirmed to no longer reference them — `vault_recover_sub` (`:256`) stays for v1.

### Step 11 — `utils/backupShares.ts` / print card
- New `generateVaultCardHTML({ nickname, yubiSerial, enrolledAt, fingerprint, depositPkhs })`. Reuse `generateQRCodeSVG` (`:97-105`) and the page CSS. **Explicit "This page contains no secrets" banner**, and an explicit "this is not a substitute for your recovery phrase or vault password" line.

### Step 12 (conditional) — `services/vault/transfers.ts`
- `sweepVaultFromChain(v, chainClient)` per §3.5 R1. Reuses `buildVaultUnlockingScript` (`:159`) verbatim; only the UTXO source changes.

### 9.1 Existing tests that break

| Test | Line | Why | Fix |
|---|---|---|---|
| `vaultKeyService.test.ts` "enroll builds seal + 64 deposit keys + phrase but does NOT persist until finalize" | `:45-76` | Destructures `backupMnemonic` (`:47`), asserts `.split(' ').length === 24` (`:53`), calls `recoverVaultKey(backupMnemonic)` (`:73`) | Split into a v1 test (against `enrollVaultV1`, if retained) and a v2 test using `getMnemonic`/`getVaultPassword` stubs and `recoverVaultKeyV2` |
| …"the sealed V unseals through the YubiKey ceremony (ECDH)" | `:78-92` | Same destructure; compares token-V to phrase-V (`:90`) | Compare token-V to `deriveVaultKeyV2(testMnemonic, testPassword)` |
| …"a factory-PIN key forces a PIN change" | `:94-106` | `enrollVault` now requires the two new callbacks | Add stubs |
| …"a non-factory PIN never triggers a change" | `:108-123` | same | Add stubs |
| …"enroll refuses a key whose PIN is already blocked" | `:125-136` | same | Add stubs |
| …"enroll refuses to overwrite an occupied PIV slot" | `:138-145` | same | Add stubs |
| …"session-based enroll (NFC)" | `:147-176` | same; **and the `order` assertion at `:172` (`['pin-entered','session-start']`) must be extended** to prove mnemonic + password are collected before `session-start` | `expect(order).toEqual(['pin-entered','mnemonic-read','password-entered','session-start'])` — this is the NFC-ordering regression guard, do not drop it |
| …"recoverVaultKey rejects an invalid phrase" | `:178-180` | Renamed symbol | Point at `recoverVaultKeyV1` |
| …"disableVault clears the seal and meta" | `:182-188` | Callback signature | Add stubs |
| `vaultStore.test.ts` "meta round trip" | `:48-64` | Asserts `toEqual` on a `v: 1` meta object | Passes as-is (extra fields are optional); **add** a v2 round-trip covering `vaultFingerprint` |
| `sealing.test.ts` | — | Only if the fixture asserts an exact blob shape | Verify; likely additive-safe |
| `ceremony.test.ts`, `transfers.test.ts`, `guard.test.ts`, `privileged.test.ts`, `mockYubiKey.test.ts` | — | Provenance-agnostic | **Must remain green untouched.** If any of them changes, the change has leaked into the ceremony/spend path and is wrong. |

### 9.2 New tests required

**`__tests__/vault/kdf.test.ts`**
1. Known-answer vector: fixed 12-word mnemonic + fixed password → fixed V hex (pin the derivation forever).
2. Empty password throws `vault-password-required`.
3. `deriveVaultKeyV2(m, p1) !== deriveVaultKeyV2(m, p2)` for `p1 ≠ p2`, including single-character differences.
4. `deriveVaultKeyV2(m, p) !== HD.fromSeed(Mnemonic.fromString(m).toSeed('')).privKey` — V is never the main root key.
5. NFKD: two Unicode-equivalent spellings of the same password yield the same V.
6. Whitespace: `'pw '` and `'pw'` yield **different** V (proves normalization is not silently trimming) — and the policy layer rejects the former.
7. **Purity: `deriveVaultKeyV2` is deterministic across calls and processes.** Guards §2.3.
8. `vaultFingerprint` is stable, 16 hex chars, and differs for differing V.
9. `estimatePasswordBits`: a generated 6-word phrase scores ≥ 60; `'Password123!'` scores < 40; `'aaaaaaaaaaaa'` scores < 25.
10. `generateVaultPassphrase(6)` → 6 distinct-ish wordlist words; 1000 samples show no modulo bias beyond tolerance.

**`__tests__/vault/vaultKeyServiceV2.test.ts`**
11. Enroll v2 → seal has `v: 2` and a fingerprint; meta has `v: 2`.
12. Deposit pkhs in meta match `deriveDepositKeys(deriveVaultKeyV2(m, p), 0, 64)`.
13. Token-ECDH unseal yields exactly `deriveVaultKeyV2(m, p)`.
14. `recoverVaultKeyV2` with the wrong password throws `vault-password-wrong` — **and never reaches `sweepVaultWithKey`**.
15. `recoverVaultKeyV2` with the right password returns V.
16. `getMnemonic` resolving null throws `no-mnemonic` and **persists nothing**.
17. Ordering: mnemonic and password are both collected before `driver.start()` on a session-based driver.
18. Nothing persists until `finalizeEnrollment` (carry `:57-60` forward verbatim).

**`__tests__/vault/migration.test.ts`**
19. A v1 seal (no `v` field / `v: 1`, no fingerprint) is classified as v1 and `recoverVaultKeyV1` still opens it.
20. A v1 seal with **missing meta** still classifies as v1 from the seal alone.
21. A v2 seal with missing meta still yields the fingerprint from the seal.
22. Unknown future `v` (e.g. `3`) is treated as v1 and does not crash.

**Leak guard (cheap, high value): `__tests__/vault/noLeak.test.ts`**
23. Spy on `console.log/warn/error/debug` across a full v2 enroll + recover cycle; assert no emitted string contains the test mnemonic, any of its words in sequence, the password, or the hex of V.

---

## 10. Open questions and risks for the product owner

**Q1 — Generated passphrase or user-typed password?** *This is the decision that determines whether the feature is secure.* Recommendation: **generated 6 words**. A user-invented password puts the vault's second recovery path at 25–40 bits, i.e. hours of GPU time once the mnemonic is known (§3.3). If the answer is "user-typed", the hard 55-bit floor in C2 is not negotiable, and the marketing must not describe the vault as protecting against a compromised recovery phrase.

**Q2 — Accept that the second secret is not eliminated?** The honest framing is **24 words → 6 words**. If the requirement is genuinely *zero* second secrets, the only coherent design is **Option C: `V = HKDF-SHA256(seed(M,''), salt='bsvb-vault-v2', info='vault-key')`, no password at all.** Then the vault's guarantee is precisely: *"protects against a compromised phone, malware, and hostile web pages — not against someone who has your recovery phrase."* That is a defensible, honest product, it has zero typo risk, zero extra backup burden, and it is what I would ship if "no second secret" is a hard requirement. **What is not defensible is a weak password that looks like protection and is not.**

**Q3 — Migrate existing v1 vaults?** Recommendation: **no.** §7.2. Migration requires a new destructive PIV slot-overwrite path that the code deliberately refuses today.

**Q4 — Share-restored wallets: refuse v2, or fall back to v1?** They have no mnemonic (§3.6). Refusing is simpler and honest; falling back to a v1 random phrase keeps the feature available but means two vault flavours in the field forever. Recommendation: **refuse, with copy explaining how to restore from the phrase instead.**

**Q5 — `resealToNewKey` is dead code.** `VaultKeyService.ts:144-175` is referenced nowhere outside its own definition. Wire it (replace a lost YubiKey without sweeping) or delete it — do not carry an unreferenced fund-adjacent code path through a versioning change.

**Q6 — Ship the "no third path" copy before §3.5 is fixed?** Recommendation: **no.** Until `sweepVaultFromChain` or the recovery card exists, the second path only works on a device that still holds the wallet's storage. Shipping the absolute claim first is a promise the code does not keep.

### Risk register

| # | Risk | Severity | Status |
|---|---|---|---|
| 1 | Mnemonic+password recovery does not work on a replacement device (`transfers.ts:245-262`, `app/vault.tsx:161-181`) | **Critical** | Open — §3.5 |
| 2 | "Print your recovery shares first" is factually false; share-restored wallets cannot enroll or recover (`backupShares.ts:20-27`, `WalletContext.tsx:1278-1327`) | **Critical** | Open — §3.6, C4 |
| 3 | Weak password + 2048 rounds = a vault that falls in hours to a mnemonic holder | **High** | Mitigated by C1+C2 |
| 4 | Silent typo → valid-but-empty vault, reported as "vault empty" | **High** | Mitigated by C3 |
| 5 | Correlated loss: one piece of paper now unlocks the whole estate | **High** | Inherent to the design. Requires explicit owner acceptance. |
| 6 | Any per-device randomness in the KDF silently breaks recovery | **High** | Prevented by §2.3 + test 7 |
| 7 | `authenticatedRef` latch lets vault enrollment/recovery read the mnemonic with no biometric prompt | Medium | Fixed by Step 6 |
| 8 | iOS Strong Password / iCloud Keychain syncing the vault password to Apple | Medium | Prevented by C2 field config |
| 9 | Version detection based on AsyncStorage meta misclassifies v1 vaults after a data clear | Medium | Fixed by §7.1 (marker in the seal) |
| 10 | NFC ordering regression — a new prompt appearing under the modal scan sheet | Medium | Guarded by test 17 |
| 11 | The stretch blocks the JS thread past the app's 100 ms budget | Low | Native pbkdf2; measure and gate behind a progress phase |
| 12 | `resealToNewKey` left unversioned and unreferenced | Low | §10 Q5 |
