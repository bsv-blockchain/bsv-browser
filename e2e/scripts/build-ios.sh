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
# Xcode 26 rejects SWIFT_RETURNS_RETAINED on these constructors because the
# type is not marked SWIFT_SHARED_REFERENCE. Dropping the annotation lets the
# ExpoModulesJSI xcframework rebuild. This edits node_modules in the CI
# checkout only.
SCHEDULER_H="$ROOT/node_modules/expo-modules-jsi/apple/Sources/ExpoModulesJSI-Cxx/include/RuntimeScheduler.h"
if [[ -f "$SCHEDULER_H" ]]; then
  sed -i '' 's/SWIFT_RETURNS_RETAINED RuntimeScheduler/RuntimeScheduler/g' "$SCHEDULER_H"
fi
# Xcode 26 enables NonisolatedNonsendingByDefault, which turns the package's
# JavaScriptActor closures into `sending` errors. Leave the package in Swift 6
# mode (Swift 5 mode misparses its regex literals) and turn that feature off
# for the nested xcframework rebuild only.
BUILD_SH="$ROOT/node_modules/expo-modules-jsi/apple/scripts/build-xcframework.sh"
if [[ -f "$BUILD_SH" ]] && ! grep -q NonisolatedNonsendingByDefault "$BUILD_SH"; then
  python3 - "$BUILD_SH" <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
text = path.read_text()
needle = "    CLANG_ENABLE_CODE_COVERAGE=NO"
insert = (
    '    OTHER_SWIFT_FLAGS="-Xfrontend -disable-upcoming-feature -Xfrontend NonisolatedNonsendingByDefault"\n'
    '    SWIFT_ENABLE_EXPLICIT_MODULES=NO\n'
    '    CLANG_ENABLE_EXPLICIT_MODULES=NO\n'
)
if needle not in text:
    raise SystemExit(f"did not find coverage flag in {path}")
path.write_text(text.replace(needle, insert + needle, 1))
PY
fi
# Release binaries should stage the release precompiled slices. The default
# flavor is debug, which is what a Release xcodebuild then fails to resolve.
export EXPO_PRECOMPILED_FLAVOR=release
# Prebuild with the flag so the simulator allows loopback HTTP. This edits the
# committed ios/ project (NSAllowsLocalNetworking). Do not commit that diff.
npx expo prebuild --platform ios --no-install
(
  cd ios
  pod install
)

# `expo run:ios` shells out to xcodebuild and keeps the entire stderr buffer in
# the Node process. On Xcode 16.4 that stderr is a blank
# "Could not resolve package dependencies" plus the whole target graph, and the
# Node process is killed before the .app exists. This workspace has no remote
# Swift packages (resolution prints an empty package list), so skip that step
# and build the simulator app directly.
# Not ios/build. React Native codegen writes ios/build/generated, and using
# that directory as derived data deletes those files before they compile.
DERIVED="$ROOT/e2e/output/ios-derived"
rm -rf "$DERIVED"
xcodebuild \
  -workspace "$ROOT/ios/BSVBrowser.xcworkspace" \
  -scheme BSVBrowser \
  -configuration Release \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$DERIVED" \
  -disableAutomaticPackageResolution \
  CODE_SIGNING_ALLOWED=NO \
  build

APP="$DERIVED/Build/Products/Release-iphonesimulator/BSVBrowser.app"
if [[ ! -d "$APP" ]]; then
  echo "Release simulator app was not produced at $APP" >&2
  find "$DERIVED" -name '*.app' -type d >&2 || true
  exit 1
fi

DEVICE="${E2E_IOS_DEVICE:-}"
if [[ -z "$DEVICE" ]]; then
  DEVICE="$(
    xcrun simctl list devices available |
      grep -E 'iPhone' |
      grep -v unavailable |
      sed -E 's/^[[:space:]]*([^(]+) \(.*/\1/' |
      sed 's/[[:space:]]*$//' |
      tail -1
  )"
fi
if [[ -z "$DEVICE" ]]; then
  echo "No iPhone simulator is available." >&2
  xcrun simctl list devices available >&2
  exit 1
fi
if ! xcrun simctl list devices booted | grep -q "$DEVICE"; then
  xcrun simctl boot "$DEVICE" || true
fi
xcrun simctl bootstatus "$DEVICE" -b
xcrun simctl install booted "$APP"
echo "Installed $APP on $DEVICE"
