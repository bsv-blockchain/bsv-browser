//! Sign-core cross-check (carried from the spike; roles now REVERSED by the
//! ratified #19 decision): the engine's sign core is bitcoin-core libsecp256k1
//! (rust-secp256k1 =0.31.1 — proven byte-exact vs @bsv/sdk@2.1.6 over 155,148+
//! fuzz cases in native-secp-poc/M4), and bsv-rs `PrivateKey::sign` (k256
//! 0.13.x, which the spike's 200k-case gate ran on) is the independent RFC-6979
//! oracle proving the core swap is byte-neutral.
//!
//! Both implement RFC 6979 deterministic nonces + low-S, so any DER divergence
//! here is a hard red on one of the two Rust stacks BEFORE the JS differential
//! gate even runs. 4,096 deterministic (key, digest) pairs incl. edge scalars.

use bsv_rs::primitives::ec::PrivateKey;
use secp256k1::{Message, SecretKey, SECP256K1};

/// SplitMix64 — same fixed-seed generator family as the bsv-fuzz corpora.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn bytes32(&mut self) -> [u8; 32] {
        let mut out = [0u8; 32];
        for i in 0..4 {
            out[i * 8..(i + 1) * 8].copy_from_slice(&self.next().to_be_bytes());
        }
        out
    }
}

const N_BE: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xfe, 0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36,
    0x41, 0x41,
];

#[test]
fn k256_der_equals_libsecp_der() {
    let mut rng = Rng(0x5EC9_2026_0721_0003);
    let mut edge_keys: Vec<[u8; 32]> = vec![
        {
            let mut k = [0u8; 32];
            k[31] = 1;
            k
        },
        {
            let mut k = [0u8; 32];
            k[31] = 2;
            k
        },
        {
            // n - 1
            let mut k = N_BE;
            k[31] -= 1;
            k
        },
    ];
    let mut cases = 0u32;
    for i in 0..4096 {
        let key = if i < edge_keys.len() {
            edge_keys[i]
        } else {
            loop {
                let k = rng.bytes32();
                if k != [0u8; 32] && k < N_BE {
                    break k;
                }
            }
        };
        // Digest domain: anything sha256d can emit. Values >= n are EXCLUDED
        // from the equality corpus and pinned separately below — see
        // `digest_ge_n_is_a_documented_asymmetry`.
        let digest = match i % 7 {
            0 => [0u8; 32],
            1 => {
                let mut d = N_BE; // n - 1: largest in-range digest
                d[31] -= 1;
                d
            }
            _ => loop {
                let d = rng.bytes32();
                if d < N_BE {
                    break d;
                }
            },
        };

        let bsv_key = PrivateKey::from_bytes(&key).unwrap();
        let bsv_der = bsv_key.sign(&digest).unwrap().to_der();

        let sk = SecretKey::from_byte_array(key).unwrap();
        let libsecp_der = SECP256K1
            .sign_ecdsa(Message::from_digest(digest), &sk)
            .serialize_der()
            .to_vec();

        assert_eq!(
            bsv_der,
            libsecp_der,
            "DER divergence at case {i}: key={} digest={}",
            hex::encode(key),
            hex::encode(digest)
        );
        cases += 1;
    }
    edge_keys.clear();
    assert_eq!(cases, 4096);
}

/// RECORDED ASYMMETRY (kill-test finding, non-blocking): for a digest >= n,
/// bsv-rs (k256's RFC 6979, bits2octets per the RFC) derives a DIFFERENT nonce
/// than libsecp256k1 / @bsv/sdk (both reduce the digest mod n before seeding
/// the DRBG — proven identical to each other in native-secp-poc). Both outputs
/// are valid low-S signatures; only the deterministic bytes differ.
///
/// Reachability at the engine seam: ZERO in practice — the engine signs ONLY
/// sha256d(preimage), and P(sha256d output >= n) ≈ 2^-128. Moreover, with the
/// ratified libsecp sign core this asymmetry has EXITED the signing path
/// entirely (libsecp sides with @bsv/sdk); the pin remains so a future
/// k256/libsecp bump that CHANGES the relationship is noticed.
#[test]
fn digest_ge_n_is_a_documented_asymmetry() {
    let key = {
        let mut k = [0u8; 32];
        k[31] = 2;
        k
    };
    let digest = [0xffu8; 32]; // > n

    let bsv_der = PrivateKey::from_bytes(&key).unwrap().sign(&digest).unwrap().to_der();
    let sk = SecretKey::from_byte_array(key).unwrap();
    let libsecp_der = SECP256K1
        .sign_ecdsa(Message::from_digest(digest), &sk)
        .serialize_der()
        .to_vec();

    assert_ne!(
        bsv_der, libsecp_der,
        "k256 vs libsecp digest>=n nonce asymmetry has CHANGED — re-audit the sign core pins"
    );
}
