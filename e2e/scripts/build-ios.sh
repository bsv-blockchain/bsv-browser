#!/usr/bin/env bash
# Release simulator build. Requires the vendored Rust xcframeworks, which are
# gitignored. Builds them when the Xcode/Rust toolchain is present and they
# are missing. Does not set RCT_USE_PREBUILT_RNCORE=0: that flag is only for
# dev-client builds, and this suite uses a Release binary.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "iOS simulator builds require macOS." >&2
  exit 1
fi

ensure_framework() {
  local framework="$1"
  local build="$2"
  local sync="$3"
  if [[ -d "$framework" ]]; then
    return
  fi
  echo "Building $(basename "$framework") (this compiles Rust for the simulator and device)..."
  bash "$build"
  bash "$sync"
}

ensure_framework \
  "$ROOT/packages/react-native-secp-native/ios/SecpNative.xcframework" \
  "$ROOT/native-secp-poc/scripts/build-secp-xcframework.sh" \
  "$ROOT/packages/react-native-secp-native/scripts/sync-xcframework.sh"

ensure_framework \
  "$ROOT/packages/react-native-engine-native/ios/EngineNative.xcframework" \
  "$ROOT/native-engine-ffi/scripts/build-engine-xcframework.sh" \
  "$ROOT/packages/react-native-engine-native/scripts/sync-xcframework.sh"

export EXPO_PUBLIC_E2E=1
export CI="${CI:-1}"
# Prebuild with the flag so the simulator allows loopback HTTP. This edits the
# committed ios/ project (NSAllowsLocalNetworking). Do not commit that diff.
npx expo run:ios --configuration Release --no-bundler
