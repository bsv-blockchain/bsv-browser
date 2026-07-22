//! `native-engine-ffi` — M5.1 shippable FFI promotion of the M5.3-PASSED
//! kill-test spike `native-engine-poc` (docs/TIER3-ENGINE-DESIGN.md is the
//! authoritative spec; the spike's behavior — 200,000 differential cases vs the
//! app's exact patched `@bsv/sdk@2.1.6`, 0 mismatches — is FROZEN here:
//! `tests/spike_parity.rs` pins this crate byte-equal to the spike, and the
//! rust-harness `engine_corpus` drift sample re-proves it against the JS oracle).
//!
//! What changed vs the spike (and ONLY this):
//!   • UniFFI 0.28 proc-macro layer (`setup_scaffolding!` + `#[uniffi::export]`)
//!     over the same four seam values: `Vec<u8>` / `u32` / `u64` / `String`;
//!   • THE SIGN CORE (ratified decision, issue #19 comment 2026-07-21): ECDSA
//!     runs on bitcoin-core libsecp256k1 (`secp256k1 =0.31.1`, the exact
//!     native-secp-poc dep — RFC 6979, always-low-S, byte-exact vs the SDK over
//!     155,148+ M1–M4 fuzz cases and 3.7× faster than k256), NOT
//!     `bsv_rs::PrivateKey::sign` (k256). k256 stays ONLY inside bsv-rs
//!     internals for non-signing math; DER equality of the two cores for every
//!     digest < n is pinned by `tests/sign_core_crosscheck.rs`, and the k256
//!     digest≥n RFC-6979 asymmetry (unreachable, ~2^-128) exits the signing
//!     path entirely with this swap;
//!   • privkey scalars are zeroized via the `zeroize` crate (the spike used a
//!     volatile-write best effort).
//!
//! Seam rules carried over verbatim from the design doc and the spike:
//!   • bytes-only: no k256/secp256k1 type ever crosses the FFI;
//!   • **signing order only** — the display-order `compute_sighash`
//!     (bsv-rs sighash.rs:401) never appears here, killing the order-confusion
//!     trap at the API;
//!   • only FORKID, non-CHRONICLE scopes are accepted; anything else is
//!     `Err(UnsupportedScope)` → the caller's JS fallback (the SDK's OTDA /
//!     usesOtdaSingleBug constant-0x01 path stays in JS, never re-implemented);
//!   • reject-on-any-invalid-element: one bad record fails the whole batch;
//!   • native returns unlocking scripts; the CALLER splices the tx — the
//!     byte-parity surface is the script bytes, never native re-serialization.
//!
//! Framing convention (design doc §3, documented once here and in the Nitro
//! spec `packages/react-native-engine-native/src/specs/EngineNative.nitro.ts`):
//! multi-value buffers are records in meta order; fixed-width fields raw,
//! variable-width fields length-prefixed. Txids cross in INTERNAL byte order;
//! JS converts at the hex boundary. Every fallible fn returns
//! `Result<_, EngineError>` → Swift throws → Promise reject; the caller falls
//! back per-op to JS (the M3 contract).
//!
//! MIDSTATE OWNERSHIP (updated at bsv-rs 1dca471 / 0.3.18, issue #28 EXIT):
//! bsv-rs now ships the upstream `SighashCache` (midstates computed lazily
//! once per scope class, safe under mixed scopes on one instance — the
//! M5.x upstreaming of the kill-test finding). The engine-side `MidstateCache`
//! duplicate that lived here is DELETED; this crate uses `bsv_rs::…::SighashCache`
//! directly, so there is exactly one preimage implementation across the stack.
//! The spike `native-engine-poc` keeps ITS engine-side cache untouched — it is
//! the frozen M5.3 proof artifact, and `tests/spike_parity.rs` (old cache vs
//! this crate on the new cache) is the proof the switch changed nothing.

uniffi::setup_scaffolding!();

use bsv_rs::primitives::bsv::sighash::{parse_transaction, SighashCache};
use bsv_rs::primitives::hash::{hash160, sha256d};
use bsv_rs::transaction::Beef;
use bsv_rs::{from_hex, to_hex};
use secp256k1::{Message, SecretKey, SECP256K1};
use zeroize::Zeroize;

/// BSV-specific FORKID flag (BIP-143 style hashing) — required on every scope.
pub const SIGHASH_FORKID: u32 = 0x40;
/// Chronicle flag (`@bsv/sdk@2.1.6` `TransactionSignature.SIGHASH_CHRONICLE`).
/// A scope carrying it routes to the SDK's OTDA preimage — the engine must
/// NEVER sign it (bsv-rs has no OTDA path; fallback to JS is mandatory).
pub const SIGHASH_CHRONICLE: u32 = 0x20;

/// Fixed meta record width: [u32 LE inputIndex][32B privkey][u64 LE satoshis]
/// [u32 LE sigScope][25B P2PKH lockingScript] (design doc §3).
const META_RECORD_LEN: usize = 4 + 32 + 8 + 4 + 25;

/// Fixed VERIFY meta record width: [u32 LE inputIndex][u64 LE satoshis]
/// [25B P2PKH lockingScript] (design doc §3, the M5.B verify leg). No privkey
/// and no scope: verify reads the SIGNED tx's own unlocking scripts, so the
/// pubkey, DER signature and sigScope byte all come out of the tx itself — the
/// prevout satoshis + locking script are the only per-input facts the tx cannot
/// carry (they belong to the funding output).
const VERIFY_META_RECORD_LEN: usize = 4 + 8 + 25;

/// The failure modes of the seam (design doc §3). Bytes-only boundary — the
/// caller falls back per-op to the pure-JS path on ANY error (M3 contract).
/// Fielded uniffi error: Swift sees typed cases; the Nitro layer rethrows and
/// the JS seam treats any rejection as "fall back".
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, uniffi::Error)]
pub enum EngineError {
    #[error("bad framing")]
    BadFraming,
    #[error("transaction parse failed")]
    TxParse,
    #[error("input {input_index}: locking script is not P2PKH-shaped")]
    NotP2pkh { input_index: u32 },
    #[error("input {input_index}: unsupported sighash scope (FORKID required, CHRONICLE unsupported)")]
    UnsupportedScope { input_index: u32 },
    #[error("input index out of range")]
    IndexOutOfRange,
    #[error("invalid BEEF")]
    BeefInvalid,
    #[error("crypto error: {0}")]
    Crypto(String),
}

/// FORKID present, CHRONICLE absent — the ONLY scope class the engine signs.
fn scope_supported(scope: u32) -> bool {
    scope & SIGHASH_FORKID != 0 && scope & SIGHASH_CHRONICLE == 0
}

