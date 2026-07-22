//! `native-engine-poc` — M5.3 KILL-TEST spike for the Tier-3 native transaction
//! engine (docs/TIER3-ENGINE-DESIGN.md is the authoritative spec; this crate is
//! its §1-FIRST surface, host-only).
//!
//! What this proves (or kills): that a Rust engine composed over bsv-rs can
//! produce **byte-identical signed-transaction bytes** to the app's exact
//! patched `@bsv/sdk@2.1.6` `Transaction.sign` path, with the three BIP-143
//! midstates (hashPrevouts / hashSequence / hashOutputs) computed **once per
//! scope-class per transaction** instead of once per input (the measured
//! ~0.5 ms/input JS cost center, O(n²) on the SDK's uncached fallback path).
//!
//! Seam rules carried over from the design doc:
//!   • bytes-only: `Vec<u8>` / `u32` / `u64` / `String` in and out;
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
//! MIDSTATE FINDING (recorded, per the spike rules): bsv-rs has **no
//! midstate-reuse API** — `build_sighash_preimage` /
//! `compute_sighash_for_signing` (`bsv-rs/src/primitives/bsv/sighash.rs:313-424`)
//! recompute hash_prevouts + hash_sequence + hash_outputs on every call, so
//! calling it per input is O(n²) hashing exactly like the un-cached SDK. The
//! cache below therefore lives ENGINE-SIDE (design doc §2 "Ownership note");
//! the per-component logic is a faithful port of the same module's private
//! `compute_hash_prevouts` / `compute_hash_sequence` / `compute_hash_outputs`,
//! and `tests/` assert byte-equality against `build_sighash_preimage` on every
//! path so the port can never drift from bsv-rs.

use std::collections::HashMap;

use bsv_rs::primitives::bsv::sighash::{
    parse_transaction, RawTransaction, SIGHASH_ANYONECANPAY, SIGHASH_NONE, SIGHASH_SINGLE,
};
use bsv_rs::primitives::bsv::tx_signature::TransactionSignature;
use bsv_rs::primitives::ec::PrivateKey;
use bsv_rs::primitives::encoding::Writer;
use bsv_rs::primitives::hash::sha256d;

/// BSV-specific FORKID flag (BIP-143 style hashing) — required on every scope.
pub const SIGHASH_FORKID: u32 = 0x40;
/// Chronicle flag (`@bsv/sdk@2.1.6` `TransactionSignature.SIGHASH_CHRONICLE`).
/// A scope carrying it routes to the SDK's OTDA preimage — the engine must
/// NEVER sign it (bsv-rs has no OTDA path; fallback to JS is mandatory).
pub const SIGHASH_CHRONICLE: u32 = 0x20;

/// Mask for the base sighash type — mirrors both bsv-rs (`SIGHASH_BASE_MASK`)
/// and the SDK (`scope & 31`).
const BASE_MASK: u32 = 0x1f;

/// Fixed meta record width: [u32 LE inputIndex][32B privkey][u64 LE satoshis]
/// [u32 LE sigScope][25B P2PKH lockingScript] (design doc §3).
const META_RECORD_LEN: usize = 4 + 32 + 8 + 4 + 25;

/// The failure modes of the seam (design doc §3). Bytes-only boundary — the
/// caller falls back per-op to the pure-JS path on ANY error (M3 contract).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
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

/// Engine-side midstate cache: each of the three BIP-143 hashes is computed at
/// most once per scope-class per transaction, then reused across inputs.
///
/// Cache keys (why these are complete):
///   hashPrevouts — depends only on (tx inputs, ANYONECANPAY): zeros under ACP,
///                  one shared value otherwise;
///   hashSequence — zeros unless (!ACP && base ∉ {SINGLE, NONE}), one shared
///                  value in that class;
///   hashOutputs  — one shared value for the ALL-class (base ∉ {SINGLE, NONE}),
///                  per-input-index values for in-range SINGLE, zeros for NONE
///                  and out-of-range SINGLE (the (a) fund-loss family: the SDK's
///                  FORKID path uses ZEROS there — usesOtdaSingleBug's constant
///                  0x01 digest is OTDA-only — and the fuzz gate proves we match
///                  the SDK, whatever it does).
pub struct MidstateCache {
    prevouts: Option<[u8; 32]>,
    sequence: Option<[u8; 32]>,
    outputs_all: Option<[u8; 32]>,
    outputs_single: HashMap<usize, [u8; 32]>,
}

impl MidstateCache {
    pub fn new() -> Self {
        Self { prevouts: None, sequence: None, outputs_all: None, outputs_single: HashMap::new() }
    }

    fn hash_prevouts(&mut self, tx: &RawTransaction, scope: u32) -> [u8; 32] {
        if scope & SIGHASH_ANYONECANPAY != 0 {
            return [0u8; 32];
        }
        *self.prevouts.get_or_insert_with(|| {
            let mut w = Writer::with_capacity(tx.inputs.len() * 36);
            for input in &tx.inputs {
                w.write_bytes(&input.txid);
                w.write_u32_le(input.output_index);
            }
            sha256d(w.as_bytes())
        })
    }

