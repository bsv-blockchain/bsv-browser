#!/usr/bin/env bash
# Syncs the built Rust artifacts from native-engine-ffi into this package:
#   - EngineNative.xcframework    (gitignored binary; rebuild via
#     native-engine-ffi/scripts/build-engine-xcframework.sh if absent there too)
#   - UniFFI Swift bindings       (ios/uniffi/EngineNative.swift)
# Mirrors react-native-secp-native/scripts/sync-xcframework.sh, including the
# no-header-copy rule: the pod resolves `import engine_nativeFFI` from the
# xcframework's own Headers/ (a second copy would redefine the module).
set -euo pipefail

PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FFI="$PKG_DIR/../../native-engine-ffi/packages/EngineNativeFFI"

if [ ! -d "$FFI/EngineNative.xcframework" ]; then
  echo "error: $FFI/EngineNative.xcframework not found." >&2
  echo "Build it first: (cd native-engine-ffi && scripts/build-engine-xcframework.sh)" >&2
  exit 1
fi

rm -rf "$PKG_DIR/ios/EngineNative.xcframework"
cp -R "$FFI/EngineNative.xcframework" "$PKG_DIR/ios/EngineNative.xcframework"

mkdir -p "$PKG_DIR/ios/uniffi"
cp "$FFI/Sources/EngineNative/EngineNative.swift" "$PKG_DIR/ios/uniffi/EngineNative.swift"

echo "Synced EngineNative.xcframework + UniFFI bindings into $PKG_DIR/ios"
