//! M5.2 (Calgooon/bsv-browser #20) — engine-level ts-stack conformance replay.
//!
//! Proves the SHIPPING `native-engine-ffi` crate (BIP-143 sighash via
//! `bsv_rs::…::SighashCache`, the upstream midstate-reuse API — issue #28) is
//! byte-exact against the shared ts-stack conformance corpus, at the ENGINE
//! surface (`compute_sighash_signing_order` / `compute_sighash_preimage_signing`
//! / `parse_transaction`), NOT just at the bsv-rs library surface (which
//! `bsv-rs's tests/conformance_scripts.rs` already replays for 5,116
//! vectors). Same `$BSV_CONFORMANCE_DIR` convention as bsv-rs; SKIP (pass
//! vacuously) if the sibling corpus is absent, so CI without the checkout
//! stays green.
//!
//! FOUR replays, each with an ENUMERATED census (run + unsupported by reason =
//! total — no silent skips):
//!   1. `sdk.scripts.evaluation` node-sighash (2,000): FORKID `regular_hash`.
//!      The engine's OWN census — deliberately NOT a copy of bsv-rs's: the
//!      engine defers on the CHRONICLE *bit* and does not implement the
//!      teranode "ignore-chronicle" path (250 fixtures bsv-rs runs, the engine
//!      enumerates as JS-fallback). Legacy/OTDA (no FORKID) is unsupported.
//!   2. `regressions/tx-sequence-zero-sighash` (ts-sdk#371): the preimage
//!      nSequence field bytes at the engine surface.
//!   3. `sdk.transactions.serialization`: the engine's tx READER
//!      (`parse_transaction`, the same one `batch_sign` uses for
//!      outpoints/sequences) — version/input-count/output-count/locktime
//!      parity. (Native never re-serializes a tx — design doc §1 — so this is
//!      a read-parity census, not a round-trip emit.)
//!   4. `sdk.scripts.sighash-preimage` (NEW, M5.2 — authored by
//!      bsv-fuzz/sdk2-oracle/gen-preimage-vectors.mjs): FULL BIP-143 preimage
//!      BYTES + digest, byte-for-byte through the engine. The debuggable
//!      corpus the engine is pinned against.

use bsv_rs::primitives::bsv::sighash::parse_transaction;
use bsv_rs::primitives::hash::sha256d;
use bsv_rs::transaction::MerklePath;
use engine_native::{
    beef_to_ef, beef_verify_structure, compute_sighash_preimage_signing,
    compute_sighash_signing_order,
};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;

const SIGHASH_FORKID: u32 = 0x40;
const SIGHASH_CHRONICLE: u32 = 0x20;

fn corpus_dir() -> Option<PathBuf> {
    let dir = match std::env::var("BSV_CONFORMANCE_DIR") {
        Ok(d) => PathBuf::from(d),
        // native-engine-ffi → bsv-browser → bsv → ts-stack/conformance
        Err(_) => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../ts-stack/conformance"),
    };
    if dir.join("META.json").is_file() {
        Some(dir)
    } else {
        eprintln!(
            "SKIP: conformance corpus not found at {} (set BSV_CONFORMANCE_DIR or check out \
             ts-stack next to bsv-browser); engine conformance replay passes vacuously",
            dir.display()
        );
        None
    }
}

fn load(path: &PathBuf) -> Value {
    let data = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&data).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}
fn u64f(v: &Value, k: &str) -> Option<u64> {
    v.get(k).and_then(Value::as_u64)
}

#[derive(Default)]
struct Census {
    run: usize,
    passed: usize,
    unsupported: BTreeMap<&'static str, usize>,
    failures: Vec<String>,
}
impl Census {
    fn unsup(&mut self, class: &'static str) {
        *self.unsupported.entry(class).or_default() += 1;
    }
    fn unsup_total(&self) -> usize {
        self.unsupported.values().sum()
    }
    fn print(&self, label: &str, total: usize) {
        println!(
            "[{label}] total={} run={} passed={} unsupported={} failures={}",
            self.run + self.unsup_total(),
            self.run,
            self.passed,
            self.unsup_total(),
            self.failures.len()
        );
        for (c, n) in &self.unsupported {
            println!("    unsupported[{c}] = {n}");
        }
        for f in self.failures.iter().take(20) {
            println!("    FAIL {f}");
        }
        assert_eq!(self.run + self.unsup_total(), total, "[{label}] census != total");
        assert!(self.failures.is_empty(), "[{label}] {} failures", self.failures.len());
    }
}

