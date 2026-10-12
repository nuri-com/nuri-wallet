import { bech32 } from "@scure/base";
import { bytesToUtf8 } from "../../lib/crypto";
import { lnurlFetchUrl } from "../../lib/web/apiProxy";
import { log } from "../logging/LoggerService";

export type LnurlPayParams = {
  callback: string;
  minSendableMsats: number;
  maxSendableMsats: number;
  metadata: string;
  description: string | null;
  domain: string | null;
};

const LNURL_FETCH_SOURCE = "services/bitcoin/LnurlService.ts#fetchLnurlJson";

// Short-lived cache so a Lightning send does not re-resolve the (amount-independent)
// LNURL-pay params it already fetched on recipient entry. Keyed by the normalized
// recipient; a changed recipient is simply a different key, so a stale callback/range
// is never reused. A miss or expiry always resolves fresh — a send never breaks on it.
const LNURL_RESOLVE_CACHE_TTL_MS = 60_000;
const LNURL_RESOLVE_CACHE_MAX = 20;
const lnurlResolveCache = new Map<string, { params: LnurlPayParams; expiresAt: number }>();

type NuriFetchInit = RequestInit & {
  __nuriSource?: string;
};

export function normalizeLightningInput(raw: string): string {
  return String(raw || "")
    .trim()
    .replace(/^lightning:/i, "");
}

export function isLightningAddress(raw: string): boolean {
  if (!raw) return false;
  const value = raw.trim();
  if (!value || value.includes(" ")) return false;
  const parts = value.split("@");
  return parts.length === 2 && Boolean(parts[0]) && Boolean(parts[1]);
}

export function isLnurlBech32(raw: string): boolean {
  if (!raw) return false;
  return raw.toLowerCase().startsWith("lnurl1");
}

export function isLnurlUrl(raw: string): boolean {
  if (!raw) return false;
  return /^https?:\/\//i.test(raw);
}

export function isLnurlPaymentInput(raw: string): boolean {
  const normalized = normalizeLightningInput(raw);
  if (!normalized) return false;
  return isLightningAddress(normalized) || isLnurlBech32(normalized) || isLnurlUrl(normalized);
}

function decodeLnurlToUrl(lnurl: string): string {
  const decoded = bech32.decode(lnurl as `${string}1${string}`, 1500);
  return bytesToUtf8(bech32.fromWords(decoded.words));
}

function parseLnurlMetadata(metadata: string): { description: string | null } {
  try {
    const parsed = JSON.parse(metadata);
    if (!Array.isArray(parsed)) return { description: null };
    const textPlain = parsed.find((entry) => Array.isArray(entry) && entry[0] === "text/plain");
    if (textPlain && typeof textPlain[1] === "string") {
      return { description: textPlain[1].trim() || null };
    }
    const longDesc = parsed.find((entry) => Array.isArray(entry) && entry[0] === "text/long-desc");
    if (longDesc && typeof longDesc[1] === "string") {
      return { description: longDesc[1].trim() || null };
    }
  } catch {}
  return { description: null };
}

function getDomainFromUrl(url: string): string | null {
  const match = url.match(/^https?:\/\/([^/]+)/i);
  return match?.[1] ? match[1] : null;
}

// The `reason` of an LNURL error body, or null when the body is not one
// (HTML error page, empty, unreadable). Capped so a hostile host cannot
// flood the log or the support dump.
async function lnurlErrorReason(response: Response): Promise<string | null> {
  try {
    const json = (await response.json()) as { status?: unknown; reason?: unknown } | null;
    if (json?.status !== "ERROR" || typeof json.reason !== "string") return null;
    const reason = json.reason.trim();
    return reason ? reason.slice(0, 200) : null;
  } catch {
    return null;
  }
}

