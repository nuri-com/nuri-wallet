# Cloudflare Worker — Nuri PWA

Serves the Expo web export and recreates the same-origin `/api/*` reverse proxy
from the app.nuri.com nginx vhost (see `docs/server-infrastructure.md`), plus the
SSRF-guarded `/api/lnurl` forwarder. Why it exists: `docs/pwa-deploy.md`
(WebAuthn RP ID = `nuri.com`, per-origin storage).

## Current state

- **Host:** `app.nuri.com` (sole production host), served by this worker.
- **Account:** `Cto@nuri.com's Account` (`f1b10562ebc61894a559e51b08e02262`),
  zone `nuri.com`.

## Deploy

Deployments run through the GitHub Action
`.github/workflows/deploy-selected-ref.yml` — dispatch it with a `branch` +
`commit_sha`; it builds the web export, deploys to Cloudflare, verifies
`app.nuri.com` serves the commit, and creates a `pwa-<timestamp>` release tag
pinned to the commit. Merging a PR does **not** deploy. Never run a local
`wrangler deploy` for production.

`cloudflare/assets/` is gitignored (build artifact); only `wrangler.jsonc` and
`src/worker.js` are versioned.

## Known caveats

- **SSRF delta:** a Worker has no DNS-pin API, so hostname → private-IP blocking
  relies on Cloudflare's platform block (on by default); literal IPs, `localhost`,
  `.local` and `.internal` are rejected in code (`src/worker.js`).