// ============================================================================
// 1. node-sighash — FORKID regular_hash at the engine surface
// ============================================================================
#[test]
fn engine_node_sighash_replay() {
    let Some(dir) = corpus_dir() else { return };
    let file = load(&dir.join("vectors/sdk/scripts/evaluation.json"));
    let vectors = file["vectors"].as_array().expect("vectors");
    assert_eq!(vectors.len(), 5116, "evaluation.json vector count changed — re-audit pins");

    let mut c = Census::default();
    for v in vectors {
        let input = &v["input"];
        if s(input, "fixture_type") != "node-sighash" {
            continue;
        }
        let id = s(v, "id");
        let scope = (input["hash_type"].as_i64().unwrap_or(0) as i64 as u32) & 0xffff_ffff;
        if scope & SIGHASH_FORKID == 0 {
            c.unsup("no FORKID (legacy/OTDA — engine defers to JS)");
            continue;
        }
        if scope & SIGHASH_CHRONICLE != 0 {
            // The engine defers on the CHRONICLE bit; bsv-rs additionally
            // implements a teranode ignore-chronicle path (250 of these). That
            // is a JS-fallback class at the seam — the deliberate census delta.
            let teranode = input["sources"]
                .as_array()
                .map(|a| a.iter().any(|x| x.as_str() == Some("teranode")))
                .unwrap_or(false);
            if teranode {
                c.unsup("CHRONICLE bit set, teranode source (bsv-rs ignore-chronicle path; engine JS-fallback)");
            } else {
                c.unsup("CHRONICLE bit set (engine defers to JS)");
            }
            continue;
        }
        // Supported — replay through the engine, compare to regular_hash.
        let tx = match hex::decode(s(input, "tx_hex")) {
            Ok(b) => b,
            Err(e) => { c.failures.push(format!("{id}: tx_hex hex: {e}")); continue; }
        };
        let subscript = hex::decode(s(input, "script_hex")).unwrap_or_default();
        let idx = input["input_index"].as_u64().unwrap_or(0) as u32;
        // Engine surface: signing-order digest; the node fixtures pin the
        // display-order hash, so reverse before comparing.
        match compute_sighash_signing_order(tx.clone(), idx, subscript.clone(), 0, scope) {
            Ok(mut digest) => {
                c.run += 1;
                digest.reverse();
                let got = hex::encode(&digest);
                let want = s(&v["expected"], "regular_hash");
                if got == want {
                    c.passed += 1;
                    // Cross-check: preimage → sha256d == the signing-order digest.
                    let pre = compute_sighash_preimage_signing(tx, idx, subscript, 0, scope)
                        .expect("preimage for supported scope");
                    let mut d2 = sha256d(&pre).to_vec();
                    d2.reverse();
                    if hex::encode(&d2) != want {
                        c.failures.push(format!("{id}: preimage sha256d != signing-order digest"));
                    }
                } else {
                    c.failures.push(format!("{id}: FORKID sighash mismatch want={want} got={got}"));
                }
            }
            Err(e) => {
                c.run += 1;
                c.failures.push(format!("{id}: engine err on supported scope: {e:?}"));
            }
        }
    }

    c.print("node-sighash", 2000);
    // Pinned engine census (differs from bsv-rs by design — see module docs).
    assert_eq!(c.run, 506, "engine-run node-sighash count drift");
    assert_eq!(c.passed, 506, "every engine-run node-sighash vector must match regular_hash");
    let pins: BTreeMap<&str, usize> = [
        ("no FORKID (legacy/OTDA — engine defers to JS)", 984usize),
        ("CHRONICLE bit set (engine defers to JS)", 260),
        ("CHRONICLE bit set, teranode source (bsv-rs ignore-chronicle path; engine JS-fallback)", 250),
    ]
    .into_iter()
    .collect();
    let got: BTreeMap<&str, usize> =
        c.unsupported.iter().map(|(k, v)| (*k, *v)).collect();
    assert_eq!(got, pins, "node-sighash unsupported-class drift");
}

