//! `secp-native` — PoC bytes-only FFI over rust-secp256k1 (bitcoin-core libsecp256k1 C
//! bindings) for the BSV Browser iOS app. This is the staticlib that will back a Nitro
//! module giving @bsv/sdk native ECDSA sign/verify + BRC-42 derivation.
//!
//! Crate shape mirrors a prior proven UniFFI staticlib crate: UniFFI 0.28
//! proc-macro mode, standalone [workspace], and a STRICTLY bytes-only seam — the ONLY
//! types crossing the FFI are `Vec<u8>` / `bool` / `String`. No secp256k1 crate type
//! (SecretKey / PublicKey / Signature) is ever exposed.
//!
//! JS-parity contract (what conformance tests in tests/conformance.rs prove against
//! @bsv/sdk-generated fixtures/vectors.json):
//!   • `ecdsa_sign` == ECDSA.sign(msgBN, keyBN, forceLowS=true).toDER() — byte-exact.
//!     Both sides use RFC 6979 HMAC-SHA256 deterministic nonces (SDK: primitives/DRBG.ts
//!     seeded entropy=privkey32, nonce=msg32, no extra data; libsecp256k1:
//!     nonce_function_rfc6979 with keydata = key32 || msgmod32, data=NULL — the identical
//!     construction), and libsecp256k1 always emits low-S, so DER bytes match exactly.
//!     Even the msg32 >= n edge matches: libsecp256k1 reduces the message mod n before
//!     feeding the PRNG (secp256k1.c nonce_function_rfc6979: scalar_set_b32 → msgmod32),
//!     exactly as the SDK's truncateToN does before seeding its DRBG.
//!   • `pubkey_create` / `*_tweak_add` / `ecdh_shared_point` / `brc42_derive_child` are
//!     nonce-free pure curve math — byte-exact against the SDK, no caveats.

uniffi::setup_scaffolding!();

use hmac::{Hmac, Mac};
use secp256k1::ecdsa::{RecoverableSignature, RecoveryId, Signature};
use secp256k1::{ecdh, Message, PublicKey, Scalar, SecretKey, SECP256K1};
use sha2::{Digest, Sha256};

/// The failure modes the FFI surfaces. Bytes-only across the boundary — messages are
/// human strings, no secp256k1 type ever crosses.
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum SecpError {
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("crypto operation failed: {0}")]
    Crypto(String),
}

fn arr32(bytes: &[u8], what: &str) -> Result<[u8; 32], SecpError> {
    <[u8; 32]>::try_from(bytes)
        .map_err(|_| SecpError::InvalidInput(format!("{what}: expected 32 bytes, got {}", bytes.len())))
}

fn seckey(privkey32: &[u8]) -> Result<SecretKey, SecpError> {
    SecretKey::from_byte_array(arr32(privkey32, "privkey")?)
        .map_err(|e| SecpError::InvalidInput(format!("privkey: {e}")))
}

fn pubkey(pubkey33: &[u8]) -> Result<PublicKey, SecpError> {
    PublicKey::from_slice(pubkey33).map_err(|e| SecpError::InvalidInput(format!("pubkey: {e}")))
}

/// ECDSA sign over a 32-byte message digest (the caller hashes; this NEVER hashes).
/// Returns the DER-encoded signature. libsecp256k1 uses RFC 6979 deterministic nonces
/// and always yields low-S — matching @bsv/sdk ECDSA.sign(..., forceLowS=true) byte-for-byte.
#[uniffi::export]
pub fn ecdsa_sign(msg32: Vec<u8>, privkey32: Vec<u8>) -> Result<Vec<u8>, SecpError> {
    let msg = Message::from_digest(arr32(&msg32, "msg32")?);
    let sk = seckey(&privkey32)?;
    let sig = SECP256K1.sign_ecdsa(msg, &sk);
    Ok(sig.serialize_der().to_vec())
}

/// ECDSA verify: 32-byte digest, DER signature, 33-byte compressed pubkey.
/// Returns Ok(false) on a well-formed-but-invalid signature; Err only on malformed inputs.
/// NOTE: libsecp256k1 verification REJECTS high-S signatures (BIP-146 strictness); we
/// normalize S first so verification semantics match @bsv/sdk's verify (which accepts
/// any s in [1, n-1]).
#[uniffi::export]
pub fn ecdsa_verify(msg32: Vec<u8>, der_sig: Vec<u8>, pubkey33: Vec<u8>) -> Result<bool, SecpError> {
    let msg = Message::from_digest(arr32(&msg32, "msg32")?);
    let pk = pubkey(&pubkey33)?;
    let mut sig = Signature::from_der(&der_sig)
        .map_err(|e| SecpError::InvalidInput(format!("der_sig: {e}")))?;
    sig.normalize_s();
    Ok(SECP256K1.verify_ecdsa(msg, &sig, &pk).is_ok())
}

/// Compressed (33-byte) public key for a 32-byte private key.
#[uniffi::export]
pub fn pubkey_create(privkey32: Vec<u8>) -> Result<Vec<u8>, SecpError> {
    let sk = seckey(&privkey32)?;
    Ok(sk.public_key(SECP256K1).serialize().to_vec())
}

/// P + t·G — compressed in, compressed out. The public half of BRC-42 child derivation.
#[uniffi::export]
pub fn pubkey_tweak_add(pubkey33: Vec<u8>, tweak32: Vec<u8>) -> Result<Vec<u8>, SecpError> {
    let pk = pubkey(&pubkey33)?;
    let tweak = Scalar::from_be_bytes(arr32(&tweak32, "tweak")?)
        .map_err(|e| SecpError::InvalidInput(format!("tweak: {e}")))?;
    let tweaked = pk
        .add_exp_tweak(SECP256K1, &tweak)
        .map_err(|e| SecpError::Crypto(format!("pubkey_tweak_add: {e}")))?;
    Ok(tweaked.serialize().to_vec())
}

/// (k + t) mod n — the private half of BRC-42 child derivation
/// (@bsv/sdk PrivateKey.deriveChild: `this.add(new BigNumber(hmac)).mod(curve.n)`).
#[uniffi::export]
pub fn privkey_tweak_add(privkey32: Vec<u8>, tweak32: Vec<u8>) -> Result<Vec<u8>, SecpError> {
    let sk = seckey(&privkey32)?;
    let tweak = Scalar::from_be_bytes(arr32(&tweak32, "tweak")?)
        .map_err(|e| SecpError::InvalidInput(format!("tweak: {e}")))?;
    let tweaked = sk
        .add_tweak(&tweak)
        .map_err(|e| SecpError::Crypto(format!("privkey_tweak_add: {e}")))?;
    Ok(tweaked.secret_bytes().to_vec())
}

