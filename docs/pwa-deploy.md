# PWA Deploy

How the web build gets deployed. Server details (boxes, keys) live in
[`server-infrastructure.md`](./server-infrastructure.md); this file is the deploy
procedure only.

## Constraints that decide the hostname

- **The host MUST be under `nuri.com`.** The WebAuthn RP ID is `nuri.com`
  (`config/constants.ts`), and a browser only accepts an RP ID that is a
  registrable suffix of the page origin. Any `*.nuri.com` host therefore reaches
  the *same* passkey and the *same* wallet as the native app; anything else
  silently creates a different wallet.
- **Each origin is its own storage bucket.** `localStorage` is per-origin, so a
  second host is a genuinely isolated environment — the live wallet's keys,
  HTLC roots and preimage counter are untouched by it. This is why staging under
  a *path* (`app.nuri.com/v2`) is not a substitute: same origin, shared keys.

## Sole host: app.nuri.com

`app.nuri.com` is served by the Cloudflare Worker in `cloudflare/` (see
`cloudflare/README.md`). It recreates the same-origin `/api/*` reverse proxy
(arkade / arknode / update) and the SSRF-guarded `/api/lnurl` forwarder, so the
browser never issues a cross-origin request and the backends stay unmodified.

## Deploy

Deployments run through the GitHub Action **Deploy PWA**
(`.github/workflows/deploy-selected-ref.yml`). Use GitHub's native **Run workflow
from** selector to choose either `dev` or `main`. The optional `commit_sha`
field accepts an exact 40-character SHA on that selected branch; leaving it
blank deploys the selected branch's current head. It rejects every other ref,
builds the web export (`APP_NETWORK=mainnet`), and deploys to
Cloudflare, verifies `app.nuri.com` serves the commit, and creates a
`pwa-<timestamp>` release tag pinned to the commit. Ordinary deployments are
forward-only: the selected commit must contain the live release and current
`origin/dev`.

- Merging a PR does **not** deploy.
- Never run a local `wrangler deploy` for production.
- **Initial cutover only:** remove the legacy `app.nuri.com A →
  116.203.208.144` record, select `initial_cutover`, and run the action. This
  permits the intentionally unavailable legacy manifest exactly for the first
  Worker custom-domain bind; ordinary deployments retain the live-manifest
  compare-and-swap guard.
- **Rollback:** dispatch the same action for a known-good commit and set
  `rollback` to `true`. That explicit control bypasses only the two forward-only
  ancestry gates; the target must still be an exact full SHA on the chosen remote
  branch, pass all checks/build validation, and the live-manifest compare-and-swap
  plus served-byte hash verification still apply. Or, to leave the Worker
  entirely, re-point `app.nuri.com` DNS to `A → 116.203.208.144`.

`scripts/deploy-app-nuri-pwa.sh` (the old rsync path) is **removed**.

## Build correctness (still applies to the workflow's build step)

**Both flags are load-bearing.** `APP_NETWORK` picks the network
(`config/network.ts` — chain ids, EURC address, Wirex host, RPCs); unset it and
`app.config.ts` defaults to mainnet, but nothing *states* mainnet, so a stray
`testnet` in the environment wins silently. `--clear` matters more:
`expo export` bakes the evaluated `extra.appNetwork` into the bundle, and Metro's
cache keys do **not** include it — a cached export is re-emitted with the
*previous* run's network even when `APP_NETWORK` is set correctly, right down to
an identical bundle hash. The workflow greps the bundle for `appNetwork` mainnet
before deploying.

`index.html` is served `no-cache` and `/_expo/` immutable for a year, so a plain
refresh picks up a new build.

Symptoms of a testnet build reaching app.nuri.com: zero wallet balance, empty card
activity, and requests to the sandbox Wirex host and Base Sepolia RPCs.

## Verify after a deploy

- **CSP violations** in the DevTools console. `public/index.html` carries a CSP
  whose `connect-src` is an explicit allow-list of backends; a backend missing
  from it fails only that flow, and only in the browser. Walk login, send,
  card and swap once — including a Lightning address on a foreign domain, which
  goes through the host's `/api/lnurl` forwarder rather than the allow-list.
- **Passkey login** — exercises `ORIGIN_V4` and the RP ID together.

## Legacy: the nginx box

The old box (`116.203.208.144`) served app.nuri.com with nginx + a same-origin
`/api/*` proxy. Its config (vhost, certbot, LNURL forwarder) is documented in
`server-infrastructure.md` and stays the live host only until the cutover is
complete, then it is decommissioned.