// ============================================================================
// 2. tx-sequence-zero regression (ts-sdk#371) at the engine surface
// ============================================================================
#[test]
fn engine_sequence_zero_regression() {
    let Some(dir) = corpus_dir() else { return };
    let file = load(&dir.join("vectors/regressions/tx-sequence-zero-sighash.json"));
    let vectors = file["vectors"].as_array().expect("vectors");
    assert_eq!(vectors.len(), 3, "tx-sequence-zero vector count changed");

    let mut c = Census::default();
    for v in vectors {
        let input = &v["input"];
        let id = s(v, "id");
        let op = s(input, "operation");
        let seq = input["input_sequence"].as_u64().unwrap_or(0) as u32;
        // A deterministic 1-input / 1-output tx carrying `seq` as the input's
        // nSequence, EMPTY subscript (so the preimage sequence field sits at a
        // fixed offset). version/locktime from the vector where present.
        let version = input["version"].as_i64().unwrap_or(1) as i32;
        let locktime = input["lock_time"].as_u64().unwrap_or(0) as u32;
        let raw = build_1in_tx(version, locktime, seq);
        match op {
            "sighash_preimage" => {
                let scope = 0x01 | SIGHASH_FORKID; // SIGHASH_ALL | FORKID
                let pre = compute_sighash_preimage_signing(raw, 0, Vec::new(), 0, scope)
                    .expect("preimage");
                // offset: version(4) hashPrevouts(32) hashSequence(32)
                // outpoint(32+4) scriptCode varint(1,len=0) satoshis(8) = 113
                let field = &pre[113..117];
                let want = s(&v["expected"], "preimage_sequence_field_hex");
                c.run += 1;
                if hex::encode(field) == want {
                    c.passed += 1;
                } else {
                    c.failures.push(format!("{id}: preimage seq field want={want} got={}", hex::encode(field)));
                }
            }
            "serialise_input_sequence" => {
                // Engine tx READER parity: parse_transaction must read the
                // encoded sequence back exactly (the ts-sdk#371 construction bug
                // was the in-memory value diverging from the serialized one).
                let tx = parse_transaction(&raw).expect("parse");
                let want = s(&v["expected"], "serialised_sequence_hex");
                c.run += 1;
                let got = hex::encode(tx.inputs[0].sequence.to_le_bytes());
                if got == want {
                    c.passed += 1;
                } else {
                    c.failures.push(format!("{id}: parsed seq want={want} got={got}"));
                }
            }
            other => panic!("{id}: unexpected regression operation {other:?}"),
        }
    }
    c.print("tx-sequence-zero", 3);
    assert_eq!(c.passed, 3);
}

/// Deterministic 1-input, 1-output tx with the input's nSequence = `seq`.
fn build_1in_tx(version: i32, locktime: u32, seq: u32) -> Vec<u8> {
    let mut w = Vec::new();
    w.extend_from_slice(&version.to_le_bytes());
    w.push(0x01); // 1 input
    w.extend_from_slice(&[0x11u8; 32]); // outpoint txid
    w.extend_from_slice(&0u32.to_le_bytes()); // vout
    w.push(0x00); // empty unlocking script
    w.extend_from_slice(&seq.to_le_bytes());
    w.push(0x01); // 1 output
    w.extend_from_slice(&1000u64.to_le_bytes());
    let lock: [u8; 25] = [
        0x76, 0xa9, 0x14, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 0x88,
        0xac,
    ];
    w.push(lock.len() as u8);
    w.extend_from_slice(&lock);
    w.extend_from_slice(&locktime.to_le_bytes());
    w
}

