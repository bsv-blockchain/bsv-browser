//! Host bench for the M5.3 kill-test: batch sighash+sign of a 50-input P2PKH tx.
//!
//! Reports three numbers:
//!   1. engine batch_sign_p2pkh_inputs (midstates once) — the Tier-3 claim;
//!   2. sighash-only via the midstate cache (isolates hashing from ECDSA);
//!   3. per-input bsv-rs compute_sighash_for_signing (NO midstate reuse — the
//!      O(n²) shape both the SDK fallback path and a naive bsv-rs composition
//!      would have), for the collapse comparison.
//!
//! The JS-oracle number for the same fixed skeleton comes from the bsv-fuzz
//! engine_corpus driver (`--bench`), which times the app's exact patched
//! @bsv/sdk@2.1.6 Transaction.sign on an identical 50-input case.

use native_engine_poc::{batch_sign_p2pkh_inputs, compute_sighash_signing_order, MidstateCache, SIGHASH_FORKID};
use std::time::Instant;

const SIGHASH_ALL: u32 = 0x01;

fn le32(v: u32, out: &mut Vec<u8>) {
    out.extend_from_slice(&v.to_le_bytes());
}

fn varint(v: u64, out: &mut Vec<u8>) {
    match v {
        0..=0xfc => out.push(v as u8),
        0xfd..=0xffff => {
            out.push(0xfd);
            out.extend_from_slice(&(v as u16).to_le_bytes());
        }
        _ => {
            out.push(0xfe);
            out.extend_from_slice(&(v as u32).to_le_bytes());
        }
    }
}

fn main() {
    const N: usize = 50;
    let scope = SIGHASH_ALL | SIGHASH_FORKID;

    // Deterministic 50-input, 2-output skeleton (mirrors the driver's bench case).
    let mut tx = Vec::new();
    le32(1, &mut tx); // version (i32 LE == u32 LE bits here)
    varint(N as u64, &mut tx);
    let mut locks = Vec::new();
    for i in 0..N {
        let mut txid = [0u8; 32];
        txid[0] = i as u8;
        txid[31] = 0x50;
        tx.extend_from_slice(&txid);
        le32(i as u32, &mut tx);
        varint(0, &mut tx);
        le32(0xffff_ffff, &mut tx);
        let mut lock = [0u8; 25];
        lock[0] = 0x76;
        lock[1] = 0xa9;
        lock[2] = 0x14;
        lock[3 + (i % 20)] = 0x99;
        lock[23] = 0x88;
        lock[24] = 0xac;
        locks.push(lock);
    }
    varint(2, &mut tx);
    for o in 0..2u64 {
        tx.extend_from_slice(&(1000 + o).to_le_bytes());
        let mut lock = [7u8; 25];
        (lock[0], lock[1], lock[2], lock[23], lock[24]) = (0x76, 0xa9, 0x14, 0x88, 0xac);
        varint(25, &mut tx);
        tx.extend_from_slice(&lock);
    }
    le32(0, &mut tx);

    let mut meta = Vec::new();
    for i in 0..N {
        le32(i as u32, &mut meta);
        let mut key = [0x33u8; 32];
        key[31] = i as u8 + 1;
        meta.extend_from_slice(&key);
        meta.extend_from_slice(&(700u64 + i as u64).to_le_bytes());
        le32(scope, &mut meta);
        meta.extend_from_slice(&locks[i]);
    }

    // Warmup.
    for _ in 0..5 {
        batch_sign_p2pkh_inputs(tx.clone(), meta.clone()).unwrap();
    }

    const ITERS: u32 = 100;

    // 1. Full batch sighash+sign, midstates once.
    let t = Instant::now();
    for _ in 0..ITERS {
        batch_sign_p2pkh_inputs(tx.clone(), meta.clone()).unwrap();
    }
    let batch_ms = t.elapsed().as_secs_f64() * 1000.0 / f64::from(ITERS);

    // 2. Sighash-only through the midstate cache (parse once, 50 preimages+hashes).
    let parsed = bsv_rs::primitives::bsv::sighash::parse_transaction(&tx).unwrap();
    let t = Instant::now();
    for _ in 0..ITERS {
        let mut cache = MidstateCache::new();
        for i in 0..N {
            let p = cache.preimage(&parsed, i, &locks[i], 700 + i as u64, scope);
            std::hint::black_box(bsv_rs::primitives::hash::sha256d(&p));
        }
    }
    let sighash_cached_ms = t.elapsed().as_secs_f64() * 1000.0 / f64::from(ITERS);

    // 3. Sighash per input WITHOUT midstate reuse (bsv-rs as-is, the O(n²) shape).
    let t = Instant::now();
    for _ in 0..ITERS {
        for i in 0..N {
            std::hint::black_box(
                compute_sighash_signing_order(tx.clone(), i as u32, locks[i].to_vec(), 700 + i as u64, scope)
                    .unwrap(),
            );
        }
    }
    let sighash_naive_ms = t.elapsed().as_secs_f64() * 1000.0 / f64::from(ITERS);

    println!("native-engine-poc host bench — 50-input P2PKH, ALL|FORKID, {ITERS} iters");
    println!("  batch_sign_p2pkh_inputs (sighash midstates-once + 50 ECDSA): {batch_ms:.3} ms");
    println!("  sighash-only, midstates once (50 preimages + sha256d):       {sighash_cached_ms:.3} ms");
    println!("  sighash-only, NO midstate reuse (bsv-rs per-input, O(n^2)):  {sighash_naive_ms:.3} ms");
}