/// `OP_DUP OP_HASH160 <20B> OP_EQUALVERIFY OP_CHECKSIG` shape check.
fn is_p2pkh(lock25: &[u8]) -> bool {
    lock25.len() == 25
        && lock25[0] == 0x76
        && lock25[1] == 0xa9
        && lock25[2] == 0x14
        && lock25[23] == 0x88
        && lock25[24] == 0xac
}

struct MetaRecord {
    input_index: u32,
    privkey: [u8; 32],
    satoshis: u64,
    scope: u32,
    lock: [u8; 25],
}

impl Drop for MetaRecord {
    fn drop(&mut self) {
        // Design doc §3: "Privkey scalars zeroized after use."
        self.privkey.zeroize();
    }
}

fn parse_meta(inputs_meta: &[u8]) -> Result<Vec<MetaRecord>, EngineError> {
    if inputs_meta.is_empty() || inputs_meta.len() % META_RECORD_LEN != 0 {
        return Err(EngineError::BadFraming);
    }
    let mut out = Vec::with_capacity(inputs_meta.len() / META_RECORD_LEN);
    for rec in inputs_meta.chunks_exact(META_RECORD_LEN) {
        let input_index = u32::from_le_bytes(rec[0..4].try_into().unwrap());
        let mut privkey = [0u8; 32];
        privkey.copy_from_slice(&rec[4..36]);
        let satoshis = u64::from_le_bytes(rec[36..44].try_into().unwrap());
        let scope = u32::from_le_bytes(rec[44..48].try_into().unwrap());
        let mut lock = [0u8; 25];
        lock.copy_from_slice(&rec[48..73]);
        out.push(MetaRecord { input_index, privkey, satoshis, scope, lock });
    }
    Ok(out)
}

/// Signs all P2PKH inputs described by `inputs_meta` against `unsigned_tx`
/// (outpoints + sequences are read from the tx itself — single source of
/// truth; the tx's input scripts are ignored).
///
/// `inputs_meta`: N fixed 73-byte records
///   `[u32 LE inputIndex][32B privkey][u64 LE satoshis][u32 LE sigScope][25B P2PKH lockingScript]`
///
/// Returns framed per-record, same order as the meta:
///   `[u32 LE inputIndex][u8 len][unlockingScript]`
/// where unlockingScript = `push(DER‖scopeByte) push(pubkey33)` — byte-identical
/// to the SDK P2PKH template's `UnlockingScript` for the same input (proven:
/// 200k-case M5.3 gate on the spike + spike-parity test + drift sample here).
///
/// ECDSA core: libsecp256k1 (`SECP256K1.sign_ecdsa` — RFC 6979, always low-S),
/// the ratified #19 sign path. DER bytes equal the SDK's
/// `sig.toDER()‖scopeByte` (`toChecksigFormat`) exactly.
///
/// Reject-on-any-invalid-element: any bad record fails the WHOLE call and the
/// caller falls back to the pure-JS path for the whole tx.
#[uniffi::export]
pub fn batch_sign_p2pkh_inputs(
    unsigned_tx: Vec<u8>,
    mut inputs_meta: Vec<u8>,
) -> Result<Vec<u8>, EngineError> {
    batch_sign_zeroizing(&unsigned_tx, &mut inputs_meta)
}

/// Signs, then ZEROES the privkey-bearing input buffer in place (CR-3, issue
/// #31, caveat B3). The UniFFI `Vec<u8>` input RustBuffer carries the raw
/// privkey scalars: `parse_meta` copies each into a `MetaRecord` (zeroized on
/// Drop) and the libsecp `SecretKey` is erased after signing, but the ORIGINAL
/// input allocation would be freed WITHOUT being cleared, leaving privkey bytes
/// resident in the freed RustBuffer heap. This wipes it before it drops,
/// regardless of success or failure. Split out (taking `&mut Vec<u8>`) so a
/// test can hold the buffer and assert it is cleared post-call — the `Vec` the
/// `#[uniffi::export]` wrapper owns is consumed and unobservable otherwise.
fn batch_sign_zeroizing(
    unsigned_tx: &[u8],
    inputs_meta: &mut Vec<u8>,
) -> Result<Vec<u8>, EngineError> {
    let out = batch_sign_p2pkh_inputs_inner(unsigned_tx, inputs_meta);
    inputs_meta.zeroize();
    out
}

fn batch_sign_p2pkh_inputs_inner(
    unsigned_tx: &[u8],
    inputs_meta: &[u8],
) -> Result<Vec<u8>, EngineError> {
    let tx = parse_transaction(unsigned_tx).map_err(|_| EngineError::TxParse)?;
    let metas = parse_meta(inputs_meta)?;

    // Validate EVERY record before signing anything (no partial work on reject).
    for m in &metas {
        if m.input_index as usize >= tx.inputs.len() {
            return Err(EngineError::IndexOutOfRange);
        }
        if !scope_supported(m.scope) {
            return Err(EngineError::UnsupportedScope { input_index: m.input_index });
        }
        if !is_p2pkh(&m.lock) {
            return Err(EngineError::NotP2pkh { input_index: m.input_index });
        }
    }

    // Upstream midstate reuse (bsv-rs ≥0.3.18): one SighashCache serves every
    // record — midstates computed once per scope class, mixed scopes safe on
    // one instance (byte-identical to the deleted engine-side MidstateCache;
    // proven by tests/spike_parity.rs vs the frozen spike).
    let mut cache = SighashCache::new(&tx);
    let mut out = Vec::with_capacity(metas.len() * (4 + 1 + 108));
    for m in &metas {
        let preimage = cache
            .preimage(m.input_index as usize, &m.lock, m.satoshis, m.scope)
            .map_err(|_| EngineError::IndexOutOfRange)?; // unreachable: index pre-validated
        let sighash = sha256d(&preimage); // signing order — never reversed here
        let mut sk = SecretKey::from_byte_array(m.privkey)
            .map_err(|e| EngineError::Crypto(format!("privkey[{}]: {e}", m.input_index)))?;
        let der = SECP256K1.sign_ecdsa(Message::from_digest(sighash), &sk).serialize_der();
        let pubkey = sk.public_key(SECP256K1).serialize();
        sk.non_secure_erase();

        // checksig format = DER ‖ scope low byte — identical to both the SDK's
        // toChecksigFormat and bsv-rs TransactionSignature::to_checksig_format.
        let script_len = 1 + (der.len() + 1) + 1 + 33;
        out.extend_from_slice(&m.input_index.to_le_bytes());
        out.push(script_len as u8);
        out.push((der.len() + 1) as u8); // direct push (< 0x4c)
        out.extend_from_slice(&der);
        out.push((m.scope & 0xff) as u8);
        out.push(33);
        out.extend_from_slice(&pubkey);
    }
    Ok(out)
}

