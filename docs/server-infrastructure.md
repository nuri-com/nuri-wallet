# Server Infrastructure — PWA + backends (knowledge backup)

> Everything server-side for the PWA work. **None of this is deployed by the app build** — it lives on the boxes, so it's captured here so we don't lose it. **No secrets** in this file (seeds/keys live only in each box's `.env`). Keep this in sync when server config changes.

## Hosts
| Host | IP | SSH key | Runs |
|---|---|---|---|
| **app.nuri.com** | `116.203.208.144` | `~/.ssh/hetzner_short_key` | nginx: PWA static + same‑origin `/api/*` proxy. **This box is ours to change.** The live PWA — `pwa.nuri.com` and `pwa2.nuri.com` are older vhosts on the same box and are not deployed to. |
| **arkade.nuri.com** | `188.34.194.25` | `~/.ssh/hetzner_ubuntu_ed25519` | docker `server-arkade-v4` (cosigner, 127.0.0.1:1344) + nginx (SSE‑ready). Owned by the server dev. |
| sign.nuri.com | `46.224.61.123` | — | Retired v1 MuSig2 signer. **The app no longer calls it** — every Bitcoin signature, L1 and L2, goes to Nuri Cosigner v4 on `arkade.nuri.com`. Kept here as a record of the host; migrating a v1 wallet is a separate product on `v1.nuri.com`. See AGENTS.md and `npm run check:cosigner-boundary`. |
| arkade.computer | external | — | arknode indexer (vtxos, `script/subscribe`) |
| api.boltz.exchange | external | — | Boltz swaps (Lightning) |

## PWA host (116.203.208.144)

> **Deploy path has moved.** app.nuri.com deploys via the Cloudflare Worker
> (`cloudflare/`, GitHub Action `.github/workflows/deploy-selected-ref.yml`); the
> rsync script `scripts/deploy-app-nuri-pwa.sh` has been removed. The box config
> below remains the live host until the cutover, then gets decommissioned. See
> `docs/pwa-deploy.md`.
- **Static:** `/var/www/app.nuri.com`. **Always mainnet** — `app-sandbox.nuri.com` is the testnet host. Deploy: `APP_NETWORK=mainnet npx expo export --platform web --output-dir web-build --clear` → `rsync -az --delete web-build/ root@116.203.208.144:/var/www/app.nuri.com/`. Back the docroot up first (`cp -a /var/www/app.nuri.com /var/www/app.nuri.com.bak-$(date +%Y%m%d-%H%M%S)`) — the rsync deletes. `index.html` is `no-cache`; `/_expo/` immutable 1y (so a normal refresh picks up new builds).
- **`--clear` is not optional, and check the build before shipping it:** `grep -o '\"appNetwork\":\"[a-z]*\"' web-build/_expo/static/js/web/index-*.js` must print `mainnet`. `expo export` bakes `extra.appNetwork` into the bundle and Metro's cache key ignores it, so a cached export re-emits the previous run's network — same bundle hash — no matter what `APP_NETWORK` says on the command line. A testnet build on this host shows a zero balance, empty card activity, and calls to the sandbox Wirex host and Base Sepolia RPCs. See [`pwa-deploy.md`](./pwa-deploy.md).
- **vhost:** `/etc/nginx/sites-available/app.nuri.com`. **Cert:** certbot webroot (`/var/www/certbot`, `/.well-known/acme-challenge`).
- **The same‑origin `/api/*` proxy is the heart of the PWA** — the browser only ever talks to app.nuri.com, so no backend CORS and the backends are unmodified (native app unaffected).
- **Config deploy procedure:** backup (`cp $VA /tmp/pwa.bak-*`) → `scp` → `nginx -t` → `systemctl reload nginx`, with **auto‑revert** if the test fails. Verify other services (nuri.com, sign, 2fa) stay up after reload.

### Proxy map (browser path → backend)
| `/api` path | backend | notes |
|---|---|---|
| `/api/sign/` | sign.nuri.com | still in the live vhost; the app no longer calls it (`lib/web/apiProxy.ts` has no rewrite for it) — see the host table above |
| `/api/arkade/` | arkade.nuri.com | **SSE‑tuned** (`proxy_buffering off`, `proxy_read_timeout 3600s`) for `receive/subscribe` |
| `/api/arknode/` | arkade.computer | indexer |
| `/api/update/` | update.nuri.com | must-update version gate (no browser CORS → proxied) |
| `/api/lnurl` | *caller-supplied* | LNURL forwarder — local service, **not** a fixed backend (see below) |
| `/api/gnosis/` | gnosis.nuri.com | still in the live vhost; the app no longer calls it |
| `/api/monerium/` | api.monerium.app | still in the live vhost (with `proxy_redirect` → app.nuri.com); the app no longer calls it |
| `/api/monerium-dev/` | api.monerium.dev | as above |
| `/api/fx/` | api.frankfurter.app | dead, see below — still in the live vhost |

> **Wirex (`banking`/`wirex.nuri.com`, `nuri-wirex-mcp`), SwapKit (`swapkit.nuri.com`, `nuri-mcp-bitcoin-swapkit`) and Frankfurter (`api.frankfurter.dev`) are NOT proxied.** Those backends serve open CORS, so the browser calls them directly — `lib/web/apiProxy.ts` deliberately omits them. Only backends without browser CORS go through the same-origin proxy above.

> **FX used to be proxied at `/api/fx/` → `api.frankfurter.app`.** That host is retired and 301s to `api.frankfurter.dev/v1/…`; the browser follows the redirect off-origin, so the proxy bought nothing and CORS applied to the redirect target anyway. The app now calls `api.frankfurter.dev/v1` directly (open CORS). The `/api/fx/` location can be dropped from the vhost — it is dead, not load-bearing.

The app calls absolute backend URLs; `lib/web/apiProxy.ts` rewrites them (and EventSource via the exported `rewriteUrl`) to these `/api/*` paths. So `https://arkade.nuri.com/api/arkade/receive/sync` → `/api/arkade/api/arkade/receive/sync` — the **double `/api/arkade` prefix is expected**, not a bug.

### Canonical PWA nginx vhost (restore from here)
```nginx
server {
    listen 80;
    server_name app.nuri.com;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name app.nuri.com;

    ssl_certificate     /etc/letsencrypt/live/app.nuri.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.nuri.com/privkey.pem;

    # Wallet hardening. NB nginx add_header inheritance: a location block that
    # declares ANY add_header drops ALL of these. `try_files … /index.html`
    # internally re-serves the `location = /index.html` block, so the main
    # document loses every header below unless they are repeated there — which
    # is exactly why they must be duplicated in that location (see below).
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Strict-Transport-Security "max-age=31536000" always;
    # frame-ancestors is the header-only anti-clickjacking control (meta CSP
    # ignores it); the rest of the CSP is carried in public/index.html so it
    # ships with the bundle. Roll wss:/script-src changes out with
    # `Content-Security-Policy-Report-Only` FIRST — a missing host hard-breaks
    # the flow that needs it. (connect-src no longer lists https hosts: LNURL
    # resolves arbitrary third-party domains.)
    add_header Content-Security-Policy "frame-ancestors 'none'" always;

    # ---- Same-origin API proxy: browser -> app.nuri.com -> real backend ----
    # /api/sign/ is still in the live vhost but the app no longer routes to it:
    # signing is Nuri Cosigner v4 on arkade.nuri.com only.
    location /api/sign/ {
        proxy_pass https://sign.nuri.com/;
        proxy_set_header Host sign.nuri.com;
        proxy_ssl_server_name on; proxy_http_version 1.1;
        proxy_set_header X-Forwarded-Proto https;
    }
    location /api/arkade/ {
        proxy_pass https://arkade.nuri.com/;
        proxy_set_header Host arkade.nuri.com;
        proxy_ssl_server_name on; proxy_http_version 1.1;
        proxy_set_header X-Forwarded-Proto https;
        # SSE: receive/subscribe is a long-lived stream. Default buffering holds
        # push events and the 60s read timeout kills the connection. Stream it
        # through. Harmless for the small JSON POSTs sharing this location.
        proxy_buffering off; proxy_cache off; proxy_read_timeout 3600s;
        proxy_set_header Connection "";
    }
    location /api/arknode/ {
        proxy_pass https://arkade.computer/;
        proxy_set_header Host arkade.computer;
        proxy_ssl_server_name on; proxy_http_version 1.1;
        proxy_set_header X-Forwarded-Proto https;
    }
    # Without this location the must-update request falls through to
    # try_files → /index.html; AppUpdateService reads that HTML as "not exactly
    # true" and fails open, i.e. a restored host silently has no update gate.
    location /api/update/ {
        proxy_pass https://update.nuri.com/;
        proxy_set_header Host update.nuri.com;
        proxy_ssl_server_name on; proxy_http_version 1.1;
        proxy_set_header X-Forwarded-Proto https;
    }
    location /api/lnurl {
        limit_req zone=lnurl burst=20 nodelay;
        proxy_pass http://127.0.0.1:8795;
        proxy_http_version 1.1;
        proxy_set_header X-Forwarded-Proto https;
    }
    # Wirex, SwapKit and Frankfurter are intentionally absent — they serve open
    # CORS, so the browser calls them directly (see the proxy-map note).

    # ---- Static PWA ----
    root /var/www/app.nuri.com;
    index index.html;
    # Both locations declare add_header, so they must RE-declare the hardening
    # headers or they are served without them (the inheritance trap above).
    location /_expo/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        add_header X-Content-Type-Options "nosniff" always;
    }
    location = /index.html {
        add_header Cache-Control "no-cache";
        add_header X-Frame-Options "DENY" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        add_header Strict-Transport-Security "max-age=31536000" always;
        add_header Content-Security-Policy "frame-ancestors 'none'" always;
    }
    location / { try_files $uri $uri/ /index.html; }
}
```

### LNURL forwarder (`/api/lnurl`)

The one flow whose target host cannot be known in advance: a Lightning address
lives on any domain (`nuri@cake.cash`) and its `callback` host is whatever that
domain answers with. Letting the browser fetch those directly forces the page CSP
to `connect-src https:` — i.e. any host — which removes CSP as an exfiltration
control for a wallet that keeps keys in localStorage. So the browser calls
`/api/lnurl?url=<urlencoded https URL>` on its own origin and a local service
makes the outbound request; `lib/web/apiProxy.ts#lnurlFetchUrl` does the
rewrite (web only — native calls the target directly).

- **Service:** `/opt/lnurl-proxy/server.js`, systemd `lnurl-proxy.service`, node
  20, `127.0.0.1:8795`, runs as `www-data`. Source of truth for both files:
  `docs/server/lnurl-proxy.js` + `docs/server/lnurl-proxy.service` in this repo —
  `scp` them over and `systemctl daemon-reload && systemctl restart lnurl-proxy`.
- **Rate limit zone:** `/etc/nginx/conf.d/lnurl-limit.conf`
  (`limit_req_zone $binary_remote_addr zone=lnurl:10m rate=10r/s;`) — the
  `limit_req` in the vhost location above needs it, so both move together.
- **SSRF guard** (the endpoint takes a user-controlled URL): https only; the host
  is resolved and rejected if any answer is private/loopback/link-local/CGNAT/
  multicast; the validated IP is the one connected to (so DNS rebinding cannot
  slip past); redirects followed server-side and re-validated, max 3; 256 KB and
  10 s caps; GET only; no client headers or cookies forwarded.
- **Verify:**
  `curl 'https://app.nuri.com/api/lnurl?url=https%3A%2F%2Fcake.cash%2F.well-known%2Flnurlp%2Fnuri'`
  returns the payRequest JSON, and `url=https://127.0.0.1/` returns
  `{"status":"ERROR","reason":"blocked address"}`.

## Arkade cosigner (188.34.194.25)
- **Repo:** `github.com/nuri-com/server-arkade-v4` (source of truth). Deployed at `/opt/nuri/arkade-v4/apis/server-2fa/v4` (box also has `backups/` + `.local/live-backups/` clutter — ignore, read the repo).
- **Runs:** docker `server-arkade-v4` (image `nuri/server-arkade-v4:latest`), `127.0.0.1:1344`; nginx fronts it for TLS and is **SSE‑ready** (`proxy_read_timeout 3600` on its locations — the server dev configured this).
- **Tech:** hand‑rolled raw Node `http.createServer`; only runtime dep `better-sqlite3`; talks to Boltz via REST. **No swap SDK.**
- **DB:** `/app/data/arkade-v4.sqlite` (in container). lnurl + recovery stores.
- **Non‑secret env:** `LNURL_BASE_URL=nuri.com`, `LNURL_DOMAIN=nuri.com`, `LNURL_BOLTZ_API_URL=api.boltz.exchange` (20s), `BOARDING_ESPLORA_API_URL=mempool.space/api` (10s), `LNURL_MIN_SENDABLE_MSAT=333000`, `LNURL_INVOICE_TTL_MS=600000`, `PORT=1344`, `ALLOW_ANDROID_ORIGIN_V4=true`.
- **🔑 Secrets live only in the box `.env`:** `TOKEN_SEED_V4`, `COSIGNER_SEED_V4`, `TOKEN_KEY_V4`, `ORIGIN_V4`. Never put these in the repo.
- **WebAuthn origin allow-list:** `ORIGIN_V4` must include `https://app.nuri.com` (added). Origin is cryptographically signed into the assertion → can't spoof; new client origins are added here, server-side.

## Lightning incoming SSE push (live, end‑to‑end verified)
- **Server** (`server-arkade-v4`): `ArkadeSsePush.js` (in‑memory `Map<ownerKey, Set<res>>`); `GET /api/arkade/receive/subscribe?cred_id_b64u=&client_public_key_33_hex=`; emits via `onLightningSwapAdded` → `ssePublish(ownerKey, {type:"incoming", swap_id, status, amount_msat, at})` at swap creation (both creation paths funnel through `addReceiveLightningSwap`). `ownerKey = ownerKeyForReceive({credId, clientPk33})`. `: ping` heartbeat ~25s. Spec: `docs/arkade-lightning-push-briefing.md`.
- **Proxy:** `/api/arkade/` SSE‑tuned on **both** the pwa proxy and arkade's own nginx.
- **App:** `services/arkade/internal/receiveSsePush.ts` (web‑only EventSource), wired in `receiveAutoClaim.ts`; on `incoming` runs the same refresh as a poll tick. Poll stays as fallback. Native keeps polling.
- **Status:** server publish + delivery + keep‑alive proven (held a connection, got `incoming` events instantly). Open follow‑up: the app's EventSource drops/reconnects on the wallet‑cache recreate cycle — keep it stable.

## WebAuthn / identity
- **RP ID = `nuri.com`** (works from any subdomain incl app.nuri.com + Safari). **PRF salt = `nuri-prf-salt-v1`.** Same passkey → same wallet across PWA / Safari / native.

## Verify what's live
```bash
curl -sI https://app.nuri.com/ | grep -i last-modified
curl -s https://app.nuri.com/ | grep -oE '_expo/static/js/web/index-[a-f0-9]+\.js'  # asset hash = build identity
git rev-parse <release-tag>   # compare against the tag you think is deployed
```
Record the `index-<hash>.js` name next to the release tag when deploying. Known: `pwa-v0.1.0` (bb576cdd) = `index-3a4db288576868488c1281f191e0f33b.js`.

## Manual smoke checklist (browser, after every deploy)
1. Load https://app.nuri.com — no console errors, login screen renders.
2. Create account (new passkey) → wallet appears.
3. Logout → login again with the existing passkey.
4. Reload the tab → wallet state survives.
5. Receive: create lightning invoice, pay it → funds appear (SSE push or poll fallback).
6. Send → pending clears after confirmation.
7. Installed iPhone PWA: repeat 1 + 3.

Rollback: the deploy procedure backs up `/var/www/app.nuri.com` first — `rsync` the backup dir back and the previous build is live again (index.html is `no-cache`).

## Cleanup state
- Temp debug logging (`arkade-timing.log`) — **removed from prod 2026‑06‑26**. If you add diagnostic `access_log`/`conf.d/zz-*.conf` again, remember to remove them.
