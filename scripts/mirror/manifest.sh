#!/usr/bin/env bash
set -euo pipefail

# Generate SHA256 manifests for the server-mirror trees

ROOT="server-mirror"
OUT="$ROOT/docs/manifests"
mkdir -p "$OUT"

make_manifest() {
  local sub="$1"
  local dir="$ROOT/$sub"
  local out="$OUT/${sub//\//_}.sha256"
  if [ -d "$dir" ]; then
    echo "Generating manifest for $dir -> $out"
    (cd "$dir" && find . -type f -print0 | xargs -0 shasum -a 256 | sort -k2) > "$out"
  fi
}

make_manifest www
make_manifest nginx
make_manifest system
make_manifest services
make_manifest docker

echo "Manifests written to $OUT/"

