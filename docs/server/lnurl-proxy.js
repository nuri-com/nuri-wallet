/**
 * LNURL forwarder for the PWA (app.nuri.com).
 *
 * The wallet resolves Lightning addresses at arbitrary third-party domains
 * (`https://<domain>/.well-known/lnurlp/<name>`) and then calls the `callback`
 * URL that host returns. Letting the browser do that directly forces the page
 * CSP to allow `connect-src https:` — i.e. any host — which removes CSP as an
 * exfiltration control for a wallet that keeps keys in localStorage. nginx
 * proxies /api/lnurl here instead, so the browser only ever talks to its own
 * origin and the CSP can keep an explicit host allow-list.
 *
 * Because the target URL is caller-supplied this is an SSRF surface: only https,
 * only public IPs (re-checked after every redirect, and the validated IP is the
 * one actually connected to, so DNS rebinding cannot slip past), GET only, no
 * client headers or cookies forwarded, capped redirects/size/time.
 */

const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns").promises;
const net = require("node:net");

const PORT = Number(process.env.PORT || 8795);
const MAX_REDIRECTS = 3;
const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 10_000;

/**
 * Expand an IPv6 literal to its 16 bytes. Textual prefix matching is not enough:
 * `fe80::/10` spans fe80–febf, and an IPv4-mapped address can be written in hex
 * (`::ffff:7f00:1` is 127.0.0.1), so only the bytes decide.
 */
function ipv6Bytes(ip) {
  // A zone id (fe80::1%eth0) only ever names a local interface — never an
  // LNURL host — so it is refused rather than stripped and evaluated.
  if (ip.includes("%")) return null;
  let text = ip.toLowerCase();
  // A trailing dotted quad (::ffff:127.0.0.1) becomes two hex groups.
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

/** Private, loopback, link-local and other non-routable space — never proxy to it. */
function isBlockedIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local (cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const bytes = ipv6Bytes(ip);
    if (!bytes) return true;
    // IPv4-mapped (::ffff:a.b.c.d, in any notation) — judge the embedded v4.
    const isMapped =
      bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
    if (isMapped) return isBlockedIp(bytes.slice(12).join("."));
    // Everything outside global unicast (2000::/3) is link-local, ULA, loopback,
    // multicast, v4-compatible or reserved — none of which an LNURL host is.
    return (bytes[0] & 0xe0) !== 0x20;
  }
  return true;
}

/** Resolve the host and return an address only if every answer is public. */
async function resolvePublicAddress(hostname) {
  // URL.hostname keeps the brackets around an IPv6 literal; without stripping
  // them the literal misses the guard here and only fails later in DNS.
  const host =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error("blocked address");
    return { address: host, family: net.isIPv6(host) ? 6 : 4 };
  }
  const answers = await dns.lookup(host, { all: true });
  if (!answers.length) throw new Error("unresolvable host");
  for (const a of answers) {
    if (isBlockedIp(a.address)) throw new Error("blocked address");
  }
  return answers[0];
}

function parseTarget(raw) {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("https only");
  if (url.username || url.password) throw new Error("credentials not allowed");
  return url;
}

/** One hop: connect to the pre-validated IP, keeping the Host/SNI of the URL. */
function fetchOnce(url, pinned) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: "https:",
        host: url.hostname,
        servername: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { accept: "application/json", host: url.host },
        // Pin the address that passed validation so the name cannot be
        // re-resolved to a private IP between check and connect.
        lookup: (_h, opts, cb) =>
          opts?.all ? cb(null, [pinned]) : cb(null, pinned.address, pinned.family),
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > MAX_BYTES) {
            res.destroy();
            reject(new Error("response too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode || 502,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("upstream timeout")));
    req.on("error", reject);
    req.end();
  });
}

/** Follow redirects server-side — the browser must never see a cross-origin hop. */
async function fetchFollowing(startUrl) {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const pinned = await resolvePublicAddress(url.hostname);
    const res = await fetchOnce(url, pinned);
    const location = res.headers.location;
    if (res.status >= 300 && res.status < 400 && location) {
      url = parseTarget(new URL(location, url).toString());
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "GET") return sendJson(res, 405, { status: "ERROR", reason: "GET only" });

  const requested = new URL(req.url, "http://localhost");
  const target = requested.searchParams.get("url");
  if (!target) return sendJson(res, 400, { status: "ERROR", reason: "missing url" });

  let url;
  try {
    url = parseTarget(target);
  } catch (err) {
    return sendJson(res, 400, { status: "ERROR", reason: String(err.message) });
  }

  try {
    const upstream = await fetchFollowing(url);
    // Pass the upstream JSON through verbatim: LNURL clients read `status`,
    // `tag`, `callback`, `pr` from it and must see exactly what the host said.
    res.writeHead(upstream.status, {
      "content-type": upstream.headers["content-type"] || "application/json",
      "content-length": upstream.body.length,
      "cache-control": "no-store",
    });
    res.end(upstream.body);
  } catch (err) {
    sendJson(res, 502, { status: "ERROR", reason: String(err.message) });
  }
});

// Only listen when started as the service; `require`ing the file (the SSRF
// regression tests do) must not open a port.
if (require.main === module) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`lnurl-proxy listening on 127.0.0.1:${PORT}`);
  });
}

module.exports = { isBlockedIp, ipv6Bytes, parseTarget };
