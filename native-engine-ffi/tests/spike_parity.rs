//! Spike-parity gate: the FFI promotion changed NOTHING. Every output and every
//! error of this crate's `batch_sign_p2pkh_inputs` /
//! `compute_sighash_signing_order` / `compute_sighash_preimage_signing` must be
//! identical to the M5.3-PASSED spike `native-engine-poc` (the frozen,
//! 200k-case byte-parity-proven oracle, dev-dependency only).
//!
//! This is deliberately a DIFFERENT axis than tests/sign_core_crosscheck.rs:
//! that test proves raw DER equality of the two ECDSA cores; this one proves
//! the whole seam — framing, midstate cache, validation order, error variants —
//! composes to identical bytes. 2,000 deterministic adversarial cases
//! (SplitMix64, fixed seed) over the kill-test generator's dimensions:
//! n∈[1,24] inputs, 0..6 outputs, all six template scope combos, SINGLE with
//! index >= outputs, duplicate outpoints, sequence/satoshi/version/locktime
//! edges, plus must-Err probes (CHRONICLE, no-FORKID, bad lock, bad framing,
//! index OOR).

use native_engine_poc as spike;

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
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn bytes(&mut self, len: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(len);
        while out.len() < len {
            out.extend_from_slice(&self.next().to_le_bytes());
        }
        out.truncate(len);
        out
    }
}

fn var_int(w: &mut Vec<u8>, v: u64) {
    match v {
        0..=0xfc => w.push(v as u8),
        0xfd..=0xffff => {
            w.push(0xfd);
            w.extend_from_slice(&(v as u16).to_le_bytes());
        }
        _ => {
            w.push(0xfe);
            w.extend_from_slice(&(v as u32).to_le_bytes());
        }
    }
}

const SEQ_EDGES: [u32; 4] = [0, 1, 0xffff_fffe, 0xffff_ffff];
const SAT_EDGES: [u64; 5] = [0, 1, 546, 1 << 32, (1 << 53) - 1];
const SCOPES: [u32; 6] = [
    0x41,        // ALL|FORKID
    0x42,        // NONE|FORKID
    0x43,        // SINGLE|FORKID
    0xc1,        // ALL|ACP|FORKID
    0xc2,        // NONE|ACP|FORKID
    0xc3,        // SINGLE|ACP|FORKID
];

/// Random-but-deterministic unsigned tx + meta for n inputs.
fn gen_case(rng: &mut Rng) -> (Vec<u8>, Vec<u8>, u32) {
    let n_in = 1 + rng.below(24) as usize;
    let n_out = rng.below(7) as usize; // 0..=6 — SINGLE oor guaranteed reachable
    let mut tx = Vec::new();
    let version = [0i32, 1, 2, i32::MAX][rng.below(4) as usize];
    tx.extend_from_slice(&version.to_le_bytes());
    var_int(&mut tx, n_in as u64);
    let dup = rng.below(4) == 0 && n_in > 1; // duplicate outpoints sometimes
    let first_outpoint = (rng.bytes(32), rng.below(u32::MAX as u64) as u32);
    for i in 0..n_in {
        let (txid, vout) = if dup && i > 0 && rng.below(3) == 0 {
            first_outpoint.clone()
        } else {
            (rng.bytes(32), rng.below(u32::MAX as u64) as u32)
        };
        tx.extend_from_slice(&txid);
        tx.extend_from_slice(&vout.to_le_bytes());
        var_int(&mut tx, 0); // unsigned: empty script
        let seq = if rng.below(2) == 0 {
            SEQ_EDGES[rng.below(4) as usize]
        } else {
            rng.below(u32::MAX as u64) as u32
        };
        tx.extend_from_slice(&seq.to_le_bytes());
    }
    var_int(&mut tx, n_out as u64);
    for _ in 0..n_out {
        let sat = if rng.below(2) == 0 {
            SAT_EDGES[rng.below(5) as usize]
        } else {
            rng.below(1 << 53)
        };
        tx.extend_from_slice(&sat.to_le_bytes());
        let script: Vec<u8> = match rng.below(4) {
            0 => Vec::new(),
            1 => {
                let mut s = vec![0x76, 0xa9, 0x14];
                s.extend_from_slice(&rng.bytes(20));
                s.extend_from_slice(&[0x88, 0xac]);
                s
            }
            2 => {
                let mut s = vec![0x00, 0x6a];
                let len = rng.below(40) as usize;
                s.extend_from_slice(&rng.bytes(len));
                s
            }
            _ => {
                let len = rng.below(120) as usize;
                rng.bytes(len)
            }
        };
        var_int(&mut tx, script.len() as u64);
        tx.extend_from_slice(&script);
    }
    let locktime = [0u32, 499_999_999, 500_000_000, 0xffff_ffff][rng.below(4) as usize];
    tx.extend_from_slice(&locktime.to_le_bytes());

    let mut meta = Vec::new();
    for i in 0..n_in {
        meta.extend_from_slice(&(i as u32).to_le_bytes());
        // valid nonzero < n scalar with overwhelming probability; identical
        // bytes feed both crates, so even an invalid one must err identically.
        meta.extend_from_slice(&rng.bytes(32));
        let sat = if rng.below(2) == 0 {
            SAT_EDGES[rng.below(5) as usize]
        } else {
            rng.below(1 << 53)
        };
        meta.extend_from_slice(&sat.to_le_bytes());
        meta.extend_from_slice(&SCOPES[rng.below(6) as usize].to_le_bytes());
        meta.push(0x76);
        meta.push(0xa9);
        meta.push(0x14);
        meta.extend_from_slice(&rng.bytes(20));
        meta.push(0x88);
        meta.push(0xac);
    }
    (tx, meta, n_in as u32)
}

