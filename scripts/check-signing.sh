#!/bin/bash
# Quick check: does provisioning profile match signing cert in keychain?

PROFILE=$(ls -t ~/Library/MobileDevice/Provisioning\ Profiles/*.mobileprovision 2>/dev/null | head -1)

if [ -z "$PROFILE" ]; then
  echo "❌ No provisioning profiles found"
  exit 1
fi

echo "Profile: $(basename "$PROFILE")"
PROFILE_NAME=$(security cms -D -i "$PROFILE" 2>/dev/null | plutil -extract Name raw -o - -- - 2>/dev/null)
echo "Name: $PROFILE_NAME"

PROFILE_CERT_SHA1=$(security cms -D -i "$PROFILE" 2>/dev/null | \
  plutil -extract DeveloperCertificates.0 raw -o - -- - 2>/dev/null | \
  base64 -d | shasum -a 1 | awk '{print toupper($1)}')
echo "Profile cert SHA1: $PROFILE_CERT_SHA1"

KEYCHAIN_CERT_SHA1=$(security find-certificate -c "Apple Distribution" -Z ~/Library/Keychains/login.keychain-db 2>/dev/null | grep "SHA-1" | awk '{print $NF}')
echo "Keychain cert SHA1: $KEYCHAIN_CERT_SHA1"

if [ "$PROFILE_CERT_SHA1" = "$KEYCHAIN_CERT_SHA1" ]; then
  echo "✅ MATCH — profile and keychain certs agree. Build should sign OK."
else
  echo "❌ MISMATCH — profile expects different cert than what's in keychain."
  echo "   Fix: create profile on Apple portal using the cert you have locally."
fi
