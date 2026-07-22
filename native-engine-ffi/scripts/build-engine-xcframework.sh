#!/usr/bin/env bash
# Build the native-engine-ffi Rust crate into EngineNative.xcframework + UniFFI Swift
# bindings, packaged as a local SPM package (EngineNativeFFI).
#
# ADAPTED from native-secp-poc/scripts/build-secp-xcframework.sh (itself from the proven
# proven --library xcframework flow). All five encoded deltas carry over (design doc §2):
#   1. no root-lock seeding — standalone [workspace] crate, its own committed Cargo.lock;
#   2. FAT simulator slice (aarch64-apple-ios-sim + x86_64-apple-ios via lipo) — the app's
#      simulator builds compile both arches;
#   3. extern-C guard injection anchored on `#include <stdint.h>` with assert (Nitro pods
#      set SWIFT_OBJC_INTEROP_MODE=objcxx; unguarded C decls get C++-mangled);
#   4. nested Headers/<FFI_MODULE>/module.modulemap (multi-xcframework collision fix —
#      MANDATORY: this app already ships SecpNative.xcframework);
#   5. direct uniffi-bindgen invocation with CWD = crate root (not `cargo run`).
# M5.1 additions: the K256 PIN GUARDS (design doc §2 guards 2+3) run BEFORE any build —
# Cargo.lock grep + `cargo tree -e normal` — and BSV-RS-PIN.md is refreshed per build.
#
# uniffi 0.28 proc-macro mode (no UDL), bindings generated in --library mode.
# Xcode: export DEVELOPER_DIR=/Applications/Xcode-26.3.app/Contents/Developer
# Std-dedup rule: rebuild BOTH xcframeworks (Secp + Engine) together after any rustc bump.
#
# Usage:  scripts/build-engine-xcframework.sh [--configuration release|debug] [--out-dir <path>]
set -euo pipefail

CONFIGURATION="release"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRATE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"        # .../native-engine-ffi
CARGO_MANIFEST="$CRATE_DIR/Cargo.toml"

CRATE_NAME="native-engine-ffi"
LIB_NAME="engine_native"                         # [lib] name (staticlib libengine_native.a)

SWIFT_MODULE="EngineNative"                      # the binaryTarget / framework module
FFI_MODULE="${LIB_NAME}FFI"                      # uniffi's C FFI module: engine_nativeFFI

OUT_DIR="$CRATE_DIR/packages/EngineNativeFFI"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --configuration) CONFIGURATION="$2"; shift 2 ;;
    --out-dir)       OUT_DIR="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -24; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"
DEVICE_TARGET="aarch64-apple-ios"
SIM_TARGET="aarch64-apple-ios-sim"
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

# ---------------------------------------------------------------------------
# K256 PIN GUARD 1 (design doc §2 guard 2): committed-Cargo.lock grep.
# FAIL if the lock knows any k256 outside 0.13.x, or any dkls-family crate.
# ---------------------------------------------------------------------------
LOCK="$CRATE_DIR/Cargo.lock"
[[ -f "$LOCK" ]] || { echo "GUARD FAIL: committed Cargo.lock missing at $LOCK" >&2; exit 1; }
echo "==> Pin guard 1/2: Cargo.lock grep"
BAD_K256="$(/usr/bin/awk '/^name = "k256"$/{getline; print}' "$LOCK" | grep -v 'version = "0\.13\.' || true)"
if [[ -n "$BAD_K256" ]]; then
  echo "GUARD FAIL: k256 outside the 0.13.x pin in Cargo.lock: $BAD_K256" >&2; exit 1
fi
if grep -nE '^name = "(dkls|sl-mpc-mate|multi-party)' "$LOCK"; then
  echo "GUARD FAIL: dkls-family crate present in Cargo.lock" >&2; exit 1
fi
echo "    lock clean: k256 pinned 0.13.x, no dkls/sl-mpc-mate/multi-party"

# ---------------------------------------------------------------------------
# K256 PIN GUARD 2 (design doc §2 guard 3): mechanical `cargo tree -e normal`.
# Exactly one `k256 v0.13.*`; zero dkls|sl-mpc-mate|multi-party matches.
# ---------------------------------------------------------------------------
echo "==> Pin guard 2/2: cargo tree -e normal"
TREE="$(cargo tree -e normal --manifest-path "$CARGO_MANIFEST" --locked)"
K256_VERSIONS="$(printf '%s\n' "$TREE" | grep -o 'k256 v[0-9][^ )]*' | sort -u)"
K256_COUNT="$(printf '%s\n' "$K256_VERSIONS" | grep -c . || true)"
if [[ "$K256_COUNT" -ne 1 ]] || ! printf '%s\n' "$K256_VERSIONS" | grep -q '^k256 v0\.13\.'; then
  echo "GUARD FAIL: normal graph must contain exactly one k256 v0.13.*; saw:" >&2
  printf '%s\n' "$K256_VERSIONS" >&2; exit 1
