# Nuri Web: verify what app.nuri.com serves

This repository is published automatically by every production deploy of
[app.nuri.com](https://app.nuri.com). It contains the exact files the site serves,
the source that rebuilds them byte for byte, and a checker. Nobody edits it by hand.

**This release:** `pwa-8dbb6f74d0c4`, app version `0.101.0`, deployed
`2026-09-30T23:50:01Z` from source commit `8dbb6f74d0c426492d7cfc48cea56aee99189369`.

## Three independent proofs

| Question | How it is proven | Command |
| --- | --- | --- |
| Is the live site serving exactly these files? | Every served file is downloaded and its SHA-256 compared with [`release.json`](release.json). | `node verify.mjs` |
| Does this public source produce exactly these files? | A clean build of [`source/`](source/) must reproduce every application file byte for byte. This repository's own public CI does that for every release. | `node verify.mjs rebuild` |
| Did this release really come from that CI run, and was it logged publicly? | The CI run signs `release.json` with a [GitHub artifact attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations) (Sigstore). The signature is recorded in the public [Rekor](https://search.sigstore.dev) transparency log, so a release cannot be published quietly or rewritten later. | `gh attestation verify release.json --repo nuri-com/nuri-wallet` |

The site also serves a [WAICT](https://waict.dev) integrity manifest listing the
hash of every file, in the format of
[draft-waict-integrity-v2](https://github.com/waict-wg/waict-integrity-spec/blob/draft-waict-integrity-v2/waict-integrity.md).
Browsers that implement WAICT check each file against it. WAICT is still a draft
that only Firefox Nightly prototypes, so the site sends `mode=report`: mismatches
are reported, not blocked. See [limits](#limits).

## Check the live app

Use Node.js 22. The checker uses only Node.js built-ins; nothing is installed and
no wallet, login or key is needed.

```sh
git clone https://github.com/nuri-com/nuri-wallet.git
cd nuri-wallet
node verify.mjs
```

Success prints:

```text
PASS: 288 live files match release 8dbb6f74d0c426492d7cfc48cea56aee99189369
WAICT manifest: /waict/rut5ag_L-bmhBs-xeVXsHT
Release manifest SHA-256: 4a1aa44a4cc9b9ead8aabcf54393834e76a1ac7a8c084d472ab55c7a06b7e5e4
```

The checker validates `release.json`, checks every file in `web/`, recomputes the
WAICT manifest from those files, then fetches every listed file from app.nuri.com,
compares length and SHA-256, and checks that the homepage sends a valid WAICT
policy naming the same manifest. It does not run downloaded JavaScript.

A failure is not by itself proof of an attack: a newer deploy, a network error or
a rollout still reaching Cloudflare's edge also fail. Run `git pull` and check again.
Never "fix" a failure by copying files from the site into `web/`.

## Authenticate this repository

Hashes only help if `release.json` itself is genuine. Check its attestation:

```sh
gh attestation verify release.json --repo nuri-com/nuri-wallet \
  --signer-workflow nuri-com/nuri-wallet/.github/workflows/attest.yml
```

This proves `release.json` was produced by this repository's public
[`attest.yml`](.github/workflows/attest.yml) run, which rebuilt `source/` and
matched every hash before signing. Every release tag `pwa-*` has its own
attestation, listed at
[github.com/nuri-com/nuri-wallet/attestations](https://github.com/nuri-com/nuri-wallet/attestations).

## Rebuild the application

Use a clean checkout and an environment without production credentials or local
`.env` overrides. `npm ci` runs dependency install hooks, including `patch-package`.

```sh
cd source
npm ci --legacy-peer-deps
npm run build
cd ..
node verify.mjs rebuild
```

Rebuild mode compares every file in `source/dist/` with `release.json`, rejecting
missing, extra or changed files. Two files are written at deploy time rather than by
Expo and are handled separately: `deployment.json` (deploy metadata) and
`waict/rut5ag_L-bmhBs-xeVXsHT` (the WAICT manifest). The WAICT manifest is recomputed from the
rebuilt files and must match exactly, so it is proven by the rebuild too.

## What is in this repository?

| Path | Purpose |
| --- | --- |
| [`web/`](web/) | The exact deployed files: HTML, 240 JavaScript chunks, CSS, fonts, images, service worker, metadata. 288 files, 26,870,617 bytes. |
| [`source/`](source/) | The 655 files needed to rebuild `web/`: every project file Metro emitted into the web bundles, plus lockfile, patches, build config and web-only app config. Native projects and tooling are not included. |
| [`release.json`](release.json) | Path, byte length and SHA-256 of every file in `web/`, plus the source commit. |
| [`verify.mjs`](verify.mjs), [`waict.mjs`](waict.mjs) | The checker and the WAICT manifest builder (the deploy uses the same file). |
| [`verify.test.mjs`](verify.test.mjs) | Offline tests for the checker: `node --test verify.test.mjs`. |
| [`SECURITY-REVIEW-0.100.0.md`](SECURITY-REVIEW-0.100.0.md) | The architecture and key-storage review written for release 0.100.0. |

## Which hash identifies the release?

| Identifier | Value |
| --- | --- |
| `release.json` SHA-256 (whole release) | `4a1aa44a4cc9b9ead8aabcf54393834e76a1ac7a8c084d472ab55c7a06b7e5e4` |
| Main bundle [`index-dacb08c42462eb8223cab81c4335dace.js`](web/_expo/static/js/web/index-dacb08c42462eb8223cab81c4335dace.js) | `8f2507162bb8f474518494e6129216e63f2246a0c7d895443eb072e82c67ae1a` |
| WAICT manifest `/waict/rut5ag_L-bmhBs-xeVXsHT` | `aeeb796a0fcbf9b9a106cfb17955ec1d316a18afbf08be079debed08b9751a57` |
| Source commit (private nuri-expo repository) | `8dbb6f74d0c426492d7cfc48cea56aee99189369` |

The source commit is a label from the private development repository; this
repository's Git commits are different. What ties them to the site is the rebuild
and the hashes, not the label.

## Limits

Be precise about what a PASS means.

1. **Other visitors.** Until browsers enforce WAICT, the server could still send
   different bytes to a specific visitor. The checks make that detectable by anyone
   who checks, and the public log makes every published release permanent, but they
   do not prevent it for someone who does not check.
2. **Open tabs.** The PWA's service worker can keep running earlier code after a
   deploy. A PASS applies to what is served now.
3. **Backend.** APIs, cosigner policy and providers are separate systems. This
   repository covers the code delivered to the browser.
4. **Toolchain.** The rebuild is proven in CI with Node `22.23.3` and the
   locked dependencies. Other environments may produce different bytes.
5. **Not an audit.** Matching bytes prove which code runs, not that it is secure.
