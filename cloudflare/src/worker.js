/**
 * Nuri PWA edge worker.
 *
 * Serves the Expo web export and recreates the same-origin /api/* reverse
 * proxy that nginx runs on the app.nuri.com box (docs/server-infrastructure.md
 * in the nuri-expo repo). The browser only ever talks to this one origin, so
 * CORS never applies and the backends stay unmodified.
 *
 * Deployed as a Workers Static Assets project with `run_worker_first: true`,
 * so every request lands here first; non-API paths are handed to `env.ASSETS`.
 */

// /api/<prefix>/ -> upstream origin. Stripping mirrors nginx
// `location /api/arkade/ { proxy_pass https://arkade.nuri.com/; }`: the matched
// prefix is removed and the remainder appended to the origin. The double
// "/api/arkade/api/arkade/..." the app produces is expected, not a bug.
const PROXY_ROUTES = [
  ["/api/arkade/", "https://arkade.nuri.com"], // cosigner + SSE receive/subscribe
  ["/api/arknode/", "https://arkade.computer"], // indexer
  ["/api/update/", "https://update.nuri.com"], // must-update version gate
];

// Wirex (banking.nuri.com), SwapKit (swapkit.nuri.com) and Frankfurter are
// deliberately absent: they serve open CORS and the browser calls them directly.

// ── Security headers (mirror the nginx vhost) ─────────────────────────
const SECURITY_HEADERS = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000",
  "Content-Security-Policy": "frame-ancestors 'none'",
};

function applySecurityHeaders(headers) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
}

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