async function fetchLnurlJson(url: string): Promise<unknown> {
  // On web this becomes the same-origin /api/lnurl forwarder — the browser must
  // not connect to arbitrary LNURL hosts itself (see lib/web/apiProxy).
  const response = await fetch(lnurlFetchUrl(url), {
    __nuriSource: LNURL_FETCH_SOURCE,
  } as NuriFetchInit);
  if (!response.ok) {
    // LUD-06 servers answer a refused callback (amount out of bounds, ...) with
    // a non-2xx status AND a {status:"ERROR", reason} body. The reason is the
    // only thing that says why, so read it before throwing (#1393).
    const reason = await lnurlErrorReason(response);
    log(
      `🌐 ERROR API_ERR grp=Network scope=LnurlService act=fetchLnurlJson status=${response.status} host=${getDomainFromUrl(url) || "unknown"}${reason ? ` reason=${reason.replace(/\s+/g, "_")}` : ""} src=services/bitcoin/LnurlService.ts#fetchLnurlJson`,
    );
    throw new Error(
      reason ? `LNURL HTTP ${response.status}: ${reason}` : `LNURL HTTP ${response.status}`,
    );
  }
  const json = await response.json();
  if (json?.status === "ERROR") {
    const reason = String(json?.reason || "LNURL error.");
    log(
      `🌐 ERROR API_ERR grp=Network scope=LnurlService act=fetchLnurlJson status=payload_error host=${getDomainFromUrl(url) || "unknown"} reason=${reason.replace(/\s+/g, "_")} src=services/bitcoin/LnurlService.ts#fetchLnurlJson`,
    );
    throw new Error(reason);
  }
  return json;
}

export async function resolveLnurlPayRequest(raw: string): Promise<LnurlPayParams> {
  const normalized = normalizeLightningInput(raw);
  if (!normalized) {
    throw new Error("Missing payment request.");
  }

  const cached = lnurlResolveCache.get(normalized);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      return cached.params;
    }
    lnurlResolveCache.delete(normalized);
  }

  let url: string | null = null;
  if (isLightningAddress(normalized)) {
    const [name, domain] = normalized.toLowerCase().split("@");
    url = `https://${domain}/.well-known/lnurlp/${name}`;
  } else if (isLnurlBech32(normalized)) {
    url = decodeLnurlToUrl(normalized.toLowerCase());
  } else if (isLnurlUrl(normalized)) {
    url = normalized;
  }

  if (!url) {
    throw new Error("Invalid LNURL.");
  }

  const data = (await fetchLnurlJson(url)) as Record<string, unknown> | null;
  if (data?.tag !== "payRequest") {
    throw new Error("Unsupported LNURL.");
  }

  const minSendableMsats = Number(data?.minSendable);
  const maxSendableMsats = Number(data?.maxSendable);
  if (
    !Number.isFinite(minSendableMsats) ||
    !Number.isFinite(maxSendableMsats) ||
    maxSendableMsats <= 0 ||
    maxSendableMsats < minSendableMsats
  ) {
    throw new Error("Invalid LNURL amount range.");
  }

  const metadata = typeof data?.metadata === "string" ? data.metadata : "";
  const { description } = parseLnurlMetadata(metadata);
  const callback = typeof data?.callback === "string" ? data.callback : "";

  if (!callback) {
    throw new Error("Missing LNURL callback.");
  }

  const params: LnurlPayParams = {
    callback,
    minSendableMsats,
    maxSendableMsats,
    metadata,
    description,
    domain: getDomainFromUrl(url),
  };

  // Evict expired entries and cap size so the cache can't grow unbounded over a
  // long session with many distinct recipients.
  const now = Date.now();
  for (const [key, entry] of lnurlResolveCache) {
    if (entry.expiresAt <= now) lnurlResolveCache.delete(key);
  }
  if (lnurlResolveCache.size >= LNURL_RESOLVE_CACHE_MAX) {
    const oldest = lnurlResolveCache.keys().next().value;
    if (oldest !== undefined) lnurlResolveCache.delete(oldest);
  }
  lnurlResolveCache.set(normalized, {
    params,
    expiresAt: now + LNURL_RESOLVE_CACHE_TTL_MS,
  });

  return params;
}

export async function requestLnurlInvoice(callback: string, amountSats: number): Promise<string> {
  if (!callback) throw new Error("Missing LNURL callback.");
  const amountMsats = Math.round(amountSats * 1000);
  if (!Number.isFinite(amountMsats) || amountMsats <= 0) {
    throw new Error("Invalid amount.");
  }
  const separator = callback.includes("?") ? "&" : "?";
  const url = `${callback}${separator}amount=${amountMsats}`;
  const data = (await fetchLnurlJson(url)) as Record<string, unknown> | null;
  const invoice = data?.pr ? String(data.pr) : "";
  if (!invoice) {
    throw new Error("Missing LNURL invoice.");
  }
  return invoice;
}