    fn hash_sequence(&mut self, tx: &RawTransaction, scope: u32) -> [u8; 32] {
        let base = scope & BASE_MASK;
        if scope & SIGHASH_ANYONECANPAY != 0 || base == SIGHASH_SINGLE || base == SIGHASH_NONE {
            return [0u8; 32];
        }
        *self.sequence.get_or_insert_with(|| {
            let mut w = Writer::with_capacity(tx.inputs.len() * 4);
            for input in &tx.inputs {
                w.write_u32_le(input.sequence);
            }
            sha256d(w.as_bytes())
        })
    }

    fn hash_outputs(&mut self, tx: &RawTransaction, input_index: usize, scope: u32) -> [u8; 32] {
        let base = scope & BASE_MASK;
        if base != SIGHASH_SINGLE && base != SIGHASH_NONE {
            // ALL-class (any base other than SINGLE/NONE hashes all outputs —
            // identical branch structure in bsv-rs AND the SDK's formatBip143).
            *self.outputs_all.get_or_insert_with(|| {
                let mut w = Writer::new();
                for output in &tx.outputs {
                    w.write_u64_le(output.satoshis);
                    w.write_var_int(output.script.len() as u64);
                    w.write_bytes(&output.script);
                }
                sha256d(w.as_bytes())
            })
        } else if base == SIGHASH_SINGLE && input_index < tx.outputs.len() {
            *self.outputs_single.entry(input_index).or_insert_with(|| {
                let output = &tx.outputs[input_index];
                let mut w = Writer::new();
                w.write_u64_le(output.satoshis);
                w.write_var_int(output.script.len() as u64);
                w.write_bytes(&output.script);
                sha256d(w.as_bytes())
            })
        } else {
            // NONE, or SINGLE with input_index >= outputs.len(): zeros.
            [0u8; 32]
        }
    }

    /// Builds the BIP-143 preimage for one input using cached midstates.
    /// Byte-identical to bsv-rs `build_sighash_preimage` (asserted in tests).
    pub fn preimage(
        &mut self,
        tx: &RawTransaction,
        input_index: usize,
        subscript: &[u8],
        satoshis: u64,
        scope: u32,
    ) -> Vec<u8> {
        let input = &tx.inputs[input_index];
        let hash_prevouts = self.hash_prevouts(tx, scope);
        let hash_sequence = self.hash_sequence(tx, scope);
        let hash_outputs = self.hash_outputs(tx, input_index, scope);

        let mut w = Writer::with_capacity(4 + 32 + 32 + 36 + 9 + subscript.len() + 8 + 4 + 32 + 4 + 4);
        w.write_i32_le(tx.version);
        w.write_bytes(&hash_prevouts);
        w.write_bytes(&hash_sequence);
        w.write_bytes(&input.txid); // internal byte order, as stored in the tx
        w.write_u32_le(input.output_index);
        w.write_var_int(subscript.len() as u64);
        w.write_bytes(subscript);
        w.write_u64_le(satoshis);
        w.write_u32_le(input.sequence);
        w.write_bytes(&hash_outputs);
        w.write_u32_le(tx.locktime);
        w.write_u32_le(scope);
        w.into_bytes()
    }
}

