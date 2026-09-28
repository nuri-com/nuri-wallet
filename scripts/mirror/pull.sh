#!/usr/bin/env bash
set -euo pipefail

# Pulls a read-only snapshot of live server assets used by secure-passkey
# and the relevant nginx site configuration into server-mirror/.
#
# Usage:
#   scripts/mirror/pull.sh [user@host] [ssh_key_path]
# Example:
#   scripts/mirror/pull.sh root@116.203.208.144 ~/.ssh/hetzner_short_key

HOST="${1:-root@116.203.208.144}"
KEY="${2:-$HOME/.ssh/hetzner_short_key}"

echo "Using host: $HOST"
echo "Using key : $KEY"

mirror_static() {
  local remote_path="/var/www/nuri.com/secure-passkey/"
  local local_path="server-mirror/nuri.com/secure-passkey/"
  echo "Mirroring static: ${remote_path} -> ${local_path}"
  mkdir -p "$local_path"
  rsync -avz --delete -e "ssh -i $KEY -o ConnectTimeout=5" \
    "$HOST:$remote_path" "$local_path"
}

mirror_nginx() {
  local base="server-mirror/nginx"
  mkdir -p "$base"
  echo "Capturing nginx -T dump"
  ssh -i "$KEY" -o ConnectTimeout=5 "$HOST" "nginx -T" > "$base/nginx.conf.full" 2>&1 || true

  # Pull selected nginx directories/files that define site behavior
  for d in /etc/nginx/nginx.conf /etc/nginx/sites-available /etc/nginx/sites-enabled /etc/nginx/conf.d; do
    if ssh -i "$KEY" -o ConnectTimeout=5 "$HOST" "test -e $d"; then
      local rel
      rel=$(echo "$d" | sed 's#^/##')
      mkdir -p "$base/$(dirname "$rel")"
      echo "Mirroring nginx: $d -> $base/$(dirname "$rel")/"
      rsync -avz --delete -e "ssh -i $KEY -o ConnectTimeout=5" \
        "$HOST:$d" "$base/$(dirname "$rel")/"
    fi
  done
}

mirror_static
mirror_nginx

echo "Mirror complete under server-mirror/"