fi
if printf '%s\n' "$TREE" | grep -nE 'dkls|sl-mpc-mate|multi-party'; then
  echo "GUARD FAIL: dkls-family crate in the normal dependency graph" >&2; exit 1
fi
echo "    tree clean: exactly one $K256_VERSIONS, no dkls-family crates"

# ---------------------------------------------------------------------------
# BSV-RS-PIN.md — record the engine dep commit per build (design doc §2).
# ---------------------------------------------------------------------------
BSV_RS_DIR="$CRATE_DIR/../../bsv-rs"
BSV_RS_HASH="$(git -C "$BSV_RS_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
BSV_RS_DIRTY="$(git -C "$BSV_RS_DIR" status --porcelain 2>/dev/null | head -1)"
{
  echo "# BSV-RS-PIN — bsv-rs path-dep commit recorded per xcframework build"
  echo
  echo "Auto-refreshed by scripts/build-engine-xcframework.sh; commit this file"
  echo "with any build whose artifacts are recorded as evidence."
  echo
  echo "- bsv-rs commit: \`$BSV_RS_HASH\`$( [[ -n "$BSV_RS_DIRTY" ]] && echo ' (WORKING TREE DIRTY at build time)' )"
  echo "- recorded: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "- configuration: $CONFIGURATION"
} > "$CRATE_DIR/BSV-RS-PIN.md"
echo "==> BSV-RS-PIN.md refreshed (bsv-rs $BSV_RS_HASH)"

echo "==> Ensuring rust targets installed"
rustup target add "$DEVICE_TARGET" "$SIM_TARGET" "$SIM_TARGET_X86" >/dev/null

CARGO_TARGET_DIR="$(cargo metadata --manifest-path "$CARGO_MANIFEST" --format-version 1 \
  | /usr/bin/python3 -c 'import sys,json;print(json.load(sys.stdin)["target_directory"])')"
echo "    cargo target  : $CARGO_TARGET_DIR"

build_target() {
  local target="$1"
  echo "==> cargo build -p $CRATE_NAME --target $target"
  cargo build --manifest-path "$CARGO_MANIFEST" -p "$CRATE_NAME" --target "$target" --locked $CARGO_PROFILE_FLAG
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
BUILD_TMP="$CARGO_TARGET_DIR/engine-xcframework-build"
GEN_DIR="$BUILD_TMP/generated"
rm -rf "$BUILD_TMP"; mkdir -p "$GEN_DIR"

echo "==> Building uniffi-bindgen binary"
cargo build --manifest-path "$CARGO_MANIFEST" -p "$CRATE_NAME" --bin uniffi-bindgen --locked $CARGO_PROFILE_FLAG
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

# Make the UniFFI header C++-safe (M2 wall: Nitro pods are objcxx; unguarded C decls
# get C++-mangled and fail to link — "ld: symbol(s) not found ... RustCallStatus*").
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
# Headers/ flattening collision fix. MANDATORY here: SecpNative.xcframework already ships in
# the same app target (two staticlibs in one app is a proven shape).
HEADERS_DIR="$BUILD_TMP/headers"
MODULE_HEADERS_DIR="$HEADERS_DIR/$FFI_MODULE"
rm -rf "$HEADERS_DIR"; mkdir -p "$MODULE_HEADERS_DIR"
cp "$GEN_HEADER" "$MODULE_HEADERS_DIR/"
cp "$GEN_MODULEMAP" "$MODULE_HEADERS_DIR/module.modulemap"   # xcframework expects exactly module.modulemap

# FAT simulator slice (arm64 + x86_64).
SIM_FAT_DIR="$BUILD_TMP/sim-fat"
mkdir -p "$SIM_FAT_DIR"
SIM_LIB="$SIM_FAT_DIR/lib${LIB_NAME}.a"
lipo -create "$SIM_LIB_ARM" "$SIM_LIB_X86" -output "$SIM_LIB"
lipo -info "$SIM_LIB"

XCFRAMEWORK="$OUT_DIR/EngineNative.xcframework"
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
// Generated by scripts/build-engine-xcframework.sh — do not edit by hand.
import PackageDescription

let package = Package(
    name: "EngineNativeFFI",
    platforms: [ .iOS(.v15) ],
    products: [ .library(name: "EngineNative", targets: ["EngineNative"]) ],
    targets: [
        .binaryTarget(name: "EngineNativeFFI", path: "EngineNative.xcframework"),
        .target(name: "EngineNative", dependencies: ["EngineNativeFFI"], path: "Sources/EngineNative")
    ]
)
EOF

echo "==> Slice sizes (pre-link staticlibs)"
ls -lh "$DEVICE_LIB" "$SIM_LIB" | awk '{print "    " $5 "  " $9}'
du -sh "$XCFRAMEWORK" | awk '{print "    " $1 "  " $2}'

echo "==> Done."
echo "    xcframework : $XCFRAMEWORK"
echo "    swift       : $SOURCES_DIR/${SWIFT_MODULE}.swift"
echo "    package     : $OUT_DIR/Package.swift"