/// ECDH shared POINT, compressed 33 bytes — NOT hashed. BRC-42 keys its HMAC with the
/// raw compressed shared point (@bsv/sdk: `sharedSecret.encode(true)` where
/// sharedSecret = counterpartyPub.mulCT(priv)). We use secp256k1::ecdh::shared_secret_point
/// (the un-hashed x||y variant of ECDH) and compress: prefix 0x02/0x03 by y parity + x.
#[uniffi::export]
pub fn ecdh_shared_point(privkey32: Vec<u8>, pubkey33: Vec<u8>) -> Result<Vec<u8>, SecpError> {
    let sk = seckey(&privkey32)?;
    let pk = pubkey(&pubkey33)?;
    let xy: [u8; 64] = ecdh::shared_secret_point(&pk, &sk);
    let mut out = Vec::with_capacity(33);
    out.push(if xy[63] & 1 == 0 { 0x02 } else { 0x03 });
    out.extend_from_slice(&xy[..32]);
    Ok(out)
}

/// BRC-42 deriveChild (the composite the Nitro module will actually serve):
///   sharedPoint = compress(privkey · counterpartyPub)
///   tweak       = HMAC-SHA256(key = sharedPoint33, msg = utf8(invoiceNumber))
///   child       = (privkey + tweak) mod n
/// Byte-exact vs @bsv/sdk PrivateKey.deriveChild (nonce-free — no RFC 6979 involved).
#[uniffi::export]
pub fn brc42_derive_child(
    privkey32: Vec<u8>,
    counterparty_pubkey33: Vec<u8>,
    invoice_number: String,
) -> Result<Vec<u8>, SecpError> {
    let shared = ecdh_shared_point(privkey32.clone(), counterparty_pubkey33)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(&shared)
        .map_err(|e| SecpError::Crypto(format!("hmac: {e}")))?;
    mac.update(invoice_number.as_bytes());
    let tweak = mac.finalize().into_bytes();
    privkey_tweak_add(privkey32, tweak.to_vec())
}

// ═══ M2 Tier-1 extended surface (issues #5 recover/tweakMul/pointAdd, #6 Schnorr) ═══
//
// JS-parity contract for the extension (proven in tests/conformance.rs against
// fixtures/vectors.json regenerated from @bsv/sdk@2.1.6):
//   • `ecdsa_recover` == Signature.RecoverPublicKey(recid, msgHash) /
//     PublicKey.fromMsgHashAndCompactSignature — byte-exact for recid 0/1 (the only
//     recids real signatures produce; recid 2/3 requires r < p - n ≈ 2^128.4, i.e.
//     probability ~2^-127 per signature). DOCUMENTED ASYMMETRY: for recid 2/3 with
//     r >= p - n, @bsv/sdk Point.fromX REDUCES x = r + n mod p and may fabricate a
//     point, while libsecp256k1 rejects the field overflow outright. The app seam
//     falls back to pure JS on any native throw, so routed behavior equals the SDK
//     even there. (See tests/conformance.rs recover_all_factors handling.)
//   • `ecdsa_recovery_factor` == Signature.CalculateRecoveryFactor: tries recids
//     0..3 in the same order and returns the first whose recovered key equals the
//     expected pubkey; errors when none matches (SDK throws).
//   • `pubkey_tweak_mul` (t·P) and `pubkey_combine` (P+Q) are nonce-free curve math,
//     byte-exact vs Point.mul / Point.add for in-range inputs. libsecp rejects
//     scalar 0 / scalar >= n and infinity results where the SDK returns the infinity
//     point / reduces mod n — callers pre-reduce JS-side or fall back (fuzz-gated).
//   • `schnorr_generate_proof` / `schnorr_verify_proof` implement @bsv/sdk
//     primitives/Schnorr.ts (ZK proof of DH shared secret — NOT BIP-340) exactly:
//       challenge e = BigNumber(sha256(A33 ‖ B33 ‖ S33 ‖ S'33 ‖ R33)) umod n
//       generate:  R = r·G, S' = r·B, z = (r + e·a) mod n  → R33 ‖ S'33 ‖ z32
//       verify:    z·G == R + e·A  AND  z·B == S' + e·S
//     The nonce r is an EXPLICIT PARAMETER (the SDK draws it from
//     PrivateKey.fromRandom internally; the JS seam does the same and passes it in)
//     so the function stays deterministic and vector-testable.

/// secp256k1 group order n, big-endian (the SDK's curve.n).
const N_BE: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xfe, 0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36,
    0x41, 0x41,
];

/// hash32 mod n via a single conditional subtraction (hash < 2^256 < 2n, so one
/// subtraction suffices) — identical to the SDK's `new BigNumber(hash).umod(n)`.
fn reduce_mod_n(hash: &[u8; 32]) -> [u8; 32] {
    if hash < &N_BE {
        return *hash;
    }
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let d = hash[i] as i16 - N_BE[i] as i16 - borrow;
        if d < 0 {
            out[i] = (d + 256) as u8;
            borrow = 1;
        } else {
            out[i] = d as u8;
            borrow = 0;
        }
    }
    out
}

fn arr64(bytes: &[u8], what: &str) -> Result<[u8; 64], SecpError> {
    <[u8; 64]>::try_from(bytes)
        .map_err(|_| SecpError::InvalidInput(format!("{what}: expected 64 bytes, got {}", bytes.len())))
}

fn recid(v: u8) -> Result<RecoveryId, SecpError> {
    RecoveryId::try_from(v as i32)
        .map_err(|_| SecpError::InvalidInput(format!("recovery id {v} out of range 0..=3")))
}

fn recover_inner(msg32: &[u8], rs64: &[u8; 64], rec: u8) -> Result<PublicKey, SecpError> {
    let msg = Message::from_digest(arr32(msg32, "msg32")?);
    let sig = RecoverableSignature::from_compact(rs64, recid(rec)?)
        .map_err(|e| SecpError::InvalidInput(format!("compact sig: {e}")))?;
    SECP256K1
        .recover_ecdsa(msg, &sig)
        .map_err(|e| SecpError::Crypto(format!("recover: {e}")))
}