#[test]
fn ffi_equals_spike_on_2000_adversarial_cases() {
    let mut rng = Rng(0x5111_2026_0721_0001);
    let mut signed = 0u64;
    for case in 0..2000u32 {
        let (tx, meta, n_in) = gen_case(&mut rng);

        let ours = engine_native::batch_sign_p2pkh_inputs(tx.clone(), meta.clone());
        let spikes = spike::batch_sign_p2pkh_inputs(tx.clone(), meta.clone());
        match (&ours, &spikes) {
            (Ok(a), Ok(b)) => {
                assert_eq!(a, b, "case {case}: framed output diverged");
                signed += u64::from(n_in);
            }
            (Err(ea), Err(eb)) => {
                assert_eq!(format!("{ea:?}"), format!("{eb:?}"), "case {case}: error diverged")
            }
            _ => panic!("case {case}: Ok/Err divergence: ours={ours:?} spike={spikes:?}"),
        }

        // sighash + preimage parity on a random input of the same tx
        let idx = rng.below(u64::from(n_in)) as u32;
        let subscript = match rng.below(3) {
            0 => Vec::new(),
            1 => meta[48..73].to_vec(),
            _ => {
                let len = rng.below(200) as usize;
                rng.bytes(len)
            }
        };
        let sat = rng.below(1 << 53);
        let scope = if rng.below(8) == 0 {
            rng.below(u32::MAX as u64) as u32 // arbitrary u32 incl. must-Err
        } else {
            SCOPES[rng.below(6) as usize]
        };
        let ours_pre = engine_native::compute_sighash_preimage_signing(
            tx.clone(), idx, subscript.clone(), sat, scope,
        );
        let spike_pre =
            spike::compute_sighash_preimage_signing(tx.clone(), idx, subscript.clone(), sat, scope);
        assert_eq!(
            ours_pre.as_deref().map_err(|e| format!("{e:?}")),
            spike_pre.as_deref().map_err(|e| format!("{e:?}")),
            "case {case}: preimage diverged"
        );
        let ours_hash = engine_native::compute_sighash_signing_order(
            tx.clone(), idx, subscript.clone(), sat, scope,
        );
        let spike_hash =
            spike::compute_sighash_signing_order(tx, idx, subscript, sat, scope);
        assert_eq!(
            ours_hash.as_deref().map_err(|e| format!("{e:?}")),
            spike_hash.as_deref().map_err(|e| format!("{e:?}")),
            "case {case}: sighash diverged"
        );
    }
    assert!(signed > 10_000, "corpus signed too few inputs: {signed}");
}

/// Must-Err families rejected IDENTICALLY (variant + payload) by both crates.
#[test]
fn ffi_equals_spike_on_must_err_probes() {
    let mut rng = Rng(0x5111_2026_0721_0002);
    for case in 0..200u32 {
        let (tx, mut meta, _) = gen_case(&mut rng);
        match case % 5 {
            0 => meta[44..48].copy_from_slice(&0x61u32.to_le_bytes()), // CHRONICLE|FORKID|ALL
            1 => meta[44..48].copy_from_slice(&0x01u32.to_le_bytes()), // no FORKID
            2 => meta[48] = 0x00,                                      // bad lock shape
            3 => meta[0..4].copy_from_slice(&0xffff_ffffu32.to_le_bytes()), // index OOR
            _ => {
                meta.pop(); // bad framing
            }
        }
        let ours = engine_native::batch_sign_p2pkh_inputs(tx.clone(), meta.clone());
        let spikes = spike::batch_sign_p2pkh_inputs(tx, meta);
        assert!(ours.is_err(), "case {case}: probe unexpectedly signed");
        assert_eq!(
            ours.map_err(|e| format!("{e:?}")),
            spikes.map_err(|e| format!("{e:?}")),
            "case {case}: must-Err divergence"
        );
    }
}
