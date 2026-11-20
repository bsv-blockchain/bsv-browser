#!/usr/bin/env bash
# Deliver a real http(s) URL to the installed BSV Browser.
# Android's VIEW intent is pinned to this package so the system browser
# does not race it. iOS uses simctl, which honors the app's http scheme.
set -euo pipefail

URL="${1:-http://127.0.0.1:8787/deeplink}"
PKG="org.bsvassociation.browser"

if [[ "$(uname -s)" == "Darwin" ]]; then
  xcrun simctl openurl booted "$URL"
else
  adb shell am start -a android.intent.action.VIEW -d "$URL" "$PKG"
fi
