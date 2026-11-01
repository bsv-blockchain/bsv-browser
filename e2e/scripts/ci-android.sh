#!/usr/bin/env bash
# One command for the emulator action. That action runs each line of its
# script in a separate shell, so an `export` on the previous line does not
# reach the test run and the APK is built a second time.
set -euo pipefail

export PATH="$HOME/.maestro/bin:${PATH:-}"
export E2E_SKIP_BUILD=1
bash e2e/scripts/run-android.sh
