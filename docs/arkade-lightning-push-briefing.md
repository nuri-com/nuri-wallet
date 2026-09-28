# Briefing: Arkade Lightning incoming — server push (SSE), not an SDK upgrade

**For:** the `server-arkade-v4` maintainer. **Goal:** replace the app's ~20 s
`receive/sync` polling with a server push so incoming Lightning shows instantly
and the app stops hammering the endpoint.

## TL;DR
- **This is NOT an SDK upgrade.** `server-arkade-v4` has **no swap SDK** — its only
  runtime dep is `better-sqlite3`, and it talks to Boltz over **raw REST**. There
  is nothing to bump.
- The work is **~60 additive lines**: an in-memory **SSE hub** + one new **GET
  route** + one **`publish()`** call. No new dependency.
- **Backward compatible.** The app keeps `receive/sync` polling as a fallback;
  if SSE is absent or drops, behaviour is exactly as today.

## Problem today
When someone pays a user's static Lightning address (`name@nuri.com`), the
server creates a Boltz **reverse swap** for that user and stores it. The app
**did not create that swap**, so it has no swap id to watch — it discovers the
payment only by polling `POST /api/arkade/receive/sync` every ~20 s. Result:
up-to-20 s latency on incoming Lightning, and constant polling.

## Why there is no SDK to upgrade (verified)
- `package.json` dependencies: **`better-sqlite3` only**.
- Boltz reverse-swap creation is a direct `fetch`: `ArkadeServer.js:964` →
  `${cfg.LNURL_BOLTZ_API_URL}/v2/swap/reverse`.
- Boltz status is direct REST: `ArkadeBoltzStatus.js` →
  `/v2/swap/reverse/<id>/transaction`.
- No `ws`/websocket/SSE/EventEmitter anywhere in `src/`.

So the push must be added by hand. It's small.

## Design — 3 pieces

### 1) In-memory SSE hub (new file `src/ArkadeSsePush.js`)
```js
// Map<ownerKey, Set<res>>
const channels = new Map();

export function sseSubscribe(ownerKey, res) {
  let set = channels.get(ownerKey);
  if (!set) { set = new Set(); channels.set(ownerKey, set); }
  set.add(res);
  res.on("close", () => { set.delete(res); if (!set.size) channels.delete(ownerKey); });
}

export function ssePublish(ownerKey, event) {
  const set = channels.get(ownerKey);
  if (!set || !set.size) return;
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of set) { try { res.write(line); } catch {} }
}

// call once on server start; keeps connections alive through proxies/idle
export function startSseHeartbeat() {
  return setInterval(() => {
    for (const set of channels.values())
      for (const res of set) { try { res.write(": ping\n\n"); } catch {} }
  }, 25_000);
}
```

### 2) New route `GET /api/arkade/receive/subscribe`
Add a **GET** branch in the `http.createServer` dispatch, next to the existing
receive routes (`ArkadeServer.js:5454+`):

```js
if (req.method === "GET" && rawRoutePath === "/api/arkade/receive/subscribe") {
  return handleReceiveSubscribe(req, res, cfg);
}
```

```js
async function handleReceiveSubscribe(req, res, cfg) {
  // EventSource CANNOT set Authorization headers, so the token comes as a query
  // param. Validate it the same way the POST receive routes do.
  const url = new URL(req.url, "http://localhost");
  const token = verifyToken(cfg, url.searchParams.get("token") || "");   // ArkadeTokens.js
  if (!token) { res.writeHead(401).end(); return; }
  const owner = { credId: token.cid, clientPk33: getClientSignerFromToken(token) }; // cf. ArkadeServer.js:608
  const ownerKey = ownerKeyForReceive(owner);                            // ArkadeReceive.js:141

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write("retry: 5000\n\n");
  sseSubscribe(ownerKey, res);
}
```

### 3) Emit on swap creation — ONE place
Both creation paths (`handleReceiveInvoice` app-made invoice, `ArkadeServer.js:4435`;
and `handleLnurlCallbackGet` external payer, route `ArkadeServer.js:5566`) funnel
through **`addReceiveLightningSwap` in `ArkadeLnurlStore.js`**, which already has
`credId` / `clientPk33` / `ownerKey`. Emit there, right after the DB upsert:

```js
// inside addReceiveLightningSwap, after the row is persisted:
ssePublish(ownerKey, { type: "incoming", swapId: id, status: "pending", at: Date.now() });
```

That single emit covers every incoming swap.

**Optional (nice-to-have, not required):** also `ssePublish` when the server
observes a Boltz status transition to claimable/settled. Not necessary for v1 —
once the app has the `swapId` it can watch Boltz's own WebSocket
(`wss://<boltz>/v2/ws`) to completion with code it already ships
(`subscribeToSwap`). v1 only needs the **creation** event.

## nginx (both the arkade vhost and any front proxy)
SSE is plain HTTP/1.1 — **no WebSocket upgrade**. On the `…/receive/subscribe`
location only:
```
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 3600s;
proxy_set_header Connection '';
```

## Security
- **Per-owner isolation:** `ssePublish` writes only to the matching `ownerKey`;
  no cross-owner leakage. The event carries only `swapId` + status — data the app
  already receives from `receive/sync`.
- **Token in query string** can land in access logs. Tokens are already
  short-lived; either suppress logging of the query for this route or accept it
  (read-only, owner-scoped). Do **not** widen token lifetime for this.
- Cap connections per owner if you want (e.g. drop oldest beyond N) to bound memory.

## Backward compatibility
Purely additive. `receive/sync` is unchanged and remains the fallback. If the
app never connects, or the connection drops, nothing regresses.

## Test plan
1. `curl -N "https://arkade.nuri.com/api/arkade/receive/subscribe?token=<valid>"`
   → stays open, receives `: ping` heartbeats.
2. Pay the LNURL address for that owner → an SSE
   `data: {"type":"incoming","swapId":"…"}` arrives within ~1 s.
3. Use a **different** owner's token → it does **not** receive that event.
4. No payment → no spurious events.

## App side (handled by the app team — listed for completeness)
On wallet load: `new EventSource('/api/arkade/receive/subscribe?token=…')`; on
`incoming` → run the existing receive/claim flow (and/or `subscribeToSwap` on
the Boltz WS). Keep `receive/sync` as a slow fallback (e.g. 60 s instead of 20 s).
