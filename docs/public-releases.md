# Public releases and private development

## Current state

This repository is a manually prepared source snapshot with a fresh history.
It is not automatically synchronized with the private development repository.
There is no completed source-to-build-to-production verification chain yet.
Imported deployment recipes do not implement this proposed publication process.

A public release should contain the real application, not a reduced showcase.
Backend publication gaps, configuration differences and any omitted inputs must
be stated rather than hidden behind a claim that the application is fully open.

## Release contract

1. Select a tested private development commit. Export its full application and
   build inputs without private history, secrets, support data or coordination logs.
   Review the export diff; do not substitute a separate demonstration application.
2. Commit the reviewed snapshot here. Record the private commit and public commit
   separately. Rewriting history changes commit identities; never treat them as
   the same SHA. Keep signing/recovery behavior and safety guards intact.
3. Build the public commit with pinned toolchain, lockfile and documented public
   configuration. Run two clean builds and compare the application artifacts.
   Specify how variable deployment metadata is handled; do not quietly exclude it.
4. Publish the complete source/build evidence, downloadable artifacts, per-file
   hashes and authenticated provenance. Include every executable chunk, HTML,
   styles, service worker and asset. Identify Worker/configuration separately.
5. Deploy those same published artifacts without a private rebuild. Compare the
   served files using an independently obtained manifest and verifier. Record the
   deployment's Worker version and any response transformations.

A future release gate must enforce this contract. A periodic copy after deployment
is insufficient: it can lag, contain different changes, or never be published.
Neither a commit SHA nor a single-bundle hash proves the complete contract.

## Changes, hotfixes and rollback

A hotfix needs its own source commit and matching artifacts. Do not silently
replace release files under an old identity. A rollback should select an already
published source/artifact pair and record the change, rather than rebuilding old
source using whatever dependencies or toolchain happen to be current.

The private pipeline currently uses ancestry guards. A fresh public history cannot
be dropped into those checks as though its commits shared ancestry. Integration
needs an explicit, reviewed identity mapping and rollback transition. Those guards
must not be weakened merely to make a new repository deploy successfully.

## What can be checked now

The [integrity CLI](../scripts/web-integrity.mjs) creates per-file manifests and
checks local directories or HTTPS responses. The [verification guide](transparency.md#file-integrity-cli)
describes its assumptions and limitations. Its source SHA is a producer-supplied
label, not an attestation. No production release manifest is supplied by this initial
snapshot, and no independent two-build reproducibility result is claimed.

Before public launch, complete the [publication gates](open-source-readiness.md).
Before operating production, separately approve the deployment and verify its
actual target. Creating or making this repository public must never trigger a
production deployment or OTA release.