/// ECDSA public-key recovery from a 65-byte SDK compact signature
/// (`Signature.toCompact` layout: [compactByte 27..=34, r32, s32] — 27..31 =
/// uncompressed flag, 31..35 = compressed; recovery id = (compactByte - 27) & 3,
/// exactly `PublicKey.fromMsgHashAndCompactSignature`). Returns the compressed
/// 33-byte public key. Byte-exact vs @bsv/sdk for recid 0/1; see the module note
/// above for the recid-2/3 field-overflow asymmetry (native rejects, seam falls
/// back to JS).
#[uniffi::export]
pub fn ecdsa_recover(msg32: Vec<u8>, compact65: Vec<u8>) -> Result<Vec<u8>, SecpError> {
    if compact65.len() != 65 {
        return Err(SecpError::InvalidInput(format!(
            "compact65: expected 65 bytes, got {}",
            compact65.len()
        )));
    }
    let cb = compact65[0];
    if !(27..35).contains(&cb) {
        return Err(SecpError::InvalidInput(format!("compact byte {cb} out of range 27..=34")));
    }
    let rec = (cb - 27) & 3;
    let rs = arr64(&compact65[1..], "compact65 r||s")?;
    Ok(recover_inner(&msg32, &rs, rec)?.serialize().to_vec())
}

/// Recovery-factor search — `Signature.CalculateRecoveryFactor` semantics: try
/// recids 0..=3 in order, return the first whose recovered key equals `pubkey33`,
/// error when none matches (the SDK throws 'Unable to find valid recovery factor').
/// `sig64` is r32 ‖ s32 (the compact signature without the recovery byte).
#[uniffi::export]
pub fn ecdsa_recovery_factor(
    msg32: Vec<u8>,
    sig64: Vec<u8>,
    pubkey33: Vec<u8>,
) -> Result<u32, SecpError> {
    let expected = pubkey(&pubkey33)?.serialize();
    let rs = arr64(&sig64, "sig64")?;
    for rec in 0u8..4 {
        if let Ok(pk) = recover_inner(&msg32, &rs, rec) {
            if pk.serialize() == expected {
                return Ok(rec as u32);
            }
        }
    }
    Err(SecpError::Crypto("unable to find valid recovery factor".into()))
}

/// t·P — compressed in, compressed out (@bsv/sdk Point.mul with a scalar in
/// [1, n-1]). libsecp rejects t = 0 and t >= n (the SDK reduces mod n / returns
/// infinity) — callers pre-reduce JS-side; out-of-range input here is an error.
#[uniffi::export]
pub fn pubkey_tweak_mul(pubkey33: Vec<u8>, scalar32: Vec<u8>) -> Result<Vec<u8>, SecpError> {
    let pk = pubkey(&pubkey33)?;
    let t = Scalar::from_be_bytes(arr32(&scalar32, "scalar")?)
        .map_err(|e| SecpError::InvalidInput(format!("scalar: {e}")))?;
    let out = pk
        .mul_tweak(SECP256K1, &t)
        .map_err(|e| SecpError::Crypto(format!("pubkey_tweak_mul: {e}")))?;
    Ok(out.serialize().to_vec())
}

/// P + Q — compressed in, compressed out (@bsv/sdk Point.add, incl. P == Q
/// doubling). P + (-P) (the infinity result) is an error here, matching the app
/// seam's fallback contract (the SDK returns the infinity point).
#[uniffi::export]
pub fn pubkey_combine(pubkey33_a: Vec<u8>, pubkey33_b: Vec<u8>) -> Result<Vec<u8>, SecpError> {
    let a = pubkey(&pubkey33_a)?;
    let b = pubkey(&pubkey33_b)?;
    let out = a
        .combine(&b)
        .map_err(|e| SecpError::Crypto(format!("pubkey_combine: {e}")))?;
    Ok(out.serialize().to_vec())
}

/// Schnorr.ts challenge: e = BigNumber(sha256(A ‖ B ‖ S ‖ S' ‖ R)) umod n, all
/// points compressed 33-byte. Public for tests; NOT exported over FFI (the flow
/// fns below compose it).
pub fn schnorr_challenge(
    a33: &[u8],
    b33: &[u8],
    s33: &[u8],
    sprime33: &[u8],
    r33: &[u8],
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(a33);
    h.update(b33);
    h.update(s33);
    h.update(sprime33);
    h.update(r33);
    reduce_mod_n(&h.finalize().into())
}

/// @bsv/sdk Schnorr.generateProof (ZK proof of DH shared secret, NOT BIP-340)
/// with the nonce r as an explicit parameter (the SDK draws it internally from
/// PrivateKey.fromRandom; the JS seam does the same and passes it in):
///   R = r·G,  S' = r·B,  e = challenge(A, B, S, S', R),  z = (r + e·a) mod n
/// Returns R33 ‖ S'33 ‖ z32 (98 bytes), byte-exact vs the SDK given the same r.
/// A is a parameter (not derived from a) because the SDK hashes the CALLER's A.
#[uniffi::export]
pub fn schnorr_generate_proof(
    a32: Vec<u8>,
    a_pub33: Vec<u8>,
    b_pub33: Vec<u8>,
    s_point33: Vec<u8>,
    r32: Vec<u8>,
) -> Result<Vec<u8>, SecpError> {
    let sk_a = seckey(&a32)?;
    let a_pub = pubkey(&a_pub33)?;
    let b_pub = pubkey(&b_pub33)?;
    let s_pub = pubkey(&s_point33)?;
    let sk_r = SecretKey::from_byte_array(arr32(&r32, "r")?)
        .map_err(|e| SecpError::InvalidInput(format!("r: {e}")))?;

    let r_point = sk_r.public_key(SECP256K1);
    let r_scalar = Scalar::from(sk_r);
    let s_prime = b_pub
        .mul_tweak(SECP256K1, &r_scalar)
        .map_err(|e| SecpError::Crypto(format!("r·B: {e}")))?;

    let e = schnorr_challenge(
        &a_pub.serialize(),
        &b_pub.serialize(),
        &s_pub.serialize(),
        &s_prime.serialize(),
        &r_point.serialize(),
    );
    // z = (r + e·a) mod n. e = 0 (probability ~2^-256) or z = 0 (ditto) are
    // SecretKey-domain errors — the seam falls back to the pure-JS path there.
    let e_scalar = Scalar::from_be_bytes(e).expect("reduced mod n");
    let z = sk_a
        .mul_tweak(&e_scalar)
        .map_err(|e| SecpError::Crypto(format!("e·a: {e}")))?
        .add_tweak(&r_scalar)
        .map_err(|e| SecpError::Crypto(format!("r + e·a: {e}")))?;

    let mut out = Vec::with_capacity(98);
    out.extend_from_slice(&r_point.serialize());
    out.extend_from_slice(&s_prime.serialize());
    out.extend_from_slice(&z.secret_bytes());
    Ok(out)
}

