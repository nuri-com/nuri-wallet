#!/usr/bin/env bash
set -euo pipefail

# MISSION-CRITICAL ARCHITECTURE GUARD
# app.nuri.com supports only the current Nuri Cosigner v4 path via
# arkade.nuri.com. Legacy signing, migration, sweep, dual-address balance and
# browser-confirm code belong outside this repository's app runtime.
#
# Do not weaken, rename around, or remove this guard. A previous wholesale
# restore accidentally shipped the retired signer back into the wallet.

cd "$(dirname "${BASH_SOURCE[0]}")/.."

paths=(App.tsx components config lib public screens services)
patterns='sign\.nuri\.com|/api/sign|confirm-init|TWO_FA_|STATELESS_SERVER_URL|LegacyMusig2Sweep|legacyMusig2Address'

if git grep -n -E "$patterns" -- "${paths[@]}" ':!**/*.test.ts' ':!docs/**'; then
  echo >&2
  echo "MISSION-CRITICAL: retired signer or in-app migration code detected." >&2
  echo "app.nuri.com must contain only the Nuri Cosigner v4 path." >&2
  echo "Legacy migration belongs on v1.nuri.com, never in the current app." >&2
  exit 1
fi

echo "cosigner boundary clean: v4-only app runtime"