// ============================================================================
// 3. serialization — engine tx-reader parity (parse_transaction)
// ============================================================================
#[test]
fn engine_serialization_parse_census() {
    let Some(dir) = corpus_dir() else { return };
    let file = load(&dir.join("vectors/sdk/transactions/serialization.json"));
    let vectors = file["vectors"].as_array().expect("vectors");
    assert_eq!(vectors.len(), 15, "serialization.json vector count changed");

    let mut c = Census::default();
    for v in vectors {
        let input = &v["input"];
        let expected = &v["expected"];
        let id = s(v, "id");
        let raw_hex = s(input, "raw_hex");
        if !raw_hex.is_empty() && expected.get("inputs_count").is_some() {
            let raw = match hex::decode(raw_hex) {
                Ok(b) => b,
                Err(e) => { c.failures.push(format!("{id}: hex {e}")); continue; }
            };
            let tx = match parse_transaction(&raw) {
                Ok(t) => t,
                Err(e) => { c.failures.push(format!("{id}: parse {e}")); continue; }
            };
            c.run += 1;
            let mut ok = true;
            if let Some(ver) = expected.get("version").and_then(Value::as_i64) {
                if tx.version as i64 != ver { ok = false; c.failures.push(format!("{id}: version {} != {ver}", tx.version)); }
            }
            if let Some(ic) = u64f(expected, "inputs_count") {
                if tx.inputs.len() as u64 != ic { ok = false; c.failures.push(format!("{id}: inputs {} != {ic}", tx.inputs.len())); }
            }
            if let Some(oc) = u64f(expected, "outputs_count") {
                if tx.outputs.len() as u64 != oc { ok = false; c.failures.push(format!("{id}: outputs {} != {oc}", tx.outputs.len())); }
            }
            if let Some(lt) = u64f(expected, "locktime") {
                if tx.locktime as u64 != lt { ok = false; c.failures.push(format!("{id}: locktime {} != {lt}", tx.locktime)); }
            }
            if ok { c.passed += 1; }
        } else if expected.get("throws").is_some() {
            c.unsup("invalid-tx throws (JS-side reject; not the engine sign surface)");
        } else if expected.get("merkle_root").is_some() || s(input, "operation").contains("merkle") {
            c.unsup("merkle-path fixture (not a tx-serialization vector)");
        } else if expected.get("sequence").is_some() {
            c.unsup("sequence-default probe (not a raw-tx parse vector)");
        } else if expected.get("hash_type").is_some() || expected.get("id_type").is_some() {
            c.unsup("txid/hash metadata probe (not a raw-tx parse vector)");
        } else {
            c.unsup("non-raw-hex serialization probe (EF/BEEF; not the engine tx-reader surface)");
        }
    }
    c.print("serialization", 15);
    assert_eq!(c.run, 3, "engine-run serialization parse count drift");
    assert_eq!(c.passed, 3, "every engine-run serialization vector must parse-match");
}

// ============================================================================
// 4. NEW preimage corpus — FULL BIP-143 preimage BYTES through the engine
// ============================================================================
#[test]
fn engine_new_preimage_corpus() {
    let Some(dir) = corpus_dir() else { return };
    let path = dir.join("vectors/sdk/scripts/sighash-preimage.json");
    if !path.is_file() {
        eprintln!(
            "SKIP: {} absent — the M5.2 preimage corpus is authored in \
             bsv-fuzz/sdk2-oracle/gen-preimage-vectors.mjs and staged for the \
             ts-stack owner-merge (append-only, id sdk.scripts.sighash-preimage); \
             the pushable copy lives in bsv-fuzz/fixtures/ts-stack-conformance.",
            path.display()
        );
        return;
    }
    let file = load(&path);
    let vectors = file["vectors"].as_array().expect("vectors");
    assert!(vectors.len() >= 150, "preimage corpus shrank ({}); IDs are append-only", vectors.len());

    let mut c = Census::default();
    for v in vectors {
        let input = &v["input"];
        let expected = &v["expected"];
        let id = s(v, "id");
        let raw = hex::decode(s(input, "tx_hex")).expect("tx_hex");
        let subscript = hex::decode(s(input, "subscript_hex")).unwrap_or_default();
        let idx = input["input_index"].as_u64().unwrap() as u32;
        let sat = input["satoshis"].as_u64().unwrap();
        let scope = input["scope"].as_u64().unwrap() as u32;
        c.run += 1;

        // FULL preimage bytes — byte-for-byte.
        let pre = match compute_sighash_preimage_signing(raw.clone(), idx, subscript.clone(), sat, scope) {
            Ok(p) => p,
            Err(e) => { c.failures.push(format!("{id}: engine err {e:?}")); continue; }
        };
        let want_pre = s(expected, "preimage_hex");
        if hex::encode(&pre) != want_pre {
            c.failures.push(format!("{id}: preimage MISMATCH\n  want {want_pre}\n  got  {}", hex::encode(&pre)));
            continue;
        }
        // Digest (signing/internal order) via the FFI export.
        let dig = compute_sighash_signing_order(raw, idx, subscript, sat, scope).expect("digest");
        if hex::encode(&dig) != s(expected, "sighash_hex") {
            c.failures.push(format!("{id}: digest mismatch"));
            continue;
        }
        c.passed += 1;
    }
    c.print("new-preimage", vectors.len());
    assert_eq!(c.run, c.passed, "every preimage vector must be byte-exact");
    assert_eq!(c.passed, vectors.len(), "all preimage vectors run");
}

