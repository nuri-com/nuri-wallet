# Open-source publication readiness

Status: **private preparation; not cleared for publication**.
Reviewed on 2026-09-27. The repository was private when checked. This review does
not change repository visibility, publish a release, or deploy the application.

This assessment originated in the private development review. The standalone
`nuri-com/nuri-wallet` preparation repository imports that evidence without the
private history. Its scope and omissions are recorded in [source snapshot](source-snapshot.md).
The source's browser key-storage risks are explained in [keys, data and risks](security-and-data.md).

## Release baseline: evidence, not a live-state assertion

The latest successful **Deploy PWA** run returned by GitHub during this review was
[36203609467](https://github.com/nuri-com/nuri-expo/actions/runs/36203609467).
Its [release](https://github.com/nuri-com/nuri-expo/releases/tag/pwa-20260926-001001)
identifies the same source commit. These links require repository access until an
appropriate public evidence set is published.

| Field | Recorded value |
| --- | --- |
| Source commit | `1ef9850af9b05b2e58b8bd7054e3828c3c11a1a5` |
| App version in that source | `0.99.2` |
| Release tag | `pwa-20260926-001001` |
| Deployment timestamp in release notes | `2026-09-26T00:09:45Z` |
| Main JavaScript asset | `_expo/static/js/web/index-192bcabe8edd66ceb16f7f0b730a541a.js` |
| Main asset SHA-256, from the workflow log | `33173090de64ec189a60b7d579755cd8bd0ecf747b97e5e28e7b6c8b3f7388dc` |
| Cloudflare version ID, from the workflow log | `260d9af1-7752-4830-ab2e-9536caebc1a0` |
| Logged build tools | Node `22.23.2`, npm `10.9.8`; workflow selects Wrangler `4.59.2` |
| Post-deployment verification | Workflow reported `production matches candidate on attempt 2` |
| Release asset attachments | None |

The workflow and logs were inspected through GitHub. No fresh request was made to
`app.nuri.com`, no Cloudflare account state was inspected, and no production server
was accessed for this review. A subsequent manual deployment or rollback would not
be disproved by this evidence. Do not advertise this document as a live monitor.

Preparation is based on a separate checkout of that exact commit, not the unrelated
branch present in the existing development directory. Any cleanup commit will have
a new identity. It must not be labelled as the unchanged historical deployment.

## First cleanup: remove generated output, preserve behavior

Removed from the preparation checkout:

- `.verify-export-ios/`: 52 tracked generated files, including an old Hermes bundle,
  copied assets and export metadata; **19,158,660 bytes** in total.
- `services/swapkit/.hermes-tmp.sOpjXt`: an empty tracked editor/agent temporary file.

The export's metadata identifies it as an iOS Metro build. Before the edit,
`git grep` found no tracked textual references to either scratch path outside the
files themselves. The app entrypoint, Metro configuration, package scripts and
PWA/OTA workflow inputs do not use this directory. `.gitignore` now prevents these
scratch patterns from being added again.

No application runtime source, dependency, wallet derivation, signing path,
recovery path, platform configuration or deployment workflow was changed. A
follow-up adds a standalone file-integrity CLI and its tests to `npm run check`.
The originals remain in
the baseline Git commit; deleting them from the working tree does not erase history.
No byte-identical web rebuild has been performed as part of this cleanup.

### Verification around the cleanup

Run the same focused checks before and after the edit:

```sh
npm run check:cosigner-boundary
node scripts/check-no-dynamic-imports.mjs
node --test cloudflare/test/worker.test.mjs
VITEST_LIVE=0 npm test -- services/swapkit/SwapKitV2ProductionBoundary.test.ts services/swapkit/SwapKitV2NoV1Entrypoint.test.ts lib/web/metroAsyncRequire.test.ts public/nuriServiceWorker.test.ts
```

Before and after cleanup, the two guards, 5 Worker tests and 21 focused Vitest
tests passed. After cleanup, the full `VITEST_LIVE=0 npm run check` also passed:
TypeScript checking and **1,956 tests across 229 test files** succeeded. Biome
completed successfully but reported **166 warnings**; these have not been hidden,
suppressed or fixed in this change. This is not a claim of a warning-free codebase.

The verification environment used Node `22.22.3`, npm `10.9.4`, and dependencies
installed from the lockfile with `npm ci --legacy-peer-deps --ignore-scripts`.
This is a source-level check, not the recorded production build environment.
Install hooks and native patches were not exercised by that installation.

## Publication blockers

### 1. Source and asset rights

`LICENSE` contains the MIT license for Nuri's code. It does not establish rights to
redistribute every dependency, font, illustration or partner logo.
`App.tsx` loads `assets/Harriet-v2-Display-Thin.ttf` and
`assets/SharpGroteskBold25.ttf`. The project owner confirmed in this review that
Nuri holds the licenses needed to redistribute these fonts publicly. This records
that confirmation; the underlying license agreements were not independently
reviewed. Keep the existing fonts. Add any required redistribution notices or
license texts before publication; none were found in the tracked tree. This
confirmation does not replace the review of other third-party assets or dependencies.

### 2. Secrets, personal data and Git history

A first-pass scan covered **1,143 tracked files at the baseline commit**, including
binary artifacts, using selected private-key/provider-token/JWT patterns. It found:

- A JWT-shaped value in the removed compiled iOS artifact. Its decoded payload
  contains partner/key-type and time fields. Its authorization scope and validity
  were not established; the value is not reproduced here. Classify it privately
  and revoke/rotate it if it grants access. Removing the artifact does not revoke it.
- Three Google API-key occurrences in `google-services.json`. The file has the
  Firebase client-configuration structure, not a service-account private key.
  Verify restrictions and intended public use; a pattern match is not by itself
  evidence of a leaked server credential.

`certs/certificate.pem` begins with a public certificate header, not a private-key
header. Do not delete required public configuration merely because a filename or
scanner labels it suspicious.

This scan is **not** a secrets clearance. It does not cover every token format,
personal data, Git history, other refs, issue/PR discussions, Actions logs, releases,
LFS objects or associated repositories. Review those before changing visibility.
Support/operational notes, session/prompt logs, recorded test fixtures, screenshots
and PDFs need a separate privacy pass. Preserve useful engineering explanations and
security disclosures while removing credentials or personal data, not inconvenient
facts. Never copy local `.env`, wallet stores, support dumps or untracked build
folders into a public snapshot.

### Follow-up: scan the history-free publication candidate

Gitleaks **8.30.1** was run locally against a `git archive` export of commit
`f18ccc51df8925223233c88a7851c0c2cf752c77`, without Git history, ignored files,
local wallets or `node_modules`. The downloaded scanner's archive matched its
upstream release SHA-256. The scan used built-in rules, full secret redaction,
`--ignore-gitleaks-allow`, and archive traversal to depth 3. No findings were
suppressed and no credential was tested against its provider.

The scanner reported **19 findings**, classified by inspecting their source context:

| Findings | Classification | Required action |
| --- | --- | --- |
| 1 in `config/network.ts` | Shared Alchemy client API key used as the default RPC credential | Confirm intended public use and provider restrictions/quotas. It already ships in the app; removing it changes the application, not just documentation. |
| 3 in `google-services.json` | Firebase client API-key occurrences | Confirm intended public use and API/application restrictions. These are not service-account private keys. |
| 13 in tests and recorded fixtures | Public or synthetic token-address fields, not API authentication tokens | Preserve regression coverage. Recorded transaction/wallet data still needs privacy review. |
| 1 in `SatoraHtlcRefundService.test.ts` | Public swap mapping identifier, not a private signing key | Preserve the distinction from the preimage hash; do not treat a real-world fixture as anonymized. |
| 1 in `lib/i18n/de.ts` | Translation text containing a passkey-related field name | False positive for secret detection. |

The generated report remains local and redacted; no raw credential values were
added to this document. A further location-only pass identified email, IP and SSH
metadata in operational documents and fixtures. A classifier match is not proof
that an item is personal data or a secret, nor is no match a privacy clearance.
The published tree must be reviewed; the private Git history is deliberately not
part of this candidate. Do not make the existing private repository public to
publish a history-free snapshot.

The Alchemy/Firebase settings and the personal-data assessment are still open.
The scan is useful progress, not permission to publish everything automatically.

### 3. Complete, reproducible release artifacts

The current workflow only records and checks the main JavaScript asset hash.
The source also installs a loader for dependency-generated web chunks. HTML,
additional chunks, the push service worker, other assets and the Worker itself need
an explicit release inventory. The inspected GitHub release has no build attachments.

The workflow uses `ubuntu-latest`, Node major `22`, and action version tags rather
than fully fixed build inputs. Pin the toolchain and public configuration, establish
two-clean-build equality, publish complete artifacts and provenance, and deploy the
same artifact set without a second build. Record effective edge configuration and
transformations separately.

`scripts/web-integrity.mjs` now creates full directory manifests and compares local
or received files with an independently trusted manifest. Its eight offline tests
cover changed/missing/extra local files, chunk and service-worker coverage, a
changed homepage, invalid paths, symlinks, redirects and oversized responses.
`npm run check` includes these tests. The tool has no third-party dependencies.
The full check passed with 1,956 existing tests and eight new integrity tests;
the five Worker tests also passed. Biome still reports the same 166 warnings.
The CLI additionally created and verified an inventory of all 1,093 files in the
history-free `f18ccc51` source export. This checks source-export bytes, not a web build.
It has not been run against production, wired into deployment, or supplied with a
published release manifest. Manifest authentication, two-build reproducibility and
backend/edge verification remain separate unfinished work.

### 4. Accurate documentation and backend boundaries

[The current source map](transparency.md) distinguishes browser, edge and backend
responsibilities and describes the v2 swap entrypoints. The README's old live-version
claim and v1 new-swap description have been corrected in this preparation change.
The broader codebase guide and security report still contain historical material;
their dates and claims require review rather than automatic republication as current.

List the backend repositories, their intended publication scope and API contracts.
Document the role of card/banking providers, passkey providers, RPCs and relays.
Publishing this app alone does not disclose the code executing on those systems.

## Dead-code removal is a separate, evidence-backed change

Do not classify a module as dead solely because it is absent from the web entrypoint
or an unused-export report. Check native/web resolution, native modules, config
plugins, side effects, event handlers, CLI entrypoints, tests and recovery paths.

In particular, the v2 production-boundary test retains a positive control in
`SwapKitService.ts`. Legacy files also contain helpers referenced from other modules.
Keep signing, refund and interrupted-order recovery behavior until the complete
call graph and regression checks justify a deletion. The first cleanup intentionally
removes generated files only; it does not claim that all dead application code is gone.

## Release gate

Before a public release, require all of the following:

- [ ] Resolve asset/dependency rights and review current documentation.
- [ ] Complete secrets/privacy review for the chosen publication surface; revoke
      real exposed credentials and decide whether to publish reviewed history or
      start a clean public history. This worktree still shares the private history.
- [ ] Prove the cleaned application builds and passes the full checks; review every
      runtime deletion separately. Do not weaken security guards to get a green run.
- [ ] Publish complete artifacts and verifiable provenance from a reproducible build
      of the public commit, with independent source-to-served-file verification.
- [ ] Explicitly approve publication and deployment. A fresh public history changes
      commit IDs, so adapt existing ancestry guards through a reviewed one-time
      transition, never by silently disabling them.
