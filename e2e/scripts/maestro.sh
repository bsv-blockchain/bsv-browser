#!/usr/bin/env bash
# Run the Maestro flows. The fixture server must already be up, and an
# e2e build of the app must already be installed on the booted device.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if ! curl -sf "http://127.0.0.1:8787/health" >/dev/null; then
  echo "Fixture server is not running. Start it with: npm run e2e:server" >&2
  exit 1
fi

if ! command -v maestro >/dev/null 2>&1; then
  echo "Maestro is not on PATH. Install: curl -Ls https://get.maestro.mobile.dev | bash" >&2
  exit 1
fi

if [[ -z "${E2E_MNEMONIC:-}" ]]; then
  E2E_MNEMONIC="$(node e2e/scripts/print-mnemonic.js)"
fi

mkdir -p e2e/output
# Do not echo E2E_MNEMONIC. Maestro may still record the typed phrase in a
# failed restore flow's log; that phrase is testnet-only and cannot broadcast.
set +e
maestro test --debug-output "$ROOT/e2e/output" -e "E2E_MNEMONIC=${E2E_MNEMONIC}" e2e/maestro/flows
code=$?
set -e
if [[ "$code" -ne 0 ]]; then
  if command -v adb >/dev/null 2>&1 && adb get-state >/dev/null 2>&1; then
    adb logcat -d -t 500 > "$ROOT/e2e/output/logcat.txt" || true
  fi
  if [[ -d "$HOME/.maestro/tests" ]]; then
    mkdir -p "$ROOT/e2e/output/maestro-tests"
    cp -R "$HOME/.maestro/tests/." "$ROOT/e2e/output/maestro-tests/" || true
  fi
  exit "$code"
fi
