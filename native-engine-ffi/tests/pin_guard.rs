//! Dual-pin guard, test half (design doc §2, guard 3, mechanical; the other
//! half is the Cargo.lock grep in scripts/build-engine-xcframework.sh): the
//! normal-dependency graph of this crate must contain EXACTLY one
//! `k256 v0.13.*` (bsv-rs internals — non-signing math only; nothing k256 ever
//! crosses the FFI), EXACTLY one `secp256k1 v0.31.1` (THE ratified sign core,
//! the same pin native-secp-poc shipped and proved), and ZERO dkls / mpc
//! crates. Runs `cargo tree -e normal` against this crate's own manifest.
//! (dev-dependencies — the spike-parity oracle — are excluded: they never
//! enter a shipped staticlib.)

use std::process::Command;

fn normal_tree() -> String {
    let manifest = concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml");
    let out = Command::new("cargo")
        .args(["tree", "-e", "normal", "--manifest-path", manifest])
        .output()
        .expect("cargo tree runs");
    assert!(out.status.success(), "cargo tree failed: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// Distinct `<crate> vX.Y.Z` version strings for a crate name in the tree.
fn distinct_versions<'a>(tree: &'a str, krate: &str) -> std::collections::HashSet<&'a str> {
    let needle = format!("{krate} v");
    tree.lines()
        .filter_map(|l| {
            let start = l.find(&needle)?;
            // Reject e.g. "libsecp256k1 v..." when looking for "secp256k1 v..."
            if start > 0 && l.as_bytes()[start - 1].is_ascii_alphanumeric() {
                return None;
            }
            l[start..].split_whitespace().nth(1)
        })
        .collect()
}

#[test]
fn k256_pin_and_no_dkls() {
    let tree = normal_tree();

    let k256 = distinct_versions(&tree, "k256");
    assert!(!k256.is_empty(), "k256 missing from the normal graph (bsv-rs should carry it)");
    assert_eq!(k256.len(), 1, "more than one k256 version in the graph: {k256:?}");
    assert!(
        k256.iter().all(|v| v.starts_with("v0.13.")),
        "k256 outside the 0.13.x pin: {k256:?}"
    );

    for banned in ["dkls", "sl-mpc-mate", "multi-party"] {
        assert!(
            !tree.contains(banned),
            "banned crate `{banned}` appears in the normal dependency graph"
        );
    }
}

#[test]
fn libsecp_sign_core_pin() {
    let tree = normal_tree();
    let secp = distinct_versions(&tree, "secp256k1");
    assert_eq!(
        secp,
        std::collections::HashSet::from(["v0.31.1"]),
        "sign core must be exactly secp256k1 v0.31.1 (the proven native-secp-poc pin): {secp:?}"
    );
}
