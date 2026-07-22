#!/usr/bin/env bash
# Build the secp-native Rust crate into SecpNative.xcframework + UniFFI Swift bindings,
# packaged as a local SPM package (SecpNativeFFI).
#
# ADAPTED from a prior proven --library-mode build script (the
# xcframework flow). Differences:
#   • Crate = the STANDALONE native-secp-poc crate (its own [workspace] + its own
#     Cargo.lock — bsv-browser has no Rust workspace, so there is no root lock to seed
#     from; the crate's lock is generated on first build and stands alone).
#   • Module names = Secp* (SecpNative / secp_nativeFFI) instead of Beef*.
#   • The UniFFI surface is the bytes-only secp256k1 PoC API (ecdsa_sign/verify,
#     pubkey_create, tweak-adds, ecdh_shared_point, brc42_derive_child) that will back
#     the Nitro module for @bsv/sdk native crypto in the BSV Browser app.
#
# uniffi 0.28 proc-macro mode (no UDL), bindings generated in --library mode.
#
# Usage:  scripts/build-secp-xcframework.sh [--configuration release|debug] [--out-dir <path>]
set -euo pipefail

CONFIGURATION="release"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRATE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"        # .../native-secp-poc
CARGO_MANIFEST="$CRATE_DIR/Cargo.toml"

CRATE_NAME="secp-native"
LIB_NAME="secp_native"                           # dashes -> underscores

SWIFT_MODULE="SecpNative"                        # the binaryTarget / framework module
FFI_MODULE="${LIB_NAME}FFI"                      # uniffi's C FFI module: secp_nativeFFI

OUT_DIR="$CRATE_DIR/packages/SecpNativeFFI"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --configuration) CONFIGURATION="$2"; shift 2 ;;
    --out-dir)       OUT_DIR="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -20; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"
DEVICE_TARGET="aarch64-apple-ios"
SIM_TARGET="aarch64-apple-ios-sim"
# M2 addition: the app's simulator builds compile BOTH arm64 and x86_64
# (xcodebuild -destination 'generic/platform=iOS Simulator'), so the simulator
# slice must be a FAT (arm64 + x86_64) library or the app-target link fails
# with `ld: library 'secp_native' not found` on the x86_64 half.
SIM_TARGET_X86="x86_64-apple-ios"

if [[ "$CONFIGURATION" == "release" ]]; then
  CARGO_PROFILE_FLAG="--release"; PROFILE_DIR="release"
else
  CARGO_PROFILE_FLAG=""; PROFILE_DIR="debug"
fi

echo "==> $CRATE_NAME xcframework build"
echo "    configuration : $CONFIGURATION"
echo "    crate         : $CRATE_DIR"
echo "    out dir       : $OUT_DIR"

command -v rustup >/dev/null || { echo "rustup not found" >&2; exit 1; }
command -v cargo  >/dev/null || { echo "cargo not found"  >&2; exit 1; }
command -v xcodebuild >/dev/null || { echo "xcodebuild not found" >&2; exit 1; }

echo "==> Ensuring rust targets installed"
rustup target add "$DEVICE_TARGET" "$SIM_TARGET" "$SIM_TARGET_X86" >/dev/null

CARGO_TARGET_DIR="$(cargo metadata --manifest-path "$CARGO_MANIFEST" --format-version 1 \
  | /usr/bin/python3 -c 'import sys,json;print(json.load(sys.stdin)["target_directory"])')"
echo "    cargo target  : $CARGO_TARGET_DIR"

build_target() {
  local target="$1"
  echo "==> cargo build -p $CRATE_NAME --target $target"
  cargo build --manifest-path "$CARGO_MANIFEST" -p "$CRATE_NAME" --target "$target" $CARGO_PROFILE_FLAG
}
build_target "$DEVICE_TARGET"
build_target "$SIM_TARGET"
build_target "$SIM_TARGET_X86"

DEVICE_LIB="$CARGO_TARGET_DIR/$DEVICE_TARGET/$PROFILE_DIR/lib${LIB_NAME}.a"
SIM_LIB_ARM="$CARGO_TARGET_DIR/$SIM_TARGET/$PROFILE_DIR/lib${LIB_NAME}.a"
SIM_LIB_X86="$CARGO_TARGET_DIR/$SIM_TARGET_X86/$PROFILE_DIR/lib${LIB_NAME}.a"
[[ -f "$DEVICE_LIB"  ]] || { echo "missing device staticlib: $DEVICE_LIB" >&2; exit 1; }
[[ -f "$SIM_LIB_ARM" ]] || { echo "missing sim staticlib: $SIM_LIB_ARM"   >&2; exit 1; }
[[ -f "$SIM_LIB_X86" ]] || { echo "missing sim x86_64 staticlib: $SIM_LIB_X86" >&2; exit 1; }

# --- UniFFI Swift bindings (--library mode, uniffi 0.28) ---
BUILD_TMP="$CARGO_TARGET_DIR/secp-xcframework-build"
GEN_DIR="$BUILD_TMP/generated"
rm -rf "$BUILD_TMP"; mkdir -p "$GEN_DIR"

