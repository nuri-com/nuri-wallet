#!/usr/bin/env bash
set -euo pipefail

# Compares local working tree vs server mirror for the secure-passkey site.
# Exits non-zero if any differences are found.

WORK="secure-passkey"
MIRROR="server-mirror/nuri.com/secure-passkey"

if [ ! -d "$MIRROR" ]; then
  echo "Mirror not found: $MIRROR"
  exit 2
fi

echo "Diff (quiet) between $WORK and $MIRROR:"
if diff -qr "$WORK" "$MIRROR" > /tmp/secure_passkey_diff.txt 2>&1; then
  echo "No differences."
else
  echo "Differences detected:" && cat /tmp/secure_passkey_diff.txt
  exit 1
fi

echo
echo "Key hashes:"
shasum -a 256 "$WORK/register.html" "$MIRROR/register.html" | sed -n '1,2p'
shasum -a 256 "$WORK/dist/register.bundle.js" "$MIRROR/dist/register.bundle.js" | sed -n '1,2p'