/// @bsv/sdk Schnorr.verifyProof:
///   e = challenge(A, B, S, S', R);  valid ⇔ z·G == R + e·A  AND  z·B == S' + e·S
/// z must be in [1, n-1]. The seam routes ONLY in-range z and falls back to pure
/// JS otherwise — measured fact (fuzz probe schnorr_z_ge_n + direct host test):
/// the SDK's Point.mul is NOT consistently (z mod n)·G for out-of-range scalars
/// (g.mul(n+1) matches the reduced value but g.mul(2^256-1) does not), so
/// pre-reducing would CHANGE the SDK's verdict for adversarial z; only the JS
/// fallback preserves it. z = 0 is likewise an error → JS fallback (the SDK
/// compares against the infinity point there). An infinity sum on the
/// right-hand side (combine error) is a defined FALSE, exactly like the SDK's
/// eq() against a finite left side.
#[uniffi::export]
pub fn schnorr_verify_proof(
    a_pub33: Vec<u8>,
    b_pub33: Vec<u8>,
    s_point33: Vec<u8>,
    r_point33: Vec<u8>,
    s_prime33: Vec<u8>,
    z32: Vec<u8>,
) -> Result<bool, SecpError> {
    let a_pub = pubkey(&a_pub33)?;
    let b_pub = pubkey(&b_pub33)?;
    let s_pub = pubkey(&s_point33)?;
    let r_pub = pubkey(&r_point33)?;
    let sp_pub = pubkey(&s_prime33)?;
    let z = SecretKey::from_byte_array(arr32(&z32, "z")?)
        .map_err(|e| SecpError::InvalidInput(format!("z: {e}")))?;

    let e = schnorr_challenge(
        &a_pub.serialize(),
        &b_pub.serialize(),
        &s_pub.serialize(),
        &sp_pub.serialize(),
        &r_pub.serialize(),
    );
    let z_scalar = Scalar::from(z);

    // Left sides: z ∈ [1, n-1] ⇒ both are finite points.
    let z_g = z.public_key(SECP256K1);
    let z_b = b_pub
        .mul_tweak(SECP256K1, &z_scalar)
        .map_err(|e| SecpError::Crypto(format!("z·B: {e}")))?;

    // Right sides. e = 0 (probability ~2^-256): e·X is the infinity point, so
    // R + e·A = R and S' + e·S = S' — the SDK path; libsecp can't multiply by 0.
    let (rhs1, rhs2) = if e == [0u8; 32] {
        (Some(r_pub), Some(sp_pub))
    } else {
        let e_scalar = Scalar::from_be_bytes(e).expect("reduced mod n");
        let e_a = a_pub
            .mul_tweak(SECP256K1, &e_scalar)
            .map_err(|e| SecpError::Crypto(format!("e·A: {e}")))?;
        let e_s = s_pub
            .mul_tweak(SECP256K1, &e_scalar)
            .map_err(|e| SecpError::Crypto(format!("e·S: {e}")))?;
        // combine == Err means the sum is infinity — never equal to a finite
        // left side, i.e. a defined FALSE (matches SDK eq()).
        (r_pub.combine(&e_a).ok(), sp_pub.combine(&e_s).ok())
    };

    let ok1 = rhs1.is_some_and(|p| p.serialize() == z_g.serialize());
    let ok2 = rhs2.is_some_and(|p| p.serialize() == z_b.serialize());
    Ok(ok1 && ok2)
}

// ═══ M3 Tier-2 surface (issues #8/#9: batch flow calls + uncompressed outputs) ═══
//
// JS-parity contract for the extension (proven in tests/conformance.rs against
// fixtures/vectors.json regenerated from @bsv/sdk@2.1.6, and differentially in
// the differential-fuzz harness secp-native-oracle):
//   • Every batch fn is DEFINED as the element-wise application of the proven
//     single-op fn — same math, same errors. Any invalid element fails the WHOLE
//     call (the JS seam then falls back to the per-op path), so a batch can never
//     silently produce a partial result.
//   • `*_uncompressed` variants return 65-byte 0x04‖x‖y SEC1 points that are the
//     exact decompression of the corresponding compressed outputs — byte-equal to
//     @bsv/sdk `Point.encode(false)`. They exist to kill the JS-side
//     `Point.fromX` BigInt modular-sqrt cost at the Nitro seam (measured
//     ~450–550µs per point on release Hermes — M2-DEVICE-RESULTS.md).
//   • Wire framing (bytes-only seam, no lists of lists where avoidable):
//       batch_ecdsa_sign        msgs = N×32 cat, keys = N×32 cat
//                               → per element [1-byte derLen][der][33-byte pubkey]
//                               (the pubkey rides along because the P2PKH unlock
//                               flow needs key→pubkey for the script; it equals
//                               pubkey_create(key) byte-for-byte)
//       batch_ecdsa_verify      msgs = N×32 cat, sigs = per element [1-byte derLen][der],
//                               pubkeys = N×33 cat → N bytes of 0/1
//       batch_brc42_derive_child          → N×32 cat (shared point computed ONCE —
//                               it depends only on (root, counterparty), so this
//                               is exactly the per-op composite refactored)
//       batch_brc42_derive_child_pub_uncompressed → N×65 cat

/// Compressed → uncompressed helper: serialize_uncompressed of an already-parsed key.
fn uncompressed(pk: &PublicKey) -> Vec<u8> {
    pk.serialize_uncompressed().to_vec()
}

/// 65-byte 0x04‖x‖y public key for a private key — decompressed `pubkey_create`.
#[uniffi::export]
pub fn pubkey_create_uncompressed(privkey32: Vec<u8>) -> Result<Vec<u8>, SecpError> {
    let sk = seckey(&privkey32)?;
    Ok(uncompressed(&sk.public_key(SECP256K1)))
}

/// 65-byte ECDH shared POINT — decompressed `ecdh_shared_point` (NOT hashed).
#[uniffi::export]
pub fn ecdh_shared_point_uncompressed(
    privkey32: Vec<u8>,
    pubkey33: Vec<u8>,
) -> Result<Vec<u8>, SecpError> {
    let sk = seckey(&privkey32)?;
    let pk = pubkey(&pubkey33)?;
    let xy: [u8; 64] = ecdh::shared_secret_point(&pk, &sk);
    let mut out = Vec::with_capacity(65);
    out.push(0x04);
    out.extend_from_slice(&xy);
    Ok(out)
}

/// 65-byte P + t·G — decompressed `pubkey_tweak_add`.
#[uniffi::export]
pub fn pubkey_tweak_add_uncompressed(
    pubkey33: Vec<u8>,
    tweak32: Vec<u8>,
) -> Result<Vec<u8>, SecpError> {
    let pk = pubkey(&pubkey33)?;
    let tweak = Scalar::from_be_bytes(arr32(&tweak32, "tweak")?)
        .map_err(|e| SecpError::InvalidInput(format!("tweak: {e}")))?;
    let tweaked = pk
        .add_exp_tweak(SECP256K1, &tweak)
        .map_err(|e| SecpError::Crypto(format!("pubkey_tweak_add: {e}")))?;
    Ok(uncompressed(&tweaked))
}