// ── /api/* reverse proxy (server-to-server, no CORS) ─────────────────
async function proxyTo(request, upstreamUrl) {
  const headers = new Headers(request.headers);
  for (const h of HOP_BY_HOP) headers.delete(h);
  headers.set("host", new URL(upstreamUrl).host);
  headers.set("x-forwarded-proto", "https");

  const init = {
    method: request.method,
    headers,
    redirect: "manual", // nginx passes 3xx through; it does not follow them
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  const upstream = await fetch(upstreamUrl, init);

  const respHeaders = new Headers(upstream.headers);
  for (const h of HOP_BY_HOP) respHeaders.delete(h);
  applySecurityHeaders(respHeaders);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

// ── LNURL forwarder (SSRF guard, port of docs/server/lnurl-proxy.js) ─
const MAX_REDIRECTS = 3;
const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 10_000;

/** Expand an IPv6 literal to its 16 bytes (ported verbatim from the box). */
function ipv6Bytes(ip) {
  if (ip.includes("%")) return null;
  let text = ip.toLowerCase();
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split(".").map(Number);
    const hex = `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    text = text.slice(0, dotted.index) + hex;
  }
  const [head, tail] = text.split("::");
  const headGroups = head ? head.split(":").filter(Boolean) : [];
  const tailGroups = tail ? tail.split(":").filter(Boolean) : [];
  const zeros = 8 - headGroups.length - tailGroups.length;
  if (zeros < 0) return null;
  const groups = [
    ...headGroups,
    ...(text.includes("::") ? Array(zeros).fill("0") : []),
    ...tailGroups,
  ];
  if (groups.length !== 8) return null;
  const bytes = [];
  for (const g of groups) {
    const value = Number.parseInt(g, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null;
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
}

function isIPv4(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

/** Private, loopback, link-local and other non-routable space — never proxy to it. */
function isBlockedIp(ip) {
  if (isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local (cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (ip.includes(":")) {
    const bytes = ipv6Bytes(ip);
    if (!bytes) return true;
    const isMapped =
      bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
    if (isMapped) return isBlockedIp(bytes.slice(12).join("."));
    return (bytes[0] & 0xe0) !== 0x20;
  }
  return true;
}

/**
 * The Node forwarder resolves the hostname and pins the validated IP to close
 * the DNS-rebinding window; a Worker has no DNS/pin API. Here literal private
 * IPs and known-bad hostnames are rejected in-code, and hostname resolution is
 * left to Cloudflare's edge, which blocks private-IP egress by default (Workers
 * VPC exists specifically to opt *into* private networks).
 */
function hostnameIsBlocked(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIPv4(host) || host.includes(":")) return isBlockedIp(host);
  const h = host.toLowerCase();
  return (
    h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")
  );
}

function parseTarget(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid url");
  }
  if (url.protocol !== "https:") throw new Error("https only");
  if (url.username || url.password) throw new Error("credentials not allowed");
  return url;
}

/** Follow redirects server-side — the browser must never see a cross-origin hop. */
async function fetchFollowing(startUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let url = startUrl;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (hostnameIsBlocked(url.hostname)) throw new Error("blocked address");
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "manual",
        signal: controller.signal,
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        url = parseTarget(new URL(location, url).toString());
        continue;
      }
      return { res, finish: () => clearTimeout(timer) };
    }
    throw new Error("too many redirects");
  } catch (err) {
    clearTimeout(timer);
    throw new Error(
      err && err.name === "AbortError" ? "upstream timeout" : String((err && err.message) || err),
    );
  }
}

/** Consume an LNURL response within its byte and wall-clock limits. */
async function readLimitedJson(res) {
  const contentLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BYTES) {
    throw new Error("response too large");
  }
  if (!res.body) throw new Error("empty response");

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel("response too large");
        throw new Error("response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    throw new Error("invalid JSON response");
  }
}

function json(status, payload) {
  const body = JSON.stringify(payload);
  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("cache-control", "no-store");
  applySecurityHeaders(headers);
  return new Response(body, { status, headers });
}

async function handleLnurl(request, url, env) {
  if (request.method !== "GET") return json(405, { status: "ERROR", reason: "GET only" });
  const clientIp = request.headers.get("cf-connecting-ip");
  if (!clientIp) return json(400, { status: "ERROR", reason: "missing client address" });
  const limited = await env.LNURL_RATE_LIMIT.limit({ key: clientIp });
  if (!limited.success) {
    const response = json(429, { status: "ERROR", reason: "rate limited" });
    response.headers.set("retry-after", "10");
    return response;
  }
  const target = url.searchParams.get("url");
  if (!target) return json(400, { status: "ERROR", reason: "missing url" });

  let parsed;
  try {
    parsed = parseTarget(target);
  } catch (err) {
    return json(400, { status: "ERROR", reason: String(err.message) });
  }

  try {
    const { res, finish } = await fetchFollowing(parsed);
    try {
      const body = await readLimitedJson(res);
      const headers = new Headers();
      // Never reflect an upstream MIME type under the wallet's origin.
      headers.set("content-type", "application/json; charset=utf-8");
      headers.set("cache-control", "no-store");
      applySecurityHeaders(headers);
      return new Response(body, { status: res.status, headers });
    } finally {
      finish();
    }
  } catch (err) {
    return json(502, { status: "ERROR", reason: String(err.message) });
  }
}

// ── Static serving ───────────────────────────────────────────────────
// Workers Static Assets serves index.html at "/", and `not_found_handling:
// "single-page-application"` answers every unmatched path with that same
// index.html under a 200 — it does not redirect to "/". So the mutable entry
// point is reachable under unbounded path names and cannot be recognised by
// pathname; it is recognised by its response content type below.
async function serveStatic(request, env, url) {
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  applySecurityHeaders(headers);
  // Mutable names must never be retained across a deploy, or a client keeps a
  // shell pointing at a bundle that no longer exists: the HTML shell (under "/"
  // and under every SPA-fallback path), the deploy manifest and the push worker.
  // The HTML test comes FIRST and wins over the /_expo/ prefix — a request for a
  // bundle that is not in this deployment also lands on the SPA fallback and
  // answers 200 text/html, and marking that immutable for a year would pin a
  // client to a dead entry point permanently. Only a real asset response, which
  // is content-addressed, earns the immutable header.
  const isHtml = (headers.get("content-type") || "").toLowerCase().includes("text/html");
  if (isHtml || url.pathname === "/deployment.json" || url.pathname === "/nuri-service-worker.js") {
    headers.set("Cache-Control", "no-store, max-age=0");
  } else if (url.pathname.startsWith("/_expo/")) {
    headers.set("Cache-Control", "public, immutable, max-age=31536000");
  }
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/lnurl" || path.startsWith("/api/lnurl?")) {
      return handleLnurl(request, url, env);
    }

    for (const [prefix, upstream] of PROXY_ROUTES) {
      if (path.startsWith(prefix)) {
        // Keep the leading slash: upstream + "/<remainder>" mirrors nginx.
        // Append url.search — the query string must reach the backend (the
        // SSE subscribe auth is query-param based, and so is any ?-param call).
        return proxyTo(request, upstream + path.slice(prefix.length - 1) + url.search);
      }
    }

    // Unknown /api/* paths are a 404, not the SPA shell (dead legacy locations).
    if (path.startsWith("/api/")) {
      return json(404, { status: "ERROR", reason: "not found" });
    }

    return serveStatic(request, env, url);
  },
};