struct VerifyMetaRecord {
    input_index: u32,
    satoshis: u64,
    lock: [u8; 25],
}

fn parse_verify_meta(prevouts_meta: &[u8]) -> Result<Vec<VerifyMetaRecord>, EngineError> {
    if prevouts_meta.is_empty() || prevouts_meta.len() % VERIFY_META_RECORD_LEN != 0 {
        return Err(EngineError::BadFraming);
    }
    let mut out = Vec::with_capacity(prevouts_meta.len() / VERIFY_META_RECORD_LEN);
    for rec in prevouts_meta.chunks_exact(VERIFY_META_RECORD_LEN) {
        let input_index = u32::from_le_bytes(rec[0..4].try_into().unwrap());
        let satoshis = u64::from_le_bytes(rec[4..12].try_into().unwrap());
        let mut lock = [0u8; 25];
        lock.copy_from_slice(&rec[12..37]);
        out.push(VerifyMetaRecord { input_index, satoshis, lock });
    }
    Ok(out)
}

/// Canonical P2PKH unlocking script shape: exactly `push(DER‖scopeByte)
/// push(pubkey33)`, both DIRECT pushes (opcode < OP_PUSHDATA1 = 0x4c), nothing
/// trailing. Returns `(sig_with_scope, pubkey33)` on a match, else `None` (→ the
/// caller defers that whole tx to the JS `Spend` interpreter — never a silent
/// weakening of validation, design doc §3 / issue #24).
fn parse_p2pkh_unlock(script: &[u8]) -> Option<(&[u8], &[u8])> {
    if script.is_empty() {
        return None;
    }
    let l1 = script[0] as usize;
    // sig element = DER (≥ 8 bytes) + 1 scope byte; a direct push < 0x4c.
    if l1 < 2 || l1 >= 0x4c {
        return None;
    }
    let sig_end = 1 + l1;
    // room for the pubkey push opcode
    if script.len() <= sig_end {
        return None;
    }
    if script[sig_end] as usize != 33 {
        return None;
    }
    let pk_start = sig_end + 1;
    let pk_end = pk_start + 33;
    // exactly two pushes — nothing trailing (a third push / opcode is not the
    // template the engine handles).
    if script.len() != pk_end {
        return None;
    }
    Some((&script[1..sig_end], &script[pk_start..pk_end]))
}

/// The CHECKSIG verdict for ONE canonical P2PKH input, byte-for-byte matching
/// the SDK `Spend` interpreter's default-flags acceptance (the exact
/// construction the toolbox `verifyUnlockScripts` uses — no explicit
/// verifyFlags):
///   • strict DER (BIP66) on the signature — `Signature::from_der` (the SDK's
///     `isChecksigFormatHelper` gate, `shouldEnforceDerSignatures()` = true);
///   • low-S enforced iff `!isRelaxed()` i.e. `tx.version <= 1`
///     (`shouldEnforceLowS()`), rejecting high-S BEFORE the math, exactly as the
///     SDK's "signature must have a low S value" branch;
///   • compressed pubkey must be a valid curve point (`checkPublicKeyEncoding` +
///     `PublicKey::fromDER`);
///   • the ECDSA math itself accepts ANY s ∈ [1, n-1] (the SDK's pure-JS
///     `verify`) — libsecp's `verify_ecdsa` requires low-S, so we normalize the
///     *verification copy* first; this changes nothing about acceptance, only
///     satisfies the C API.
/// Returns 0x01 (valid) / 0x00 (invalid). NEVER returns 0x01 for anything the
/// JS verdict would reject (issue #24 gate: native must never accept what JS
/// rejects).
#[allow(clippy::too_many_arguments)]
fn verify_one(
    cache: &mut SighashCache,
    input_index: usize,
    lock: &[u8],
    satoshis: u64,
    scope: u32,
    der: &[u8],
    pubkey: &[u8],
    enforce_low_s: bool,
) -> u8 {
    use secp256k1::ecdsa::Signature;
    use secp256k1::PublicKey;

    let sig = match Signature::from_der(der) {
        Ok(s) => s,
        Err(_) => return 0x00, // non-strict-DER → JS rejects too
    };
    // Low-S encoding gate (SDK `shouldEnforceLowS()` = !isRelaxed()).
    let mut norm = sig;
    norm.normalize_s();
    let was_high_s = norm.serialize_compact() != sig.serialize_compact();
    if enforce_low_s && was_high_s {
        return 0x00;
    }
    let pk = match PublicKey::from_slice(pubkey) {
        Ok(p) => p,
        Err(_) => return 0x00,
    };
    let preimage = match cache.preimage(input_index, lock, satoshis, scope) {
        Ok(p) => p,
        Err(_) => return 0x00, // unreachable: index pre-validated
    };
    let digest = sha256d(&preimage); // signing order — never reversed here
    // `norm` is the low-S-normalized copy; math acceptance is identical to the
    // original (r, s) but satisfies libsecp's low-S requirement.
    match SECP256K1.verify_ecdsa(Message::from_digest(digest), &norm, &pk) {
        Ok(()) => 0x01,
        Err(_) => 0x00,
    }
}

