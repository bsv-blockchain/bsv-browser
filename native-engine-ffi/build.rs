//! Stamps the bsv-rs path-dep commit into the build so `engine_version()` can
//! report it (design doc §3: probe + proof-artifact stamping; BSV-RS-PIN.md is
//! the committed record, refreshed by scripts/build-engine-xcframework.sh).
//! NO guard logic lives here — the dual k256 pin guards are the build script's
//! Cargo.lock grep and tests/pin_guard.rs (`cargo tree`), per design doc §2.

use std::process::Command;

fn main() {
    let hash = Command::new("git")
        .args(["-C", "../../bsv-rs", "rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=BSV_RS_COMMIT={hash}");
    // Re-stamp whenever the engine dep's HEAD moves (best effort — a stale
    // stamp is caught by the build script's BSV-RS-PIN.md refresh).
    println!("cargo:rerun-if-changed=../../bsv-rs/.git/HEAD");
}