/// 65-byte recovered public key — decompressed `ecdsa_recover` (same compact65
/// layout and same recid-2/3 field-overflow rejection → JS fallback at the seam).
#[uniffi::export]
pub fn ecdsa_recover_uncompressed(
    msg32: Vec<u8>,
    compact65: Vec<u8>,
) -> Result<Vec<u8>, SecpError> {
    if compact65.len() != 65 {
        return Err(SecpError::InvalidInput(format!(
            "compact65: expected 65 bytes, got {}",
            compact65.len()
        )));
    }
    let cb = compact65[0];
    if !(27..35).contains(&cb) {
        return Err(SecpError::InvalidInput(format!("compact byte {cb} out of range 27..=34")));
    }
    let rec = (cb - 27) & 3;
    let rs = arr64(&compact65[1..], "compact65 r||s")?;
    Ok(uncompressed(&recover_inner(&msg32, &rs, rec)?))
}

/// BRC-42 tweak for (shared33, invoice): HMAC-SHA256(key = sharedPoint33, msg = utf8(invoice)).
fn brc42_tweak(shared33: &[u8], invoice_number: &str) -> Result<[u8; 32], SecpError> {
    let mut mac = Hmac::<Sha256>::new_from_slice(shared33)
        .map_err(|e| SecpError::Crypto(format!("hmac: {e}")))?;
    mac.update(invoice_number.as_bytes());
    Ok(mac.finalize().into_bytes().into())
}

/// BRC-42 PUBLIC-side deriveChild composite, uncompressed output:
///   shared = compress(privkey · pubkey)
///   tweak  = HMAC-SHA256(key = shared33, msg = utf8(invoiceNumber))
///   child  = pubkey + tweak·G   (65-byte 0x04‖x‖y)
/// Equals @bsv/sdk PublicKey.deriveChild(privateKey, invoiceNumber).encode(false)
/// byte-for-byte (nonce-free).
#[uniffi::export]
pub fn brc42_derive_child_pub_uncompressed(
    privkey32: Vec<u8>,
    pubkey33: Vec<u8>,
    invoice_number: String,
) -> Result<Vec<u8>, SecpError> {
    let shared = ecdh_shared_point(privkey32, pubkey33.clone())?;
    let tweak = brc42_tweak(&shared, &invoice_number)?;
    let pk = pubkey(&pubkey33)?;
    let t = Scalar::from_be_bytes(tweak)
        .map_err(|e| SecpError::InvalidInput(format!("tweak: {e}")))?;
    let child = pk
        .add_exp_tweak(SECP256K1, &t)
        .map_err(|e| SecpError::Crypto(format!("brc42 pub tweak_add: {e}")))?;
    Ok(uncompressed(&child))
}

fn split_cat<'a>(cat: &'a [u8], width: usize, what: &str) -> Result<Vec<&'a [u8]>, SecpError> {
    if cat.is_empty() || cat.len() % width != 0 {
        return Err(SecpError::InvalidInput(format!(
            "{what}: expected non-empty multiple of {width} bytes, got {}",
            cat.len()
        )));
    }
    Ok(cat.chunks(width).collect())
}

/// Batch ECDSA sign — ONE crossing for a whole transaction's inputs.
/// Inputs: N×32 message digests and N×32 private keys, concatenated.
/// Output, per element: [1-byte derLen][DER signature][33-byte compressed pubkey].
/// Each element is EXACTLY ecdsa_sign(msg_i, key_i) ‖ pubkey_create(key_i); any
/// invalid element errors the whole call (seam falls back to the per-op path).
#[uniffi::export]
pub fn batch_ecdsa_sign(msgs32_cat: Vec<u8>, privkeys32_cat: Vec<u8>) -> Result<Vec<u8>, SecpError> {
    let msgs = split_cat(&msgs32_cat, 32, "msgs32_cat")?;
    let keys = split_cat(&privkeys32_cat, 32, "privkeys32_cat")?;
    if msgs.len() != keys.len() {
        return Err(SecpError::InvalidInput(format!(
            "batch length mismatch: {} msgs vs {} keys",
            msgs.len(),
            keys.len()
        )));
    }
    let mut out = Vec::with_capacity(msgs.len() * 106);
    for (msg, key) in msgs.iter().zip(keys.iter()) {
        let m = Message::from_digest(arr32(msg, "msg32")?);
        let sk = seckey(key)?;
        let der = SECP256K1.sign_ecdsa(m, &sk).serialize_der();
        out.push(der.len() as u8);
        out.extend_from_slice(&der);
        out.extend_from_slice(&sk.public_key(SECP256K1).serialize());
    }
    Ok(out)
}

/// Batch ECDSA verify — ONE crossing for a whole BEEF/SPV check set.
/// Inputs: N×32 digests cat, sigs framed per element as [1-byte derLen][DER],
/// N×33 compressed pubkeys cat. Output: N bytes, 1 = valid, 0 = invalid.
/// Element semantics identical to ecdsa_verify (S normalized first); malformed
/// framing/sig/pubkey errors the whole call (seam falls back to per-op).
#[uniffi::export]
pub fn batch_ecdsa_verify(
    msgs32_cat: Vec<u8>,
    sigs_framed: Vec<u8>,
    pubkeys33_cat: Vec<u8>,
) -> Result<Vec<u8>, SecpError> {
    let msgs = split_cat(&msgs32_cat, 32, "msgs32_cat")?;
    let pubs = split_cat(&pubkeys33_cat, 33, "pubkeys33_cat")?;
    if msgs.len() != pubs.len() {
        return Err(SecpError::InvalidInput(format!(
            "batch length mismatch: {} msgs vs {} pubkeys",
            msgs.len(),
            pubs.len()
        )));
    }
    let mut sigs: Vec<&[u8]> = Vec::with_capacity(msgs.len());
    let mut off = 0usize;
    while off < sigs_framed.len() {
        let len = sigs_framed[off] as usize;
        off += 1;
        if off + len > sigs_framed.len() {
            return Err(SecpError::InvalidInput("sigs_framed: truncated frame".into()));
        }
        sigs.push(&sigs_framed[off..off + len]);
        off += len;
    }
    if sigs.len() != msgs.len() {
        return Err(SecpError::InvalidInput(format!(
            "batch length mismatch: {} msgs vs {} sigs",
            msgs.len(),
            sigs.len()
        )));
    }
    let mut out = Vec::with_capacity(msgs.len());
    for i in 0..msgs.len() {
        let m = Message::from_digest(arr32(msgs[i], "msg32")?);
        let pk = pubkey(pubs[i])?;
        let mut sig = Signature::from_der(sigs[i])
            .map_err(|e| SecpError::InvalidInput(format!("der_sig[{i}]: {e}")))?;
        sig.normalize_s();
        out.push(u8::from(SECP256K1.verify_ecdsa(m, &sig, &pk).is_ok()));
    }
    Ok(out)
}