impl Default for MidstateCache {
    fn default() -> Self {
        Self::new()
    }
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
        // Best-effort scalar hygiene for the spike; the real FFI crate will use
        // `zeroize`. (bsv-rs PrivateKey's inner k256 SecretKey zeroizes on drop.)
        for b in self.privkey.iter_mut() {
            unsafe { std::ptr::write_volatile(b, 0) };
        }
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
/// to the SDK P2PKH template's `UnlockingScript` for the same input.
///
/// Reject-on-any-invalid-element: any bad record fails the WHOLE call and the
/// caller falls back to the pure-JS path for the whole tx.
pub fn batch_sign_p2pkh_inputs(
    unsigned_tx: Vec<u8>,
    inputs_meta: Vec<u8>,
) -> Result<Vec<u8>, EngineError> {
    let tx = parse_transaction(&unsigned_tx).map_err(|_| EngineError::TxParse)?;
    let metas = parse_meta(&inputs_meta)?;

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

    let mut cache = MidstateCache::new();
    let mut out = Vec::with_capacity(metas.len() * (4 + 1 + 108));
    for m in &metas {
        let preimage = cache.preimage(&tx, m.input_index as usize, &m.lock, m.satoshis, m.scope);
        let sighash = sha256d(&preimage); // signing order — never reversed here
        let key = PrivateKey::from_bytes(&m.privkey)
            .map_err(|e| EngineError::Crypto(format!("privkey[{}]: {e}", m.input_index)))?;
        let sig = key
            .sign(&sighash)
            .map_err(|e| EngineError::Crypto(format!("sign[{}]: {e}", m.input_index)))?;
        let checksig = TransactionSignature::new(sig, m.scope).to_checksig_format();
        let pubkey = key.public_key().to_compressed();

        let script_len = 1 + checksig.len() + 1 + 33;
        out.extend_from_slice(&m.input_index.to_le_bytes());
        out.push(script_len as u8);
        out.push(checksig.len() as u8); // direct push (< 0x4c)
        out.extend_from_slice(&checksig);
        out.push(33);
        out.extend_from_slice(&pubkey);
    }
    Ok(out)
}

/// Conformance/debug export (design doc §1): one sighash, **signing order
/// only** (internal byte order, ready for ECDSA). Never routed in prod.
pub fn compute_sighash_signing_order(
    raw_tx: Vec<u8>,
    input_index: u32,
    subscript: Vec<u8>,
    satoshis: u64,
    scope: u32,
) -> Result<Vec<u8>, EngineError> {
    Ok(sha256d(&compute_sighash_preimage_signing(raw_tx, input_index, subscript, satoshis, scope)?).to_vec())
}

/// Spike/conformance-only companion: the full BIP-143 preimage bytes, so any
/// fuzz divergence is localizable to a specific preimage field (design doc §6:
/// "hash-only vectors make a preimage bug visible but unlocalizable"). NOT part
/// of the production seam.
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
    let mut cache = MidstateCache::new();
    Ok(cache.preimage(&tx, input_index as usize, &subscript, satoshis, scope))
}

/// Probe + proof-artifact stamping.
pub fn engine_version() -> String {
    format!("native-engine-poc {} / bsv-rs path-dep (../../bsv-rs)", env!("CARGO_PKG_VERSION"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use bsv_rs::primitives::bsv::sighash::{
        build_sighash_preimage, SighashParams, SIGHASH_ALL,
    };

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

    /// The engine-side midstate preimage must be byte-identical to bsv-rs
    /// `build_sighash_preimage` for EVERY scope class and every input.
    #[test]
    fn midstate_preimage_equals_bsv_rs() {
        let raw = tx_bytes(7, 3);
        let tx = parse_transaction(&raw).unwrap();
        let scopes = [
            SIGHASH_ALL | SIGHASH_FORKID,
            SIGHASH_NONE | SIGHASH_FORKID,
            SIGHASH_SINGLE | SIGHASH_FORKID,
            SIGHASH_ALL | SIGHASH_FORKID | SIGHASH_ANYONECANPAY,
            SIGHASH_NONE | SIGHASH_FORKID | SIGHASH_ANYONECANPAY,
            SIGHASH_SINGLE | SIGHASH_FORKID | SIGHASH_ANYONECANPAY,
            // non-standard base values behave as ALL in both implementations
            0x04 | SIGHASH_FORKID,
            0x1f | SIGHASH_FORKID,
        ];
        for &scope in &scopes {
            let mut cache = MidstateCache::new();
            for i in 0..tx.inputs.len() {
                let ours = cache.preimage(&tx, i, &LOCK, 500 + i as u64, scope);
                let reference = build_sighash_preimage(&SighashParams {
                    version: tx.version,
                    inputs: &tx.inputs,
                    outputs: &tx.outputs,
                    locktime: tx.locktime,
                    input_index: i,
                    subscript: &LOCK,
                    satoshis: 500 + i as u64,
                    scope,
                });
                assert_eq!(ours, reference, "scope {scope:#x} input {i}");
            }
        }
    }

    /// SINGLE with input_index >= outputs.len() must hit the zeros branch —
    /// and still equal bsv-rs exactly (fund-loss family (a)).
    #[test]
    fn single_out_of_range_matches_bsv_rs() {
        let raw = tx_bytes(5, 2);
        let tx = parse_transaction(&raw).unwrap();
        let scope = SIGHASH_SINGLE | SIGHASH_FORKID;
        for i in 2..5 {
            let mut cache = MidstateCache::new();
            let ours = cache.preimage(&tx, i, &LOCK, 42, scope);
            let reference = build_sighash_preimage(&SighashParams {
                version: tx.version,
                inputs: &tx.inputs,
                outputs: &tx.outputs,
                locktime: tx.locktime,
                input_index: i,
                subscript: &LOCK,
                satoshis: 42,
                scope,
            });
            assert_eq!(ours, reference, "input {i}");
            // zeros branch really taken
            assert_eq!(&ours[ours.len() - 40..ours.len() - 8], &[0u8; 32]);
        }
    }

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

    /// Sign output framing: [u32 idx][u8 len][push(sig‖scope) push(pub33)], and
    /// the sighash under the signature equals compute_sighash_signing_order.
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
            assert_eq!(script[sig_len] , scope as u8, "scope byte trails the DER");
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
}
