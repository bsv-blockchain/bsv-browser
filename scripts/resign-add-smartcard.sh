#!/usr/bin/env bash
# Re-sign the newest build-*.ipa adding the com.apple.security.smartcard
# entitlement, WITHOUT rebuilding. Since smartcard is a "free" entitlement
# (no App ID capability, no provisioning-profile authorization needed), this
# should succeed with the existing App Store distribution profile.
#
# It is also the definitive test: if codesign REJECTS the entitlement, that
# proves it is provisioned/gated and needs an Apple entitlement request.
#
# You provide the signing identity — import your distribution.p12 into the
# login keychain ONCE (Keychain Access, or:  security import distribution.p12).
# This script never sees or handles the .p12 password.
#
# Usage:
#   scripts/resign-add-smartcard.sh                 # auto-pick newest build-*.ipa
#   scripts/resign-add-smartcard.sh path/to.ipa
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IPA="${1:-$(ls -t "$ROOT"/build-*.ipa 2>/dev/null | grep -v resigned | head -1)}"
PROFILE="/Users/personal/git/apple-devlepment/BSV Browser/BSV_Browser_App_Store_Local_Build.mobileprovision"
OUT="$ROOT/build-smartcard-resigned.ipa"

[ -f "$IPA" ] || { echo "No ipa found. Pass one as an argument."; exit 1; }
[ -f "$PROFILE" ] || { echo "Profile not found: $PROFILE"; exit 1; }

# The distribution identity in your keychain (from distribution.p12).
IDENTITY="$(security find-identity -v -p codesigning | grep -i 'Apple Distribution\|iPhone Distribution' | head -1 | sed -E 's/.*\) ([0-9A-F]{40}) .*/\1/')"
[ -n "$IDENTITY" ] || { echo "No Apple Distribution identity in keychain. Import distribution.p12 first."; exit 1; }
echo "Using signing identity: $IDENTITY"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
unzip -q "$IPA" -d "$WORK"
APP="$(ls -d "$WORK"/Payload/*.app | head -1)"
echo "App: $(basename "$APP")"

# Build the entitlements to sign with: the profile's entitlements + smartcard.
security cms -D -i "$PROFILE" > "$WORK/profile.plist"
/usr/libexec/PlistBuddy -x -c 'Print :Entitlements' "$WORK/profile.plist" > "$WORK/ent.plist"
/usr/libexec/PlistBuddy -c 'Add :com.apple.security.smartcard bool true' "$WORK/ent.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c 'Set :com.apple.security.smartcard true' "$WORK/ent.plist"

# Re-sign nested frameworks/dylibs first, then the app with the entitlements.
find "$APP/Frameworks" -maxdepth 1 \( -name '*.framework' -o -name '*.dylib' \) 2>/dev/null | while read -r f; do
  codesign --force --sign "$IDENTITY" --timestamp=none "$f"
done
codesign --force --sign "$IDENTITY" --entitlements "$WORK/ent.plist" --timestamp=none "$APP"

echo "=== signed entitlements (must now include smartcard) ==="
codesign -d --entitlements :- "$APP" 2>/dev/null | grep -iE 'smartcard|web-browser|application-identifier' || true

# Repackage everything that was in the original ipa (Payload + Symbols/etc.),
# not just Payload, so the artifact is a faithful re-sign. Drop our temp files
# first so they don't end up in the archive.
rm -f "$WORK/profile.plist" "$WORK/ent.plist" "$OUT"
( cd "$WORK" && zip -qr "$OUT" . )
echo "=== wrote: $OUT ==="
echo "If smartcard appears above, upload this ipa. If codesign errored, the"
echo "entitlement is Apple-gated and needs a Developer Technical Support request."