/// Verifies all P2PKH inputs of one SIGNED tx against their prevout satoshis +
/// locking scripts — ONE crossing for the whole tx, replacing the toolbox
/// `verifyUnlockScripts` per-input fresh-`Spend` interpreter + n sync ECDSA
/// crossings (docs/TIER3-ENGINE-DESIGN.md §M5.B; consumes the batchEcdsaVerify
/// debt, caveat A7).
///
/// `prevouts_meta`: N fixed 37-byte records
///   `[u32 LE inputIndex][u64 LE satoshis][25B P2PKH lockingScript]`
/// (outpoints/sequences/version and every input's unlocking script are read
/// from `signed_tx` — single source of truth).
///
/// Returns a per-record verdict byte in meta order: `0x01` valid, `0x00`
/// invalid. The verdict for each input equals the SDK `Spend` interpreter's
/// default-flags CHECKSIG result (see `verify_one`), so byte-for-byte
/// shadow-mode comparison against the JS verdict is meaningful.
///
/// MANDATORY P2PKH shape (never silently weaken validation, design doc §3):
/// each input's unlocking script must be exactly `push(sig‖scopeByte)
/// push(33B pubkey)` with `hash160(pubkey) == lock pkh` and the sigScope byte a
/// supported FORKID/non-CHRONICLE scope; ANY input failing this fails the WHOLE
/// call (`Err(NotP2pkh{i})` / `Err(UnsupportedScope{i})`) and the caller runs
/// the full JS `Spend` on the tx. Reject-on-any-invalid mirrors the sign path.
#[uniffi::export]
pub fn batch_verify_p2pkh_inputs(
    signed_tx: Vec<u8>,
    prevouts_meta: Vec<u8>,
) -> Result<Vec<u8>, EngineError> {
    let tx = parse_transaction(&signed_tx).map_err(|_| EngineError::TxParse)?;
    let metas = parse_verify_meta(&prevouts_meta)?;

    // isRelaxed() = (transactionVersion > 1) → low-S NOT enforced (the SDK
    // `Spend` default-flags semantics: `shouldEnforceLowS()` = !isRelaxed()).
    let enforce_low_s = tx.version <= 1;

    // One SighashCache for the whole tx — midstates computed once per scope
    // class (bsv-rs ≥0.3.18 upstream cache), identical to the sign path.
    let mut cache = SighashCache::new(&tx);
    let mut verdicts = Vec::with_capacity(metas.len());
    for m in &metas {
        let idx = m.input_index as usize;
        if idx >= tx.inputs.len() {
            return Err(EngineError::IndexOutOfRange);
        }
        if !is_p2pkh(&m.lock) {
            return Err(EngineError::NotP2pkh { input_index: m.input_index });
        }
        let (sig_with_scope, pubkey) = match parse_p2pkh_unlock(&tx.inputs[idx].script) {
            Some(v) => v,
            None => return Err(EngineError::NotP2pkh { input_index: m.input_index }),
        };
        // scope byte = the last byte of the checksig-format signature element.
        let scope = (*sig_with_scope.last().unwrap()) as u32; // len ≥ 2 by parse
        if !scope_supported(scope) {
            // no-FORKID (legacy sighash) / CHRONICLE → bsv-rs has no such
            // preimage; defer the whole tx to JS (never guess).
            return Err(EngineError::UnsupportedScope { input_index: m.input_index });
        }
        // hash160(pubkey) must equal the lock's pkh, else this is not the
        // canonical P2PKH input the engine verifies → defer to JS full Spend.
        if hash160(pubkey)[..] != m.lock[3..23] {
            return Err(EngineError::NotP2pkh { input_index: m.input_index });
        }
        let der = &sig_with_scope[..sig_with_scope.len() - 1];
        verdicts.push(verify_one(
            &mut cache,
            idx,
            &m.lock,
            m.satoshis,
            scope,
            der,
            pubkey,
            enforce_low_s,
        ));
    }
    Ok(verdicts)
}

/// Conformance/debug export (design doc §1): one sighash, **signing order
/// only** (internal byte order, ready for ECDSA). Never routed in prod.
#[uniffi::export]
pub fn compute_sighash_signing_order(
    raw_tx: Vec<u8>,
    input_index: u32,
    // Named `subscript_script`, NOT `subscript`: `subscript` is a Swift KEYWORD
    // and nitrogen emits it unescaped (invalid Swift); UniFFI backtick-escapes
    // it, but the name must match the Nitro spec end-to-end (M5.1 wall #1).
    subscript_script: Vec<u8>,
    satoshis: u64,
    scope: u32,
) -> Result<Vec<u8>, EngineError> {
    Ok(sha256d(&compute_sighash_preimage_signing(raw_tx, input_index, subscript_script, satoshis, scope)?).to_vec())
}

/// Conformance-only companion (NOT exported over FFI, pub for the rust-harness
/// differential gate + tests): the full BIP-143 preimage bytes, so any fuzz
/// divergence is localizable to a specific preimage field (design doc §6:
/// "hash-only vectors make a preimage bug visible but unlocalizable").
pub fn compute_sighash_preimage_signing(
    raw_tx: Vec<u8>,
    input_index: u32,
    subscript: Vec<u8>,
    satoshis: u64,
    scope: u32,
) -> Result<Vec<u8>, EngineError> {
    let tx = parse_transaction(&raw_tx).map_err(|_| EngineError::TxParse)?;
    if input_index as usize >= tx.inputs.len() {
        return Err(EngineError::IndexOutOfRange);
    }
    if !scope_supported(scope) {
        return Err(EngineError::UnsupportedScope { input_index });
    }
    SighashCache::new(&tx)
        .preimage(input_index as usize, &subscript, satoshis, scope)
        .map_err(|_| EngineError::IndexOutOfRange) // unreachable: index pre-validated
}

// ════════════════════════════════════════════════════════════════════════════
// M5.9 (issue #27) — READ-ONLY BEEF leg (design doc §M5.C).
//
// Two bytes-only exports over bsv-rs `transaction::beef`. HARD READ-ONLY: the
// engine NEVER re-emits BEEF (no `to_binary`/`to_binary_atomic`/`sort_txs` on
// the return path), so the BRC-95/96 byte-ordering drift class stays
// structurally impossible — exactly the design-doc §M5.C stance. Both fns parse
// with `Beef::from_binary` and return either a positive result or
// `Err(BeefInvalid)`; the caller falls back to the pure-JS BEEF path on any
// rejection (the M3 contract), and — during rollout — dev builds assert the
// native EF bytes equal the JS `Transaction.fromBEEF().toEF()` round-trip.
//
// FINDING (bsv-rs 0.3.18, READ-ONLY — recorded in M5.9-RESULTS.md): bsv-rs
// `Transaction::from_beef` / `Beef::find_atomic_transaction` do NOT hydrate an
// input's `source_transaction` from the other txs in the BEEF (beef.rs:139
// "Would need to populate source transactions - simplified for now"). The SDK's
// `Transaction.fromBEEF` DOES link them, and `to_ef()` needs each input's
// parent to read the prevout satoshis + locking script. So `beef_to_ef` here
// hydrates the immediate parents itself, from the BEEF's own txs, using only
// bsv-rs's public API (`find_txid` + the public `source_transaction` field) —
// bsv-rs is not modified.
// ════════════════════════════════════════════════════════════════════════════