echo "==> Building uniffi-bindgen binary"
cargo build --manifest-path "$CARGO_MANIFEST" -p "$CRATE_NAME" --bin uniffi-bindgen $CARGO_PROFILE_FLAG
BINDGEN_BIN="$CARGO_TARGET_DIR/$PROFILE_DIR/uniffi-bindgen"
[[ -x "$BINDGEN_BIN" ]] || { echo "missing uniffi-bindgen binary: $BINDGEN_BIN" >&2; exit 1; }

echo "==> Generating UniFFI Swift bindings (--library mode)"
# In --library mode uniffi-bindgen shells out to `cargo metadata` itself; invoke the built
# binary directly with CWD = the crate root (NOT via `cargo run`, which poisons the inner call).
( cd "$CRATE_DIR" && "$BINDGEN_BIN" generate --library "$DEVICE_LIB" --language swift --out-dir "$GEN_DIR" )
echo "    generated files:"; ls -1 "$GEN_DIR"

GEN_SWIFT="$GEN_DIR/${LIB_NAME}.swift"
GEN_HEADER="$GEN_DIR/${FFI_MODULE}.h"
GEN_MODULEMAP="$GEN_DIR/${FFI_MODULE}.modulemap"
[[ -f "$GEN_SWIFT"     ]] || { echo "missing generated swift: $GEN_SWIFT" >&2; exit 1; }
[[ -f "$GEN_HEADER"    ]] || { echo "missing generated header: $GEN_HEADER" >&2; exit 1; }
[[ -f "$GEN_MODULEMAP" ]] || { echo "missing generated modulemap: $GEN_MODULEMAP" >&2; exit 1; }

# M2 addition: make the UniFFI header C++-safe. The BSV Browser app consumes it
# inside an Obj-C++ module context (Nitro pods set SWIFT_OBJC_INTEROP_MODE=objcxx),
# where the unguarded C declarations get C++-mangled and fail to link against the
# Rust staticlib's C symbols ("ld: symbol(s) not found ... RustCallStatus*").
/usr/bin/python3 - "$GEN_HEADER" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p).read()
if 'extern "C"' not in s:
    anchor = '#include <stdint.h>'
    assert anchor in s, 'uniffi header layout changed — update extern C injection'
    s = s.replace(anchor, anchor + '\n\n#ifdef __cplusplus\nextern "C" {\n#endif', 1)
    s += '\n#ifdef __cplusplus\n}  // extern "C"\n#endif\n'
    open(p, 'w').write(s)
    print('    injected extern "C" guards into ' + p)
PYEOF

# --- Assemble headers dir + xcframework ---
# NEST the header + modulemap under a per-module SUBDIR ($FFI_MODULE) — the multi-xcframework
# Headers/ flattening collision fix proven in the beef/dkls pair (see build-beef-xcframework.sh).
HEADERS_DIR="$BUILD_TMP/headers"
MODULE_HEADERS_DIR="$HEADERS_DIR/$FFI_MODULE"
rm -rf "$HEADERS_DIR"; mkdir -p "$MODULE_HEADERS_DIR"
cp "$GEN_HEADER" "$MODULE_HEADERS_DIR/"
cp "$GEN_MODULEMAP" "$MODULE_HEADERS_DIR/module.modulemap"   # xcframework expects exactly module.modulemap

# FAT simulator slice (arm64 + x86_64) — see SIM_TARGET_X86 note above.
SIM_FAT_DIR="$BUILD_TMP/sim-fat"
mkdir -p "$SIM_FAT_DIR"
SIM_LIB="$SIM_FAT_DIR/lib${LIB_NAME}.a"
lipo -create "$SIM_LIB_ARM" "$SIM_LIB_X86" -output "$SIM_LIB"
lipo -info "$SIM_LIB"

XCFRAMEWORK="$OUT_DIR/SecpNative.xcframework"
echo "==> Creating xcframework: $XCFRAMEWORK"
rm -rf "$XCFRAMEWORK"; mkdir -p "$OUT_DIR"
xcodebuild -create-xcframework \
  -library "$DEVICE_LIB" -headers "$HEADERS_DIR" \
  -library "$SIM_LIB"    -headers "$HEADERS_DIR" \
  -output "$XCFRAMEWORK"
[[ -f "$XCFRAMEWORK/Info.plist" ]] || { echo "xcframework Info.plist missing" >&2; exit 1; }

# --- Lay down the SPM package ---
SOURCES_DIR="$OUT_DIR/Sources/$SWIFT_MODULE"
mkdir -p "$SOURCES_DIR"
cp "$GEN_SWIFT" "$SOURCES_DIR/${SWIFT_MODULE}.swift"

cat > "$OUT_DIR/Package.swift" <<EOF
// swift-tools-version:5.9
// Generated by scripts/build-secp-xcframework.sh — do not edit by hand.
import PackageDescription

let package = Package(
    name: "SecpNativeFFI",
    platforms: [ .iOS(.v15) ],
    products: [ .library(name: "SecpNative", targets: ["SecpNative"]) ],
    targets: [
        .binaryTarget(name: "SecpNativeFFI", path: "SecpNative.xcframework"),
        .target(name: "SecpNative", dependencies: ["SecpNativeFFI"], path: "Sources/SecpNative")
    ]
)
EOF

echo "==> Done."
echo "    xcframework : $XCFRAMEWORK"
echo "    swift       : $SOURCES_DIR/${SWIFT_MODULE}.swift"
echo "    package     : $OUT_DIR/Package.swift"
