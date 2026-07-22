//! Dual-pin guard (design doc §2, guard 3, mechanical): the normal-dependency
//! graph of this crate must contain EXACTLY one `k256 v0.13.*` and ZERO dkls /
//! mpc crates. Runs `cargo tree -e normal` against this crate's own manifest.
//! (dev-dependencies — the libsecp cross-check oracle — are intentionally
//! excluded: they never enter a shipped staticlib.)

use std::process::Command;

#[test]
fn k256_pin_and_no_dkls() {
    let manifest = concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml");
    let out = Command::new("cargo")
        .args(["tree", "-e", "normal", "--manifest-path", manifest])
        .output()
        .expect("cargo tree runs");
    assert!(out.status.success(), "cargo tree failed: {}", String::from_utf8_lossy(&out.stderr));
    let tree = String::from_utf8_lossy(&out.stdout);

    let k256_lines: Vec<&str> = tree
        .lines()
        .filter(|l| l.contains("k256 v"))
        .collect();
    assert!(!k256_lines.is_empty(), "k256 missing from the normal graph");
    for l in &k256_lines {
        assert!(
            l.contains("k256 v0.13."),
            "k256 outside the 0.13.x pin: {l}"
        );
    }
    let distinct: std::collections::HashSet<&str> = k256_lines
        .iter()
        .map(|l| {
            let start = l.find("k256 v").unwrap();
            l[start..].split_whitespace().nth(1).unwrap()
        })
        .collect();
    assert_eq!(distinct.len(), 1, "more than one k256 version in the graph: {distinct:?}");

    for banned in ["dkls", "sl-mpc-mate", "multi-party"] {
        assert!(
            !tree.contains(banned),
            "banned crate `{banned}` appears in the normal dependency graph"
        );
    }
}