/// Structural BEEF verification (design doc §M5.C): parse + `verify_valid`, then
/// return the per-block-height merkle roots for the caller's JS
/// `chainTracker.isValidRootForHeight` step. A "BEEF verified" claim is
/// structural + roots + the JS-checked headers — never structural alone; this
/// fn delivers only the first two.
///
/// `allow_txid_only = false`: the internalizeAction / EF-conversion contract
/// requires a fully-hydrated BEEF (no txid-only leaves), the strictest verdict.
/// The oracle compares against the SDK `Beef.isValid(false)` under the same rule.
///
/// Returns, on a structurally-valid BEEF, roots framed in ASCENDING block height
/// for determinism (design doc §3 shape):
///   `[u32 LE count]([u32 LE blockHeight][32B merkleRoot, display order])*`
/// The merkle root bytes are display order (the `MerklePath::compute_root` hex
/// string decoded as-is — the same order a block header carries), so JS hands
/// them straight to the chain tracker without a byte reversal.
///
/// `Err(BeefInvalid)` on any parse failure OR `verify_valid` = false — the
/// single verdict the SDK's `isValid` boolean maps to. READ-ONLY: no
/// re-serialization occurs.
#[uniffi::export]
pub fn beef_verify_structure(beef: Vec<u8>) -> Result<Vec<u8>, EngineError> {
    let mut parsed = Beef::from_binary(&beef).map_err(|_| EngineError::BeefInvalid)?;
    let result = parsed.verify_valid(false);
    if !result.valid {
        return Err(EngineError::BeefInvalid);
    }
    // Deterministic frame: sort heights ascending (HashMap iteration order is
    // non-deterministic, and the seam must be byte-stable across runs/devices).
    let mut heights: Vec<u32> = result.roots.keys().copied().collect();
    heights.sort_unstable();
    let mut out = Vec::with_capacity(4 + heights.len() * (4 + 32));
    out.extend_from_slice(&(heights.len() as u32).to_le_bytes());
    for h in heights {
        let root_bytes = from_hex(&result.roots[&h]).map_err(|_| EngineError::BeefInvalid)?;
        if root_bytes.len() != 32 {
            return Err(EngineError::BeefInvalid);
        }
        out.extend_from_slice(&h.to_le_bytes());
        out.extend_from_slice(&root_bytes);
    }
    Ok(out)
}

/// BEEF → Extended Format (BRC-30) conversion (design doc §M5.C), replacing the
/// `services/arcadeBroadcastProvider.ts` serialize→reparse→toEF round-trip. The
/// output is byte-identical to the SDK's `Transaction.fromBEEF(beef, txid).toEF()`
/// (proven: the M5.9 `beef` fuzz class vs the app's patched @bsv/sdk@2.1.6, plus
/// the tx-003→tx-004 conformance anchor below).
///
/// `txid`: the subject transaction, in INTERNAL byte order (32 bytes) — JS
/// converts at the hex boundary, per the seam convention. An EMPTY `txid`
/// selects the subject the way the SDK's `fromAnyBeef` does:
/// `atomic_txid ?? last tx`.
///
/// READ-ONLY: this reads the BEEF and emits EF; it never re-emits BEEF.
///
/// `Err(BeefInvalid)` on parse failure, unknown/absent subject txid, a
/// txid-only subject, or any missing ancestry that leaves an input without the
/// source output `to_ef` requires. `Err(BadFraming)` if `txid` is a non-empty
/// wrong length.
#[uniffi::export]
pub fn beef_to_ef(beef: Vec<u8>, txid: Vec<u8>) -> Result<Vec<u8>, EngineError> {
    let parsed = Beef::from_binary(&beef).map_err(|_| EngineError::BeefInvalid)?;

    // Subject selection mirrors the SDK's `Transaction.fromAnyBeef`:
    // explicit txid ?? atomicTxid ?? last tx.
    let target_txid: String = if txid.is_empty() {
        parsed
            .atomic_txid
            .clone()
            .or_else(|| parsed.txs.last().map(|b| b.txid()))
            .ok_or(EngineError::BeefInvalid)?
    } else {
        if txid.len() != 32 {
            return Err(EngineError::BadFraming);
        }
        let mut display = txid;
        display.reverse(); // internal → display (reversed hex, the find_txid domain)
        to_hex(&display)
    };

    let mut tx = parsed
        .find_txid(&target_txid)
        .and_then(|b| b.tx().cloned())
        .ok_or(EngineError::BeefInvalid)?;

    // Hydrate each input's immediate parent from the BEEF's own txs (the bsv-rs
    // FINDING above). `to_ef` reads source_output[vout] for satoshis + lock.
    for input in &mut tx.inputs {
        let src_txid = input.get_source_txid().map_err(|_| EngineError::BeefInvalid)?;
        if let Some(src) = parsed.find_txid(&src_txid).and_then(|b| b.tx().cloned()) {
            input.source_transaction = Some(Box::new(src));
        }
    }

    tx.to_ef().map_err(|_| EngineError::BeefInvalid)
}

/// Probe + proof-artifact stamping (design doc §3 shape:
/// `"bsv-rs <hash> / engine-ffi <version>"` + the ratified sign core).
#[uniffi::export]
pub fn engine_version() -> String {
    format!(
        "bsv-rs {} / engine-ffi {} / sign-core libsecp256k1 (secp256k1 0.31.1)",
        env!("BSV_RS_COMMIT"),
        env!("CARGO_PKG_VERSION")
    )
}

/// Trivial FFI smoke fn (issue #19 exit proof): echoes the payload back
/// unchanged. Exercises the whole ArrayBuffer → Data → RustBuffer → Vec<u8>
/// round-trip without touching any crypto.
#[uniffi::export]
pub fn engine_ping(payload: Vec<u8>) -> Vec<u8> {
    payload
}

#[cfg(test)]
mod tests {
    use super::*;
    use bsv_rs::primitives::bsv::sighash::SIGHASH_ALL;
    use bsv_rs::primitives::ec::PrivateKey;
    use bsv_rs::primitives::encoding::Writer;

    /// Deterministic little tx builder: n_in inputs, n_out outputs.
    fn tx_bytes(n_in: usize, n_out: usize) -> Vec<u8> {
        let mut w = Writer::new();
        w.write_i32_le(1);
        w.write_var_int(n_in as u64);
        for i in 0..n_in {
            let mut txid = [0u8; 32];
            txid[0] = i as u8;
            txid[31] = 0xaa;
            w.write_bytes(&txid);
            w.write_u32_le(i as u32);
            w.write_var_int(0);
            w.write_u32_le(0xffff_ffff - i as u32);
        }
        w.write_var_int(n_out as u64);
        for i in 0..n_out {
            w.write_u64_le(1000 + i as u64);
            let script = [0x76, 0xa9, 0x14, i as u8, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 0x88, 0xac];
            w.write_var_int(script.len() as u64 + 1);
            w.write_bytes(&[0x76]);
            w.write_bytes(&script[1..]);
            w.write_bytes(&[script[0]]); // arbitrary but deterministic bytes
        }
        w.write_u32_le(17);
        w.into_bytes()
    }

    const LOCK: [u8; 25] = [
        0x76, 0xa9, 0x14, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 0x88, 0xac,
    ];

