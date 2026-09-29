# Nuri Web — verify what app.nuri.com serves

This is a **web release snapshot**, not the development repository.

- `web/` — the exact deployed HTML, JavaScript chunks, service worker and assets.
- `source/` — the web bundle's source and build inputs. No native apps, plans or internal tooling.
- `release.json` — SHA-256 and byte length for every release file.
- `verify.mjs` — an independent, dependency-free Node.js checker.

## Check the live app

Use Node.js 22. Clone this repository from a trusted revision, then run:

```sh
node verify.mjs
```

It checks the local snapshot, then compares **all 288 files** with fresh responses
from `https://app.nuri.com`. HTML is checked at `/`; Cloudflare redirects `/index.html`
there. Changed, missing or oversized responses fail the check. Redirects are not followed.
For an offline check only, run `node verify.mjs local`.

**SHA-256 of this release manifest:**

```text
3f5615fd3fcc3b48edef6ed515ac65d820e85f762825c7c6f2c6bbc23b023f00
```

This fingerprint identifies the complete file inventory, not just the main bundle.
The reference comes from this repository, not a manifest downloaded from the app
being checked. A modified reference is not trustworthy merely because its own hashes match.

## Rebuild and compare

```sh
cd source
npm ci --legacy-peer-deps
npm run build
cd ..
node verify.mjs rebuild
```

The reduced web source was selected from Metro's emitted module graph. Its build
reproduced **all 287 application files byte for byte**. The 288th file,
`deployment.json`, is separately recorded deployment metadata, not Expo build output;
it is still checked in the local and live modes. The original lockfile and package
patches are retained. The evaluated web configuration is in `source/app.json`.
The rebuild passed in two separate clean directories with Node 22.22.3 / npm 10.9.4;
production CI used Node 22.23.2 / npm 10.9.8.

Snapshot: **0.100.0**, deployment `pwa-746be77ad6c0`, source
`746be77ad6c0b4599835262a3c36a48779b0e7c2`. The source commit is the original deployment
identity, not this repository's Git commit. The complete live comparison passed on
**2026-09-29**. A later deployment needs a new snapshot; synchronization is not automatic.

## What this proves — and what it does not

A match proves that the responses fetched by this checker match the recorded release.
It does not inspect an already-open browser tab, prove that everyone receives the
same responses, verify backends/edge code or establish that the application is safe.
Unknown server routes and external services are outside this file inventory.

**Existing wallet risk:** the web implementation stores private keys in localStorage
as base64url, not encryption (`source/lib/secureKeyStorage.web.ts`). Same-origin
JavaScript can read them. Bitcoin cosigning is not blanket protection for EVM or
other keys. The client depends on Nuri's cosigner, swap/banking services, RPCs and
other providers; those backends are not included or independently verified here.
Client API keys ship in the browser bundle; their provider restrictions have not
been independently verified. Do not use a funded wallet to inspect the code.

Source license: [MIT](LICENSE). Fonts (Harriet and Sharp Grotesk) and dependencies
retain their own terms. Required redistribution notices still need review before
public publication. This preparation remains private; the superseded initial import
also remains in Git history and must be removed before making the repository public.

Checker regression tests: `node --test verify.test.mjs`.
