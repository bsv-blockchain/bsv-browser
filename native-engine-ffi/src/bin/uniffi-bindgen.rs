//! UniFFI binding generator entry point (host tool) — mirrors native-secp-poc /
//! prior UniFFI staticlib crates.
//!
//! `--library` mode (uniffi 0.28, no UDL): the xcframework build script
//! (scripts/build-engine-xcframework.sh) builds this binary, then invokes it
//! directly with CWD = this crate root to generate the Swift bindings from the
//! built dylib.
fn main() {
    uniffi::uniffi_bindgen_main()
}