    // DELETED HERE (issue #28 EXIT): `midstate_preimage_equals_bsv_rs` and
    // `single_out_of_range_matches_bsv_rs` — they pinned the engine-side
    // MidstateCache byte-equal to bsv-rs `build_sighash_preimage`. The engine
    // now calls the upstream `SighashCache` directly, and that equality (all 8
    // scope classes × every input, mixed scopes on one cache, SINGLE-OOR zeros
    // branch) is owned by bsv-rs 0.3.18's own unit tests + 499-vector suite.
    // The seam contract that REMAINS here: tests/spike_parity.rs (this crate
    // on the upstream cache vs the frozen spike on the old engine cache) and
    // the scope/framing/output-shape tests below.

    /// Scope gate: CHRONICLE and missing-FORKID must Err, never sign.
    #[test]
    fn unsupported_scopes_err() {
        let raw = tx_bytes(2, 1);
        let mut meta = Vec::new();
        meta.extend_from_slice(&0u32.to_le_bytes());
        meta.extend_from_slice(&[0x11u8; 32]);
        meta.extend_from_slice(&1000u64.to_le_bytes());
        meta.extend_from_slice(&(SIGHASH_ALL | SIGHASH_FORKID | SIGHASH_CHRONICLE).to_le_bytes());
        meta.extend_from_slice(&LOCK);
        assert_eq!(
            batch_sign_p2pkh_inputs(raw.clone(), meta.clone()),
            Err(EngineError::UnsupportedScope { input_index: 0 })
        );
        // no FORKID
        meta[44..48].copy_from_slice(&SIGHASH_ALL.to_le_bytes());
        assert_eq!(
            batch_sign_p2pkh_inputs(raw.clone(), meta.clone()),
            Err(EngineError::UnsupportedScope { input_index: 0 })
        );
        // sane scope but bad lock shape
        meta[44..48].copy_from_slice(&(SIGHASH_ALL | SIGHASH_FORKID).to_le_bytes());
        meta[48] = 0x77;
        assert_eq!(
            batch_sign_p2pkh_inputs(raw.clone(), meta.clone()),
            Err(EngineError::NotP2pkh { input_index: 0 })
        );
        // index out of range
        meta[48] = 0x76;
        meta[0..4].copy_from_slice(&9u32.to_le_bytes());
        assert_eq!(batch_sign_p2pkh_inputs(raw.clone(), meta.clone()), Err(EngineError::IndexOutOfRange));
        // framing
        assert_eq!(batch_sign_p2pkh_inputs(raw.clone(), vec![0u8; 72]), Err(EngineError::BadFraming));
        assert_eq!(batch_sign_p2pkh_inputs(raw, Vec::new()), Err(EngineError::BadFraming));
    }

    /// CR-3 (issue #31, caveat B3): the privkey-bearing input meta buffer is
    /// fully zeroized after signing. Holds the buffer across the zeroizing inner
    /// call and asserts every byte is 0 afterward (retires the M5.1 hardening
    /// asterisk 5 — the input RustBuffer is no longer freed with live secrets).
    #[test]
    fn input_meta_buffer_zeroized() {
        let raw = tx_bytes(2, 1);
        let scope = SIGHASH_ALL | SIGHASH_FORKID;
        let mut meta = Vec::new();
        for i in 0..2u32 {
            meta.extend_from_slice(&i.to_le_bytes());
            meta.extend_from_slice(&[0x11u8 + i as u8; 32]); // recognizable privkey bytes
            meta.extend_from_slice(&(1000u64 + u64::from(i)).to_le_bytes());
            meta.extend_from_slice(&scope.to_le_bytes());
            meta.extend_from_slice(&LOCK);
        }
        assert!(meta.iter().any(|&b| b != 0), "precondition: meta carries nonzero privkey bytes");
        let out = batch_sign_zeroizing(&raw, &mut meta);
        assert!(out.is_ok(), "sign should succeed: {out:?}");
        assert!(
            meta.iter().all(|&b| b == 0),
            "CR-3: input meta buffer must be fully zeroized after signing"
        );
    }

    /// Sign output framing: [u32 idx][u8 len][push(sig‖scope) push(pub33)], and
    /// the sighash under the signature equals compute_sighash_signing_order.
    /// (Signature verified via bsv-rs — deliberately the OTHER stack than the
    /// libsecp sign core, a mini cross-check on every run.)
    #[test]
    fn batch_sign_output_shape() {
        let raw = tx_bytes(3, 2);
        let scope = SIGHASH_ALL | SIGHASH_FORKID;
        let mut meta = Vec::new();
        for i in 0..3u32 {
            meta.extend_from_slice(&i.to_le_bytes());
            meta.extend_from_slice(&[0x22u8 + i as u8; 32]);
            meta.extend_from_slice(&(600u64 + u64::from(i)).to_le_bytes());
            meta.extend_from_slice(&scope.to_le_bytes());
            meta.extend_from_slice(&LOCK);
        }
        let framed = batch_sign_p2pkh_inputs(raw.clone(), meta).unwrap();
        let mut off = 0usize;
        for i in 0..3u32 {
            let idx = u32::from_le_bytes(framed[off..off + 4].try_into().unwrap());
            assert_eq!(idx, i);
            let len = framed[off + 4] as usize;
            let script = &framed[off + 5..off + 5 + len];
            // shape: [sigLen][der‖scopeByte][33][pubkey]
            let sig_len = script[0] as usize;
            assert_eq!(script[sig_len], scope as u8, "scope byte trails the DER");
            assert_eq!(script[1 + sig_len] as usize, 33);
            assert_eq!(script.len(), 1 + sig_len + 1 + 33);
            // signature verifies against the signing-order sighash
            let sighash = compute_sighash_signing_order(raw.clone(), i, LOCK.to_vec(), 600 + u64::from(i), scope).unwrap();
            let key = PrivateKey::from_bytes(&[0x22u8 + i as u8; 32]).unwrap();
            let der = &script[1..sig_len]; // DER without trailing scope byte
            let sig = bsv_rs::primitives::ec::Signature::from_der(der).unwrap();
            assert!(key.public_key().verify(&sighash.try_into().unwrap(), &sig));
            off += 5 + len;
        }
        assert_eq!(off, framed.len());
    }

    /// Build the SAME deterministic tx as `tx_bytes` but with per-input
    /// unlocking scripts spliced in (empty slice → unsigned skeleton). The
    /// non-script fields are byte-identical to `tx_bytes(n_in, n_out)`, so a
    /// signature made over the unsigned form verifies against the signed form.
    fn tx_with_scripts(n_in: usize, n_out: usize, scripts: &[Vec<u8>]) -> Vec<u8> {
        let mut w = Writer::new();
        w.write_i32_le(1);
        w.write_var_int(n_in as u64);
        for i in 0..n_in {
            let mut txid = [0u8; 32];
            txid[0] = i as u8;
            txid[31] = 0xaa;
            w.write_bytes(&txid);
            w.write_u32_le(i as u32);
            let s = scripts.get(i).map(|v| v.as_slice()).unwrap_or(&[]);
            w.write_var_int(s.len() as u64);
            w.write_bytes(s);
            w.write_u32_le(0xffff_ffff - i as u32);
        }
        w.write_var_int(n_out as u64);
        for i in 0..n_out {
            w.write_u64_le(1000 + i as u64);
            let script = [0x76, 0xa9, 0x14, i as u8, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 0x88, 0xac];
            w.write_var_int(script.len() as u64 + 1);
            w.write_bytes(&[0x76]);
            w.write_bytes(&script[1..]);
            w.write_bytes(&[script[0]]);
        }
        w.write_u32_le(17);
        w.into_bytes()
    }

