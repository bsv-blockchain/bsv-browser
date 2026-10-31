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
# expo prebuild writes expo.inlineModules.watchedDirectories=[] as the last
# line and does not always terminate it. Appending the next property onto
# that line makes the value `[]org.gradle.workers.max=2`, which the Expo
# autolinking step then fails to JSON.parse.
if ! grep -q 'org.gradle.workers.max' "$GRADLE_PROPS"; then
  if [[ -n "$(tail -c 1 "$GRADLE_PROPS" || true)" ]]; then
    printf '\n' >>"$GRADLE_PROPS"
  fi
  printf 'org.gradle.workers.max=2\n' >>"$GRADLE_PROPS"
fi

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
