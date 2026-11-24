// Pure helpers that turn a failed fetch into one support-readable sentence.
//
// Support dumps used to keep only the op story ("Network infer request so
// failed."): the route, HTTP status, latency and the transport cause were lost,
// most visibly on minified builds where the stack-derived source collapses to
// `index.bundle` (#1362). Everything here is pure so it is tested directly.
//
// Redaction: only the host and the normalized path survive (no query strings or
// fragments), ids in the path are bucketed, and error text has URL queries and
// long hex/base64-ish tokens masked before it reaches a log line.

const MAX_CAUSE_DEPTH = 3;
const MAX_ERROR_TEXT_CHARS = 160;

export function parseRequestUrl(raw: string): { host: string; path: string } {
  if (!raw) return { host: "unknown", path: "/" };
  try {
    const u = new URL(raw);
    return { host: u.host || "unknown", path: u.pathname || "/" };
  } catch {
    const m = raw.match(/^(https?:)?\/\/([^/?#]+)(\/[^?#]*)?/i);
    if (m) {
      return { host: m[2] || "unknown", path: m[3] || "/" };
    }
    const m2 = raw.match(/^([^/?#]+)(\/[^?#]*)?/);
    if (m2) {
      return { host: m2[1] || "unknown", path: m2[2] || "/" };
    }
    // Same-origin relative request (web): keep the route, drop the query.
    const rel = raw.match(/^(\/[^?#]*)/);
    if (rel) return { host: "same-origin", path: rel[1] || "/" };
    return { host: "unknown", path: "/" };
  }
}

export function normalizeRequestPath(path: string): string {
  if (!path) return "/";
  let p = path.replace(/[?#].*$/, "").replace(/\/+$/, "") || "/";
  p = p.replace(/\/address\/[^/]+/g, "/address/:address");
  p = p.replace(/\/txs\/chain\/[^/]+/g, "/txs/chain/:txid");
  p = p.replace(/\/tx\/[0-9a-fA-F]{64}/g, "/tx/:txid");
  p = p.replace(/\/tx\/:txid\/(status|hex)/g, "/tx/:txid/$1");
  p = p.replace(/\/\.well-known\/lnurlp\/[^/]+/g, "/.well-known/lnurlp/:name");
  // Generic id segments: UUIDs, long hex, long digit runs and long opaque
  // tokens never belong in a support dump.
  p = p.replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, "/:id");
  p = p.replace(/\/[0-9a-fA-F]{16,}(?=\/|$)/g, "/:hex");
  p = p.replace(/\/\d{6,}(?=\/|$)/g, "/:n");
  p = p.replace(/\/[A-Za-z0-9_-]{32,}(?=\/|$)/g, "/:token");
  return p;
}

export function requestEndpoint(method: string, url: string): string {
  const { host, path } = parseRequestUrl(url);
  return `${String(method || "GET").toUpperCase()} ${host}${normalizeRequestPath(path)}`;
}

// Error text can echo the request URL (with its query) or ids. Keep the words,
// drop the identifying parts.
export function redactErrorText(raw: string): string {
  let out = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!out) return "";
  out = out.replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, "$1?…");
  out = out.replace(/\b[0-9a-fA-F]{24,}\b/g, "hex…");
  out = out.replace(/\b[A-Za-z0-9_-]{40,}\b/g, "token…");
  if (out.length > MAX_ERROR_TEXT_CHARS) {
    out = `${out.slice(0, MAX_ERROR_TEXT_CHARS - 1)}…`;
  }
  return out;
}

function describeOne(err: unknown): string {
  if (err == null) return "";
  if (typeof err !== "object") return redactErrorText(String(err));
  const e = err as { name?: unknown; message?: unknown; code?: unknown; errno?: unknown };
  const name = typeof e.name === "string" && e.name && e.name !== "Error" ? e.name : "";
  const message = typeof e.message === "string" ? redactErrorText(e.message) : "";
  const codeRaw =
    typeof e.code === "string" || typeof e.code === "number"
      ? e.code
      : typeof e.errno === "string" || typeof e.errno === "number"
        ? e.errno
        : undefined;
  const code = codeRaw !== undefined ? redactErrorText(String(codeRaw)) : "";
  let text = name && message ? `${name}: ${message}` : name || message;
  if (code && !text.includes(code)) text = text ? `${text} (code ${code})` : `code ${code}`;
  return text;
}

// "TypeError: Network request failed; cause: Error: connect ECONNREFUSED (code ECONNREFUSED)"
export function describeFetchError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  const seen = new Set<unknown>();
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current != null; depth += 1) {
    if (typeof current === "object") {
      if (seen.has(current)) break;
      seen.add(current);
    }
    const text = describeOne(current);
    if (text && parts[parts.length - 1] !== text) parts.push(text);
    current =
      typeof current === "object" && current !== null
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  if (parts.length === 0) return "unknown error";
  return parts.join("; cause: ");
}

export type FetchFailureLine = {
  method: string;
  url: string;
  durMs: number;
  source?: string;
  context?: string;
  status?: number;
  error?: unknown;
};

// One sentence per unexpected failure, readable in the support dump's "Recent
// issues" even when the source label is just `index.bundle`.
export function formatFetchFailure(f: FetchFailureLine): string {
  const endpoint = requestEndpoint(f.method, f.url);
  const outcome = typeof f.status === "number" ? `HTTP ${f.status}` : describeFetchError(f.error);
  const ms = Math.max(0, Math.round(Number.isFinite(f.durMs) ? f.durMs : 0));
  const meta = [
    ...(f.source ? [`from ${f.source}`] : []),
    ...(f.context ? [`ctx ${f.context}`] : []),
  ];
  return `Request failed — ${endpoint} — ${outcome} after ${ms}ms${
    meta.length ? ` (${meta.join(", ")})` : ""
  }`;
}