    /// Derive the canonical 25-byte P2PKH lock for a raw privkey (libsecp
    /// compressed pubkey → hash160), so verify's `hash160(pubkey)==lock pkh`
    /// gate passes and the sign subscript matches the prevout script.
    fn lock_for(privkey: &[u8; 32]) -> [u8; 25] {
        let sk = SecretKey::from_byte_array(*privkey).unwrap();
        let pk = sk.public_key(SECP256K1).serialize();
        let pkh = hash160(&pk);
        let mut lock = [0u8; 25];
        lock[0] = 0x76;
        lock[1] = 0xa9;
        lock[2] = 0x14;
        lock[3..23].copy_from_slice(&pkh);
        lock[23] = 0x88;
        lock[24] = 0xac;
        lock
    }

    /// Parse the framed sign reply `[u32 idx][u8 len][script]*` → idx→script.
    fn parse_framed(framed: &[u8]) -> std::collections::HashMap<u32, Vec<u8>> {
        let mut m = std::collections::HashMap::new();
        let mut off = 0usize;
        while off < framed.len() {
            let idx = u32::from_le_bytes(framed[off..off + 4].try_into().unwrap());
            let len = framed[off + 4] as usize;
            m.insert(idx, framed[off + 5..off + 5 + len].to_vec());
            off += 5 + len;
        }
        m
    }

    /// Sign → splice → verify: all inputs must verify; then a single flipped sig
    /// byte flips exactly that verdict to invalid; then a broken unlock shape
    /// fails the whole call (defer to JS). Verdict semantics cross-checked
    /// against the OTHER stack (libsecp verify) inside `batch_verify`.
    #[test]
    fn batch_verify_round_trip_and_reject() {
        let n_in = 3usize;
        let n_out = 2usize;
        let scope = SIGHASH_ALL | SIGHASH_FORKID;
        let privs: [[u8; 32]; 3] = [[0x31u8; 32], [0x32u8; 32], [0x33u8; 32]];
        let sats: [u64; 3] = [600, 601, 602];

        // Sign meta (73B) with per-key canonical locks.
        let unsigned = tx_bytes(n_in, n_out);
        let mut sign_meta = Vec::new();
        for i in 0..n_in {
            sign_meta.extend_from_slice(&(i as u32).to_le_bytes());
            sign_meta.extend_from_slice(&privs[i]);
            sign_meta.extend_from_slice(&sats[i].to_le_bytes());
            sign_meta.extend_from_slice(&scope.to_le_bytes());
            sign_meta.extend_from_slice(&lock_for(&privs[i]));
        }
        let framed = batch_sign_p2pkh_inputs(unsigned, sign_meta).unwrap();
        let scripts_map = parse_framed(&framed);
        let scripts: Vec<Vec<u8>> = (0..n_in).map(|i| scripts_map[&(i as u32)].clone()).collect();
        let signed = tx_with_scripts(n_in, n_out, &scripts);

        // Verify meta (37B).
        let build_verify_meta = |locks: &[[u8; 25]; 3]| {
            let mut m = Vec::new();
            for i in 0..n_in {
                m.extend_from_slice(&(i as u32).to_le_bytes());
                m.extend_from_slice(&sats[i].to_le_bytes());
                m.extend_from_slice(&locks[i]);
            }
            m
        };
        let locks = [lock_for(&privs[0]), lock_for(&privs[1]), lock_for(&privs[2])];
        let verify_meta = build_verify_meta(&locks);

        // All valid.
        assert_eq!(
            batch_verify_p2pkh_inputs(signed.clone(), verify_meta.clone()).unwrap(),
            vec![0x01, 0x01, 0x01]
        );

        // Flip one byte inside input 1's DER signature body → only that verdict
        // flips to invalid (the r/s no longer matches the digest).
        let mut corrupt = scripts.clone();
        // sig element starts at offset 1 (after the push-len opcode); flip a
        // byte in the middle of the DER (well inside r/s, not the length/scope).
        let mid = 10.min(corrupt[1].len().saturating_sub(2));
        corrupt[1][mid] ^= 0x01;
        let signed_corrupt = tx_with_scripts(n_in, n_out, &corrupt);
        let v = batch_verify_p2pkh_inputs(signed_corrupt, verify_meta.clone()).unwrap();
        assert_eq!(v[0], 0x01);
        assert_eq!(v[1], 0x00, "corrupted sig on input 1 must be invalid");
        assert_eq!(v[2], 0x01);

        // Framing / range guards.
        assert_eq!(
            batch_verify_p2pkh_inputs(signed.clone(), vec![0u8; 36]),
            Err(EngineError::BadFraming)
        );
        let mut oor = build_verify_meta(&locks);
        oor[0..4].copy_from_slice(&9u32.to_le_bytes());
        assert_eq!(batch_verify_p2pkh_inputs(signed.clone(), oor), Err(EngineError::IndexOutOfRange));

        // hash160(pubkey) != lock pkh → NotP2pkh (defer to JS) — swap input 0's
        // lock for input 1's key hash.
        let mut wrong_locks = locks;
        wrong_locks[0] = lock_for(&privs[2]);
        assert_eq!(
            batch_verify_p2pkh_inputs(signed.clone(), build_verify_meta(&wrong_locks)),
            Err(EngineError::NotP2pkh { input_index: 0 })
        );

        // Broken unlock shape (trailing byte) on input 2 → whole call Errs.
        let mut bad_shape = scripts.clone();
        bad_shape[2].push(0x51); // OP_1 trailing — no longer the two-push template
        let signed_bad = tx_with_scripts(n_in, n_out, &bad_shape);
        assert_eq!(
            batch_verify_p2pkh_inputs(signed_bad, verify_meta),
            Err(EngineError::NotP2pkh { input_index: 2 })
        );
    }

    /// engine_ping echoes; engine_version carries the stamp fields.
    #[test]
    fn ping_and_version() {
        assert_eq!(engine_ping(vec![1, 2, 3, 0xff]), vec![1, 2, 3, 0xff]);
        assert_eq!(engine_ping(Vec::new()), Vec::<u8>::new());
        let v = engine_version();
        assert!(v.contains("bsv-rs "), "{v}");
        assert!(v.contains("engine-ffi 0.1.0"), "{v}");
        assert!(v.contains("libsecp256k1"), "{v}");
    }

