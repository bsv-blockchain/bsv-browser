#!/usr/bin/env bash
# Release APK with the JS bundle embedded and EXPO_PUBLIC_E2E=1.
# Expo's prebuild signs release with the debug keystore, so the APK installs
# on an emulator. It is not a Play-signed artifact.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

export EXPO_PUBLIC_E2E=1
export CI="${CI:-1}"
# Release bundles and expo-constants read NODE_ENV. Gradle does not set it.
export NODE_ENV="${NODE_ENV:-production}"

npx expo prebuild --platform android --no-install

GRADLE_PROPS="$ROOT/android/gradle.properties"
grep -q 'org.gradle.workers.max' "$GRADLE_PROPS" || echo 'org.gradle.workers.max=2' >> "$GRADLE_PROPS"

cd "$ROOT/android"
ARGS=()
if [[ -n "${E2E_ANDROID_ARCH:-}" ]]; then
  ARGS+=("-PreactNativeArchitectures=${E2E_ANDROID_ARCH}")
fi
./gradlew :app:assembleRelease --no-daemon --stacktrace "${ARGS[@]}"

APK="$ROOT/android/app/build/outputs/apk/release/app-release.apk"
if [[ ! -f "$APK" ]]; then
  echo "Release APK was not produced at $APK" >&2
  exit 1
fi
echo "$APK"
