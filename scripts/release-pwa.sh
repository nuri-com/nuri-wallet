#!/usr/bin/env bash
# Tag a pure PWA (web-only) deployment and create a GitHub Release, so every
# deploy is identifiable in Releases and never confused with a native `v*` store
# release. Run after `wrangler deploy` (see cloudflare/README.md).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

dep="${1:-cloudflare/assets/deployment.json}"
[[ -f "$dep" ]] || { echo "missing $dep — build + deploy first (cloudflare/README.md)" >&2; exit 1; }

source_sha="$(node -p "require('./$dep').source_sha")"
asset="$(node -p "require('./$dep').asset")"
deployed_at="$(node -p "require('./$dep').deployed_at")"

git cat-file -e "$source_sha^{commit}" 2>/dev/null || {
  echo "source_sha $source_sha is not a commit in this checkout — is $dep from this tree?" >&2
  exit 1
}

tag="pwa-$(date -u +%Y%m%d-%H%M%S)"
git rev-parse -q --verify "refs/tags/$tag" >/dev/null 2>&1 && {
  echo "tag $tag already exists — nothing to do" >&2
  exit 0
}
command -v gh >/dev/null 2>&1 || { echo "gh CLI is required to create the release" >&2; exit 1; }

gh release create "$tag" \
  --latest=false \
  --target "$source_sha" \
  --title "PWA deployment $deployed_at" \
  --notes "Pure PWA (web-only) deployment — no native/store change.

- source: \`$source_sha\`
- asset: \`$asset\`
- deployed at: \`$deployed_at\`"
