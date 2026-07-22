#!/usr/bin/env bash
# Syncs the built Rust artifacts from native-secp-poc into this package:
#   - SecpNative.xcframework      (gitignored binary; rebuild via
#     native-secp-poc/scripts/build-secp-xcframework.sh if absent there too)
#   - UniFFI Swift bindings       (ios/uniffi/SecpNative.swift)
#   - secp_nativeFFI C header + modulemap (ios/include/secp_nativeFFI/)
set -euo pipefail

PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
POC="$PKG_DIR/../../native-secp-poc/packages/SecpNativeFFI"

if [ ! -d "$POC/SecpNative.xcframework" ]; then
  echo "error: $POC/SecpNative.xcframework not found." >&2
  echo "Build it first: (cd native-secp-poc && scripts/build-secp-xcframework.sh)" >&2
  exit 1
fi

rm -rf "$PKG_DIR/ios/SecpNative.xcframework"
cp -R "$POC/SecpNative.xcframework" "$PKG_DIR/ios/SecpNative.xcframework"

# NOTE: no header/modulemap copy here — the pod resolves `import secp_nativeFFI`
# from the xcframework's own Headers/ (a second copy would redefine the module).
mkdir -p "$PKG_DIR/ios/uniffi"
rm -rf "$PKG_DIR/ios/include"
cp "$POC/Sources/SecpNative/SecpNative.swift" "$PKG_DIR/ios/uniffi/SecpNative.swift"

echo "Synced SecpNative.xcframework + UniFFI bindings into $PKG_DIR/ios"