/// Batch BRC-42 PRIVATE-side deriveChild — ONE crossing for a whole flow's
/// derivations against one counterparty. The ECDH shared point depends only on
/// (root, counterparty) and is computed once; per invoice: HMAC + (k + t) mod n.
/// Output: N×32 child private keys, cat. Element i == brc42_derive_child(root,
/// counterparty, invoice_i) byte-for-byte.
#[uniffi::export]
pub fn batch_brc42_derive_child(
    privkey32: Vec<u8>,
    counterparty_pubkey33: Vec<u8>,
    invoice_numbers: Vec<String>,
) -> Result<Vec<u8>, SecpError> {
    if invoice_numbers.is_empty() {
        return Err(SecpError::InvalidInput("invoice_numbers: empty batch".into()));
    }
    let shared = ecdh_shared_point(privkey32.clone(), counterparty_pubkey33)?;
    let sk = seckey(&privkey32)?;
    let mut out = Vec::with_capacity(invoice_numbers.len() * 32);
    for inv in &invoice_numbers {
        let tweak = Scalar::from_be_bytes(brc42_tweak(&shared, inv)?)
            .map_err(|e| SecpError::InvalidInput(format!("tweak: {e}")))?;
        let child = sk
            .add_tweak(&tweak)
            .map_err(|e| SecpError::Crypto(format!("privkey_tweak_add: {e}")))?;
        out.extend_from_slice(&child.secret_bytes());
    }
    Ok(out)
}

