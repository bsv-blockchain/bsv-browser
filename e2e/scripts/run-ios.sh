#!/usr/bin/env bash
# Build, boot a simulator (expo run:ios does both), serve the fixture, test.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
mkdir -p e2e/output

if [[ "${E2E_SKIP_BUILD:-}" != "1" ]]; then
  bash e2e/scripts/build-ios.sh
fi

if ! curl -sf "http://127.0.0.1:8787/health" >/dev/null; then
  node e2e/fixtures/server.js > e2e/output/fixture.log 2>&1 &
  echo $! > e2e/output/fixture.pid
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    curl -sf "http://127.0.0.1:8787/health" >/dev/null && break
    sleep 1
  done
fi
curl -sf "http://127.0.0.1:8787/health" >/dev/null

bash e2e/scripts/maestro.sh

if bash e2e/scripts/open-http.sh "http://127.0.0.1:8787/deeplink"; then
  maestro test --debug-output "$ROOT/e2e/output" e2e/maestro/attach
fi
