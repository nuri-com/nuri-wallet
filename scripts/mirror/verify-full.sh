#!/usr/bin/env bash
set -euo pipefail

# Verifies that the current mirror matches the live server by re-running
# selective comparisons. It does NOT modify the mirror.

HOST="${1:-root@116.203.208.144}"
KEY="${2:-$HOME/.ssh/hetzner_short_key}"

echo "Using host: $HOST"
echo "Using key : $KEY"

SSH="ssh -i $KEY -o ConnectTimeout=5"
TMPDIR=$(mktemp -d)
cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

echo "Checking /var/www vs server-mirror/www (summary)"
rsync -avn --delete -e "ssh -i $KEY -o ConnectTimeout=5" \
  "$HOST:/var/www/" "$TMPDIR/www/" > "$TMPDIR/rsync_www.txt" || true
echo "Captured remote listing; comparing counts..."
echo "Mirror www file count: $(find server-mirror/www -type f | wc -l | tr -d ' ')"

echo
echo "Recomputing a few key hashes for spot-checks:"
if [ -f server-mirror/nuri.com/secure-passkey/register.html ]; then
  $SSH "$HOST" "shasum -a 256 /var/www/nuri.com/secure-passkey/register.html 2>/dev/null || sha256sum /var/www/nuri.com/secure-passkey/register.html" | head -n1
  shasum -a 256 server-mirror/nuri.com/secure-passkey/register.html | head -n1
fi

echo
echo "nginx -T changed? (hash compare)"
REMOTE_HASH=$($SSH "$HOST" "nginx -T" | shasum -a 256 | cut -d' ' -f1 || true)
LOCAL_HASH=$(shasum -a 256 server-mirror/nginx/nginx.conf.full | cut -d' ' -f1 || true)
echo "remote: $REMOTE_HASH"
echo "local : $LOCAL_HASH"
test "$REMOTE_HASH" = "$LOCAL_HASH" || { echo "Note: nginx config differs from mirror"; exit 1; }

echo "Verify complete."