/// Batch BRC-42 PUBLIC-side deriveChild, uncompressed — ONE crossing for a whole
/// flow's output-key derivations against one counterparty. Output: N×65 cat.
/// Element i == brc42_derive_child_pub_uncompressed(priv, pub, invoice_i).
#[uniffi::export]
pub fn batch_brc42_derive_child_pub_uncompressed(
    privkey32: Vec<u8>,
    pubkey33: Vec<u8>,
    invoice_numbers: Vec<String>,
) -> Result<Vec<u8>, SecpError> {
    if invoice_numbers.is_empty() {
        return Err(SecpError::InvalidInput("invoice_numbers: empty batch".into()));
    }
    let shared = ecdh_shared_point(privkey32, pubkey33.clone())?;
    let pk = pubkey(&pubkey33)?;
    let mut out = Vec::with_capacity(invoice_numbers.len() * 65);
    for inv in &invoice_numbers {
        let t = Scalar::from_be_bytes(brc42_tweak(&shared, inv)?)
            .map_err(|e| SecpError::InvalidInput(format!("tweak: {e}")))?;
        let child = pk
            .add_exp_tweak(SECP256K1, &t)
            .map_err(|e| SecpError::Crypto(format!("brc42 pub tweak_add: {e}")))?;
        out.extend_from_slice(&child.serialize_uncompressed());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(s: &str) -> Vec<u8> {
        hex::decode(s).unwrap()
    }

    /// Smoke: sign → verify round-trip through the bytes-only API, plus low-S invariant.
    #[test]
    fn sign_verify_roundtrip() {
        let priv1 = h("0000000000000000000000000000000000000000000000000000000000000001");
        let msg = h("9c12cfdc04c74584d787ac3d23772132c18524bc7ab28dec4219b8fc5b425f70");
        let pk = pubkey_create(priv1.clone()).unwrap();
        assert_eq!(pk.len(), 33);
        let der = ecdsa_sign(msg.clone(), priv1.clone()).unwrap();
        assert!(ecdsa_verify(msg.clone(), der.clone(), pk.clone()).unwrap());
        // wrong msg fails cleanly
        let mut msg2 = msg.clone();
        msg2[0] ^= 1;
        assert!(!ecdsa_verify(msg2, der, pk).unwrap());
    }

    /// ecdh_shared_point (shared_secret_point + manual compression) must equal the
    /// mul_tweak formulation — cross-check of the compression logic.
    #[test]
    fn ecdh_point_matches_mul_tweak() {
        let a = h("6f2a3b4c5d6e7f80912233445566778899aabbccddeeff00112233445566778f");
        let b = h("2222222222222222222222222222222222222222222222222222222222222222");
        let pub_b = pubkey_create(b.clone()).unwrap();
        let via_ffi = ecdh_shared_point(a.clone(), pub_b.clone()).unwrap();

        let pk = PublicKey::from_slice(&pub_b).unwrap();
        let scalar = Scalar::from_be_bytes(<[u8; 32]>::try_from(a.as_slice()).unwrap()).unwrap();
        let via_mul = pk.mul_tweak(SECP256K1, &scalar).unwrap().serialize().to_vec();
        assert_eq!(via_ffi, via_mul);
    }

    /// privkey_tweak_add and pubkey_tweak_add must commute with pubkey_create:
    /// pubkey(priv + t) == pubkey(priv) + t·G.
    #[test]
    fn tweak_add_commutes() {
        let k = h("4a5b6c7d8e9fa0b1c2d3e4f5061728394a5b6c7d8e9fa0b1c2d3e4f506172839");
        let t = h("00000000000000000000000000000000000000000000000000000000000000ff");
        let left = pubkey_create(privkey_tweak_add(k.clone(), t.clone()).unwrap()).unwrap();
        let right = pubkey_tweak_add(pubkey_create(k).unwrap(), t).unwrap();
        assert_eq!(left, right);
    }

    /// Recovery round-trip: sign, find the factor, recover — must yield the
    /// signing pubkey; wrong-parity recid must yield a DIFFERENT key or reject.
    #[test]
    fn recover_roundtrip() {
        let privk = h("4a5b6c7d8e9fa0b1c2d3e4f5061728394a5b6c7d8e9fa0b1c2d3e4f506172839");
        let msg = h("9c12cfdc04c74584d787ac3d23772132c18524bc7ab28dec4219b8fc5b425f70");
        let pk = pubkey_create(privk.clone()).unwrap();
        let der = ecdsa_sign(msg.clone(), privk).unwrap();
        // DER → r32||s32 (both integers are ≤ 32 bytes with optional 0x00 pad)
        let sig = Signature::from_der(&der).unwrap();
        let rs64 = sig.serialize_compact().to_vec();
        let rec = ecdsa_recovery_factor(msg.clone(), rs64.clone(), pk.clone()).unwrap();
        assert!(rec < 2, "real signatures recover with recid 0/1");
        let mut compact = vec![27 + 4 + rec as u8];
        compact.extend_from_slice(&rs64);
        assert_eq!(ecdsa_recover(msg.clone(), compact.clone()).unwrap(), pk);
        // flipped parity → different candidate key (or reject)
        compact[0] = 27 + 4 + (rec ^ 1) as u8;
        if let Ok(other) = ecdsa_recover(msg, compact) {
            assert_ne!(other, pk);
        }
    }

    /// tweak_mul and combine agree with the scalar-arithmetic definitions:
    /// t·(k·G) == (t·k mod n)·G and P+Q == (p+q mod n)·G.
    #[test]
    fn tweak_mul_and_combine_consistent() {
        let k = h("6f2a3b4c5d6e7f80912233445566778899aabbccddeeff00112233445566778f");
        let t = h("00000000000000000000000000000000000000000000000000000000000000ff");
        let pk = pubkey_create(k.clone()).unwrap();
        // t·P via FFI == pubkey of (k·t mod n)
        let sk = SecretKey::from_byte_array(<[u8; 32]>::try_from(k.as_slice()).unwrap()).unwrap();
        let t_scalar = Scalar::from_be_bytes(<[u8; 32]>::try_from(t.as_slice()).unwrap()).unwrap();
        let kt = sk.mul_tweak(&t_scalar).unwrap();
        assert_eq!(
            pubkey_tweak_mul(pk.clone(), t.clone()).unwrap(),
            kt.public_key(SECP256K1).serialize().to_vec()
        );
        // P + t·G via combine == pubkey_tweak_add(P, t)
        let t_g = pubkey_create({
            let mut v = vec![0u8; 32];
            v[31] = 0xff;
            v
        })
        .unwrap();
        assert_eq!(
            pubkey_combine(pk.clone(), t_g).unwrap(),
            pubkey_tweak_add(pk.clone(), t.clone()).unwrap()
        );
        // doubling: P + P == 2·P
        let two = {
            let mut v = vec![0u8; 32];
            v[31] = 2;
            v
        };
        assert_eq!(
            pubkey_combine(pk.clone(), pk.clone()).unwrap(),
            pubkey_tweak_mul(pk, two).unwrap()
        );
    }

    /// Schnorr flow: generate → verify true; corrupt any input → false.
    #[test]
    fn schnorr_roundtrip_and_rejects() {
        let a = h("1111111111111111111111111111111111111111111111111111111111111111");
        let b = h("2222222222222222222222222222222222222222222222222222222222222222");
        let r = h("3333333333333333333333333333333333333333333333333333333333333333");
        let a_pub = pubkey_create(a.clone()).unwrap();
        let b_pub = pubkey_create(b.clone()).unwrap();
        // S = a·B
        let s = pubkey_tweak_mul(b_pub.clone(), a.clone()).unwrap();
        let proof = schnorr_generate_proof(a, a_pub.clone(), b_pub.clone(), s.clone(), r).unwrap();
        assert_eq!(proof.len(), 98);
        let (r33, rest) = proof.split_at(33);
        let (sp33, z32) = rest.split_at(33);
        assert!(schnorr_verify_proof(
            a_pub.clone(), b_pub.clone(), s.clone(), r33.to_vec(), sp33.to_vec(), z32.to_vec()
        )
        .unwrap());
        // corrupt z (+1; no wraparound risk for this fixed vector)
        let mut z_bad = z32.to_vec();
        z_bad[31] = z_bad[31].wrapping_add(1);
        assert!(!schnorr_verify_proof(
            a_pub.clone(), b_pub.clone(), s.clone(), r33.to_vec(), sp33.to_vec(), z_bad
        )
        .unwrap());
        // wrong shared secret: S' in place of S
        assert!(!schnorr_verify_proof(
            a_pub, b_pub, sp33.to_vec(), r33.to_vec(), sp33.to_vec(), z32.to_vec()
        )
        .unwrap());
    }

    /// reduce_mod_n: identity below n, subtraction at/above n.
    #[test]
    fn reduce_mod_n_edges() {
        let below = {
            let mut v = N_BE;
            v[31] -= 1;
            v
        };
        assert_eq!(reduce_mod_n(&below), below);
        assert_eq!(reduce_mod_n(&N_BE), [0u8; 32]);
        let mut above = N_BE;
        above[31] += 1;
        let mut one = [0u8; 32];
        one[31] = 1;
        assert_eq!(reduce_mod_n(&above), one);
        assert_eq!(reduce_mod_n(&[0xffu8; 32]), {
            // 2^256 - 1 - n
            let mut d = [0u8; 32];
            let mut borrow = 0i16;
            for i in (0..32).rev() {
                let x = 0xff_i16 - N_BE[i] as i16 - borrow;
                if x < 0 {
                    d[i] = (x + 256) as u8;
                    borrow = 1;
                } else {
                    d[i] = x as u8;
                    borrow = 0;
                }
            }
            d
        });
    }

    /// M3: uncompressed variants are the exact decompression of the compressed
    /// outputs (libsecp parses the 33-byte form and re-serializes uncompressed).
    #[test]
    fn uncompressed_variants_match_compressed() {
        let k = h("6f2a3b4c5d6e7f80912233445566778899aabbccddeeff00112233445566778f");
        let b = h("2222222222222222222222222222222222222222222222222222222222222222");
        let t = h("00000000000000000000000000000000000000000000000000000000000000ff");
        let decomp = |c33: &[u8]| -> Vec<u8> {
            PublicKey::from_slice(c33).unwrap().serialize_uncompressed().to_vec()
        };
        let pub_b = pubkey_create(b.clone()).unwrap();
        // pubkey_create
        assert_eq!(
            pubkey_create_uncompressed(k.clone()).unwrap(),
            decomp(&pubkey_create(k.clone()).unwrap())
        );
        // ecdh
        assert_eq!(
            ecdh_shared_point_uncompressed(k.clone(), pub_b.clone()).unwrap(),
            decomp(&ecdh_shared_point(k.clone(), pub_b.clone()).unwrap())
        );
        // tweak add
        assert_eq!(
            pubkey_tweak_add_uncompressed(pub_b.clone(), t.clone()).unwrap(),
            decomp(&pubkey_tweak_add(pub_b.clone(), t.clone()).unwrap())
        );
        // recover
        let msg = h("9c12cfdc04c74584d787ac3d23772132c18524bc7ab28dec4219b8fc5b425f70");
        let der = ecdsa_sign(msg.clone(), k.clone()).unwrap();
        let rs64 = Signature::from_der(&der).unwrap().serialize_compact().to_vec();
        let pk = pubkey_create(k.clone()).unwrap();
        let rec = ecdsa_recovery_factor(msg.clone(), rs64.clone(), pk.clone()).unwrap();
        let mut compact = vec![27 + 4 + rec as u8];
        compact.extend_from_slice(&rs64);
        assert_eq!(
            ecdsa_recover_uncompressed(msg.clone(), compact.clone()).unwrap(),
            decomp(&ecdsa_recover(msg, compact).unwrap())
        );
        // brc42 pub-side composite: child = P + hmac·G == tweak_add path
        let shared = ecdh_shared_point(k.clone(), pub_b.clone()).unwrap();
        let tweak = brc42_tweak(&shared, "invoice-xyz").unwrap();
        assert_eq!(
            brc42_derive_child_pub_uncompressed(k.clone(), pub_b.clone(), "invoice-xyz".into())
                .unwrap(),
            pubkey_tweak_add_uncompressed(pub_b.clone(), tweak.to_vec()).unwrap()
        );
    }

    /// M3: batch fns equal the per-op fns element-wise, and framing round-trips.
    #[test]
    fn batch_matches_per_op() {
        let n = 5usize;
        let mut msgs_cat = Vec::new();
        let mut keys_cat = Vec::new();
        let mut keys = Vec::new();
        let mut msgs = Vec::new();
        for i in 0..n {
            let mut k = h("4a5b6c7d8e9fa0b1c2d3e4f5061728394a5b6c7d8e9fa0b1c2d3e4f506172839");
            k[31] = k[31].wrapping_add(i as u8);
            let mut m = h("9c12cfdc04c74584d787ac3d23772132c18524bc7ab28dec4219b8fc5b425f70");
            m[0] = i as u8;
            msgs_cat.extend_from_slice(&m);
            keys_cat.extend_from_slice(&k);
            keys.push(k);
            msgs.push(m);
        }
        // batch sign == per-op sign + per-op pubkey_create, framed
        let framed = batch_ecdsa_sign(msgs_cat.clone(), keys_cat.clone()).unwrap();
        let mut off = 0usize;
        let mut sigs_framed = Vec::new();
        let mut pubs_cat = Vec::new();
        for i in 0..n {
            let len = framed[off] as usize;
            let der = &framed[off + 1..off + 1 + len];
            let pk = &framed[off + 1 + len..off + 1 + len + 33];
            assert_eq!(der, ecdsa_sign(msgs[i].clone(), keys[i].clone()).unwrap().as_slice());
            assert_eq!(pk, pubkey_create(keys[i].clone()).unwrap().as_slice());
            sigs_framed.push(len as u8);
            sigs_framed.extend_from_slice(der);
            pubs_cat.extend_from_slice(pk);
            off += 1 + len + 33;
        }
        assert_eq!(off, framed.len());
        // batch verify: all valid → all 1; corrupt one msg → that element 0
        let verdicts =
            batch_ecdsa_verify(msgs_cat.clone(), sigs_framed.clone(), pubs_cat.clone()).unwrap();
        assert_eq!(verdicts, vec![1u8; n]);
        let mut bad_msgs = msgs_cat.clone();
        bad_msgs[64] ^= 1; // element 2
        let verdicts2 = batch_ecdsa_verify(bad_msgs, sigs_framed, pubs_cat).unwrap();
        assert_eq!(verdicts2, vec![1, 1, 0, 1, 1]);
        // batch derive (priv + pub-uncompressed) == per-op composites element-wise
        let root = keys[0].clone();
        let cp_pub = pubkey_create(keys[1].clone()).unwrap();
        let invoices: Vec<String> = (0..n).map(|i| format!("2-batch-{i}")).collect();
        let priv_cat =
            batch_brc42_derive_child(root.clone(), cp_pub.clone(), invoices.clone()).unwrap();
        let pub_cat = batch_brc42_derive_child_pub_uncompressed(
            root.clone(),
            cp_pub.clone(),
            invoices.clone(),
        )
        .unwrap();
        for (i, inv) in invoices.iter().enumerate() {
            assert_eq!(
                &priv_cat[i * 32..(i + 1) * 32],
                brc42_derive_child(root.clone(), cp_pub.clone(), inv.clone()).unwrap().as_slice()
            );
            assert_eq!(
                &pub_cat[i * 65..(i + 1) * 65],
                brc42_derive_child_pub_uncompressed(root.clone(), cp_pub.clone(), inv.clone())
                    .unwrap()
                    .as_slice()
            );
        }
        // batch consistency: pubkey(child_priv) == child_pub when counterparty
        // pub belongs to cp AND root·G is the pub being derived... (BRC-42:
        // priv-side child of root vs pub-side child of root·G with the SAME
        // shared secret — cp derives our child pub)
        let root_pub = pubkey_create(root.clone()).unwrap();
        let cp_priv = keys[1].clone();
        let pub_cat2 =
            batch_brc42_derive_child_pub_uncompressed(cp_priv, root_pub, invoices.clone()).unwrap();
        for (i, _) in invoices.iter().enumerate() {
            let child_pub_from_priv = pubkey_create_uncompressed(
                priv_cat[i * 32..(i + 1) * 32].to_vec(),
            )
            .unwrap();
            assert_eq!(&pub_cat2[i * 65..(i + 1) * 65], child_pub_from_priv.as_slice());
        }
        // malformed batches error cleanly
        assert!(matches!(
            batch_ecdsa_sign(vec![0; 31], vec![0; 32]),
            Err(SecpError::InvalidInput(_))
        ));
        assert!(matches!(
            batch_ecdsa_sign(msgs_cat.clone(), vec![1; 64]),
            Err(SecpError::InvalidInput(_))
        ));
        assert!(matches!(
            batch_brc42_derive_child(root, cp_pub, vec![]),
            Err(SecpError::InvalidInput(_))
        ));
    }

    /// Malformed inputs surface clean SecpError (never a panic across the FFI).
    #[test]
    fn bad_inputs_error_cleanly() {
        assert!(matches!(ecdsa_sign(vec![0; 31], vec![0; 32]), Err(SecpError::InvalidInput(_))));
        assert!(matches!(pubkey_create(vec![0; 32]), Err(SecpError::InvalidInput(_)))); // sk=0 invalid
        assert!(matches!(
            ecdsa_verify(vec![0; 32], vec![0xde, 0xad], vec![2; 33]),
            Err(SecpError::InvalidInput(_))
        ));
    }
}