    // ── M5.9 BEEF leg (issue #27) ──────────────────────────────────────────
    //
    // Conformance ANCHOR: ts-stack serialization.json tx-003 (a V1 BEEF whose
    // SUBJECT tx is the same tx as tx-004's EF) + tx-003's expected merkle_root.
    // These pin beef_to_ef byte-equal to the SDK's EF and beef_verify_structure's
    // root byte-equal to the SDK's computeRoot, with no oracle process needed.

    /// tx-003 `beef_hex` (V1 BEEF: parent-with-BUMP + subject spending it).
    const BEEF_V1_TX003: &str = "0100beef01fe636d0c0007021400fe507c0c7aa754cef1f7889d5fd395cf1f785dd7de98eed895dbedfe4e5bc70d1502ac4e164f5bc16746bb0868404292ac8318bbac3800e4aad13a014da427adce3e010b00bc4ff395efd11719b277694cface5aa50d085a0bb81f613f70313acd28cf4557010400574b2d9142b8d28b61d88e3b2c3f44d858411356b49a28a4643b6d1a6a092a5201030051a05fc84d531b5d250c23f4f886f6812f9fe3f402d61607f977b4ecd2701c19010000fd781529d58fc2523cf396a7f25440b409857e7e221766c57214b1d38c7b481f01010062f542f45ea3660f86c013ced80534cb5fd4c19d66c56e7e8c5d4bf2d40acc5e010100b121e91836fd7cd5102b654e9f72f3cf6fdbfd0b161c53a9c54b12c841126331020100000001cd4e4cac3c7b56920d1e7655e7e260d31f29d9a388d04910f1bbd72304a79029010000006b483045022100e75279a205a547c445719420aa3138bf14743e3f42618e5f86a19bde14bb95f7022064777d34776b05d816daf1699493fcdf2ef5a5ab1ad710d9c97bfb5b8f7cef3641210263e2dee22b1ddc5e11f6fab8bcd2378bdd19580d640501ea956ec0e786f93e76ffffffff013e660000000000001976a9146bfd5c7fbe21529d45803dbcf0c87dd3c71efbc288ac0000000001000100000001ac4e164f5bc16746bb0868404292ac8318bbac3800e4aad13a014da427adce3e000000006a47304402203a61a2e931612b4bda08d541cfb980885173b8dcf64a3471238ae7abcd368d6402204cbf24f04b9aa2256d8901f0ed97866603d2be8324c2bfb7a37bf8fc90edd5b441210263e2dee22b1ddc5e11f6fab8bcd2378bdd19580d640501ea956ec0e786f93e76ffffffff013c660000000000001976a9146bfd5c7fbe21529d45803dbcf0c87dd3c71efbc288ac0000000000";
    /// tx-004 `ef_hex` — the SDK EF of tx-003's subject tx (the parity target).
    const EF_TX004: &str = "010000000000000000ef01ac4e164f5bc16746bb0868404292ac8318bbac3800e4aad13a014da427adce3e000000006a47304402203a61a2e931612b4bda08d541cfb980885173b8dcf64a3471238ae7abcd368d6402204cbf24f04b9aa2256d8901f0ed97866603d2be8324c2bfb7a37bf8fc90edd5b441210263e2dee22b1ddc5e11f6fab8bcd2378bdd19580d640501ea956ec0e786f93e76ffffffff3e660000000000001976a9146bfd5c7fbe21529d45803dbcf0c87dd3c71efbc288ac013c660000000000001976a9146bfd5c7fbe21529d45803dbcf0c87dd3c71efbc288ac00000000";
    /// tx-003 expected `merkle_root` (display order).
    const ROOT_TX003: &str = "bb6f640cc4ee56bf38eb5a1969ac0c16caa2d3d202b22bf3735d10eec0ca6e00";

    /// beef_to_ef(V1 BEEF, empty txid → subject) is byte-identical to the SDK EF.
    #[test]
    fn beef_to_ef_matches_sdk_ef_vector() {
        let beef = hex::decode(BEEF_V1_TX003).unwrap();
        let ef = beef_to_ef(beef, Vec::new()).expect("beef_to_ef ok");
        assert_eq!(hex::encode(&ef), EF_TX004, "EF bytes must match SDK toEF");
    }

    /// Explicit INTERNAL-order txid selects the same subject as the empty default.
    #[test]
    fn beef_to_ef_explicit_txid_selects_subject() {
        let beef = hex::decode(BEEF_V1_TX003).unwrap();
        // Derive the subject txid from bsv-rs (display order) → internal (reversed)
        // 32B, the seam convention, avoiding any hand-transcription.
        let parsed = Beef::from_binary(&beef).unwrap();
        let subject_display = parsed.txs.last().unwrap().txid();
        let mut internal = hex::decode(&subject_display).unwrap();
        internal.reverse();
        let ef = beef_to_ef(beef, internal).expect("explicit txid ok");
        assert_eq!(hex::encode(&ef), EF_TX004);
    }

    /// beef_verify_structure accepts the valid BEEF and returns the SDK root.
    #[test]
    fn beef_verify_structure_valid_root_matches_sdk() {
        let beef = hex::decode(BEEF_V1_TX003).unwrap();
        let out = beef_verify_structure(beef).expect("valid BEEF");
        let count = u32::from_le_bytes(out[0..4].try_into().unwrap());
        assert_eq!(count, 1, "one BUMP → one height/root");
        // record: [u32 height][32B root]
        let root = hex::encode(&out[8..40]);
        assert_eq!(root, ROOT_TX003, "root must match SDK computeRoot (display order)");
        assert_eq!(out.len(), 4 + (4 + 32), "exactly one root record");
    }

    /// Garbage / truncated BEEF → Err(BeefInvalid) on both fns (never a panic).
    #[test]
    fn beef_rejects_garbage() {
        for bad in [
            vec![],
            vec![0xde, 0xad, 0xbe, 0xef, 0x00],
            hex::decode(BEEF_V1_TX003).unwrap()[..40].to_vec(), // truncated
        ] {
            assert_eq!(beef_verify_structure(bad.clone()), Err(EngineError::BeefInvalid));
            assert_eq!(beef_to_ef(bad, Vec::new()), Err(EngineError::BeefInvalid));
        }
        // wrong-length explicit txid → BadFraming.
        let beef = hex::decode(BEEF_V1_TX003).unwrap();
        assert_eq!(beef_to_ef(beef, vec![0u8; 31]), Err(EngineError::BadFraming));
    }
}