// ============================================================================
// 5. M5.9 BEEF leg (issue #27) — READ-ONLY beef_to_ef + beef_verify_structure
//    at the engine surface, driven by the shared corpus.
// ============================================================================
#[test]
fn engine_beef_conformance() {
    let Some(dir) = corpus_dir() else { return };

    // (a) serialization.json anchor: tx-003 is a V1 BEEF whose SUBJECT tx is the
    // same tx as tx-004's EF, and tx-003 carries the expected merkle_root. So
    // beef_to_ef(tx-003) must byte-equal tx-004.ef_hex, and
    // beef_verify_structure(tx-003)'s single root must equal tx-003.merkle_root
    // — both byte-for-byte against the SDK, with no oracle process.
    let ser = load(&dir.join("vectors/sdk/transactions/serialization.json"));
    let vectors = ser["vectors"].as_array().expect("vectors");
    let mut beef_hex = String::new();
    let mut ef_hex = String::new();
    let mut want_root = String::new();
    for v in vectors {
        let input = &v["input"];
        if !s(input, "beef_hex").is_empty() && !s(&v["expected"], "merkle_root").is_empty() {
            beef_hex = s(input, "beef_hex").to_string();
            want_root = s(&v["expected"], "merkle_root").to_string();
        }
        if !s(input, "ef_hex").is_empty() {
            ef_hex = s(input, "ef_hex").to_string();
        }
    }
    assert!(!beef_hex.is_empty() && !ef_hex.is_empty(), "serialization.json BEEF/EF anchor present");

    let beef = hex::decode(&beef_hex).expect("beef hex");
    // EF byte-parity (empty subject → last tx == tx-004's tx).
    let ef = beef_to_ef(beef.clone(), Vec::new()).expect("beef_to_ef ok");
    assert_eq!(hex::encode(&ef), ef_hex, "[beef] beef_to_ef != SDK EF vector (tx-004)");
    // Structural verify + root parity.
    let out = beef_verify_structure(beef).expect("beef valid");
    let count = u32::from_le_bytes(out[0..4].try_into().unwrap());
    assert_eq!(count, 1, "[beef] tx-003 has one BUMP → one root");
    assert_eq!(hex::encode(&out[8..40]), want_root, "[beef] root != SDK merkle_root");
    println!("[beef/serialization] beef_to_ef byte-exact vs tx-004; root byte-exact vs tx-003");

    // (b) merkle-path.json compute-root vectors: the merkle-root PRIMITIVE
    // beef_verify_structure relies on (MerklePath::compute_root), byte-for-byte.
    let mp = load(&dir.join("vectors/sdk/transactions/merkle-path.json"));
    let mpv = mp["vectors"].as_array().expect("vectors");
    let mut cr = Census::default();
    for v in mpv {
        let input = &v["input"];
        let id = s(v, "id");
        let bump_hex = s(input, "bump_hex");
        let want = s(&v["expected"], "merkle_root");
        if bump_hex.is_empty() || want.is_empty() {
            cr.unsup("not a compute-root vector (parse/serialize/height probe)");
            continue;
        }
        let txid = s(input, "txid");
        let bump = match hex::decode(bump_hex).ok().and_then(|b| MerklePath::from_binary(&b).ok()) {
            Some(b) => b,
            None => { cr.failures.push(format!("{id}: bump parse")); continue; }
        };
        cr.run += 1;
        let got = bump.compute_root(if txid.is_empty() { None } else { Some(txid) }).unwrap_or_default();
        if got == want {
            cr.passed += 1;
        } else {
            cr.failures.push(format!("{id}: root want={want} got={got}"));
        }
    }
    cr.print("merkle-path-computeroot", mpv.len());
    assert!(cr.run >= 2, "[beef] expected ≥2 compute-root vectors, ran {}", cr.run);
    assert_eq!(cr.run, cr.passed, "[beef] every compute-root vector must match");
}
