//! Host bench (arm64 mac): 1000-iter timed loops for the three hot paths the Nitro
//! module will serve — ECDSA sign, ECDSA verify, and the BRC-42 deriveChild composite
//! (ECDH shared point + HMAC-SHA256 + privkey tweak-add). Run:
//!   cargo run --release --bin bench
//! Numbers land in RESULTS.md.

use secp_native::{brc42_derive_child, ecdsa_sign, ecdsa_verify, pubkey_create};
use std::time::Instant;

const ITERS: u32 = 1000;

fn timed<F: FnMut(u32)>(label: &str, mut f: F) {
    // one warmup pass
    f(0);
    let start = Instant::now();
    for i in 0..ITERS {
        f(i);
    }
    let el = start.elapsed();
    let per = el / ITERS;
    println!(
        "{label:<28} {ITERS} iters  total {:>8.2?}  per-op {:>10.2?}  ({:>8.0} ops/s)",
        el,
        per,
        ITERS as f64 / el.as_secs_f64()
    );
}

fn main() {
    let privkey: Vec<u8> =
        hex_lit("6f2a3b4c5d6e7f80912233445566778899aabbccddeeff00112233445566778f");
    let counterparty_priv: Vec<u8> =
        hex_lit("2222222222222222222222222222222222222222222222222222222222222222");
    let counterparty_pub = pubkey_create(counterparty_priv).unwrap();
    let pubkey = pubkey_create(privkey.clone()).unwrap();

    // Distinct msg per iteration so caches/nonce state can't flatter the numbers.
    let msgs: Vec<Vec<u8>> = (0..ITERS + 1)
        .map(|i| {
            let mut m = vec![0u8; 32];
            m[28..32].copy_from_slice(&i.to_be_bytes());
            m[0] = 0x5a;
            m
        })
        .collect();
    let sigs: Vec<Vec<u8>> = msgs
        .iter()
        .map(|m| ecdsa_sign(m.clone(), privkey.clone()).unwrap())
        .collect();

    println!("secp-native host bench (release, {} iters each)", ITERS);
    timed("ecdsa_sign (RFC6979, DER)", |i| {
        let _ = ecdsa_sign(msgs[i as usize].clone(), privkey.clone()).unwrap();
    });
    timed("ecdsa_verify", |i| {
        assert!(ecdsa_verify(
            msgs[i as usize].clone(),
            sigs[i as usize].clone(),
            pubkey.clone()
        )
        .unwrap());
    });
    timed("brc42_derive_child (ecdh+…)", |i| {
        let _ = brc42_derive_child(
            privkey.clone(),
            counterparty_pub.clone(),
            format!("2-secp-poc-{i}"),
        )
        .unwrap();
    });
}

fn hex_lit(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}
