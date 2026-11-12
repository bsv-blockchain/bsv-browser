#!/usr/bin/env bash
# Build (unless E2E_SKIP_BUILD=1), install, reverse the fixture port, test.
# Set E2E_ANDROID_ARCH=x86_64 for an emulator-only APK.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
mkdir -p e2e/output

if [[ "${E2E_SKIP_BUILD:-}" != "1" ]]; then
  bash e2e/scripts/build-android.sh
fi

APK="$ROOT/android/app/build/outputs/apk/release/app-release.apk"
if ! adb get-state >/dev/null 2>&1; then
  echo "No Android device or emulator is connected." >&2
  echo "Start one, then re-run with E2E_SKIP_BUILD=1 if the APK is already built." >&2
  exit 1
fi

adb reverse tcp:8787 tcp:8787
adb install -r -d "$APK" || adb install -r "$APK"

if ! curl -sf "http://127.0.0.1:8787/health" >/dev/null; then
  node e2e/fixtures/server.js > e2e/output/fixture.log 2>&1 &
  echo $! > e2e/output/fixture.pid
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    curl -sf "http://127.0.0.1:8787/health" >/dev/null && break
    sleep 1
  done
fi
curl -sf "http://127.0.0.1:8787/health" >/dev/null

adb shell settings put global window_animation_scale 0 || true
adb shell settings put global transition_animation_scale 0 || true
adb shell settings put global animator_duration_scale 0 || true

bash e2e/scripts/maestro.sh

# Production http intent, after the suite, against the same installed build.
if bash e2e/scripts/open-http.sh "http://127.0.0.1:8787/deeplink"; then
  maestro test --debug-output "$ROOT/e2e/output" e2e/maestro/attach || {
    echo "Android http intent did not surface the fixture page. The in-app handler is still covered by deeplink.yaml via bsv-browser://e2e." >&2
    exit 1
  }
fi
