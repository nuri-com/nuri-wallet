import {
  NETWORK_STATS_LOG_INTERVAL_MS,
  NETWORK_STATS_TOP_N,
  NETWORK_LOG_SUPPRESS_WINDOW_MS,
  NETWORK_LOG_SUPPRESS_MAX,
} from "../../config/constants";
import { cleanFunc, compactPath } from "../../lib/logShared";
import { logWithId, newOp, LOG_EMOJI, type LogContext } from "../../lib/OperationLogUtils";
import { logger } from "../../lib/log";
import { reportNetworkFailure, reportNetworkSuccess } from "../app/NetworkStatusService";
import { EventBus } from "../events/AppEventBusService";

const NETWORK_STATS_GLOBAL_KEY = "__nuriNetworkLoggingInitialized";
const NETWORK_STATS_FETCH_WRAPPED_KEY = "__nuriNetworkFetchWrapped";
const NETWORK_STATS_FETCH_ORIGINAL_KEY = "__nuriNetworkFetchOriginal";
const NETWORK_SILENT_PATHS = [/\/symbolicate$/i];
const NETWORK_STACK_INTERNAL_MARKERS = [
  "services/NetworkLogger",
  "NetworkLogger",
  "wrappedFetch",
  "initializeNetworkLogging",
];

type CountMap = Map<string, number>;

type NetworkStats = {
  startedAt: number;
  windowStartedAt: number;
  windowTotal: number;
  windowFailures: number;
  byHost: CountMap;
  byEndpoint: CountMap;
  byStatus: CountMap;
  bySource: CountMap;
};

const networkStats: NetworkStats = {
  startedAt: Date.now(),
  windowStartedAt: Date.now(),
  windowTotal: 0,
  windowFailures: 0,
  byHost: new Map(),
  byEndpoint: new Map(),
  byStatus: new Map(),
  bySource: new Map(),
};

// Network lines follow the same clean format; NetworkLogger owns the 📨 identity.
const netLog = logger("services/logging/NetworkLogger.ts");

let statsInterval: ReturnType<typeof setInterval> | null = null;
const recentSuccessLogTs = new Map<string, number>();

function bump(map: CountMap, key: string, inc = 1) {
  map.set(key, (map.get(key) || 0) + inc);
}

function truncate(text: string, max = 64): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

function parseUrl(raw: string): { host: string; path: string } {
  if (!raw) return { host: "unknown", path: "/" };
  try {
    const u = new URL(raw);
    return { host: u.host || "unknown", path: u.pathname || "/" };
  } catch {
    const m = raw.match(/^(https?:)?\/\/([^/]+)(\/[^?#]*)?/i);
    if (m) {
      return { host: m[2] || "unknown", path: m[3] || "/" };
    }
    const m2 = raw.match(/^([^/]+)(\/.*)?$/);
    if (m2) {
      return { host: m2[1] || "unknown", path: m2[2] || "/" };
    }
    return { host: "unknown", path: raw || "/" };
  }
}

function normalizePath(path: string): string {
  if (!path) return "/";
  let p = path.replace(/\/+$/, "") || "/";
  p = p.replace(/\/address\/[^/]+/g, "/address/:address");
  p = p.replace(/\/txs\/chain\/[^/]+/g, "/txs/chain/:txid");
  p = p.replace(/\/tx\/[0-9a-fA-F]{64}/g, "/tx/:txid");
  p = p.replace(/\/tx\/:txid\/(status|hex)/g, "/tx/:txid/$1");
  p = p.replace(/\/api\/v1\/prices/g, "/api/v1/prices");
  p = p.replace(/\/api\/v1\/historical-price/g, "/api/v1/historical-price");
  return p;
}

function isSilentPath(path: string): boolean {
  if (!path) return false;
  return NETWORK_SILENT_PATHS.some((rx) => rx.test(path));
}

function recordRequest(method: string, url: string, source?: string) {
  const { host, path } = parseUrl(url);
  const bucket = normalizePath(path);
  const endpointKey = `${method} ${host}${bucket}`;
  networkStats.windowTotal += 1;
  bump(networkStats.byHost, host);
  bump(networkStats.byEndpoint, endpointKey);
  if (source) bump(networkStats.bySource, source);
}

function recordResponse(method: string, url: string, status: number | string) {
  const { host, path } = parseUrl(url);
  const bucket = normalizePath(path);
  const key = `${status} ${method} ${host}${bucket}`;
  bump(networkStats.byStatus, key);
}

function formatTopCompact(
  map: CountMap,
  label: string,
  total: number,
  limit = NETWORK_STATS_TOP_N,
): string {
  const entries = Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  if (entries.length === 0) {
    return `${label}=none`;
  }
  const summary = entries
    .map(([key, count]) => {
      const pct = total > 0 ? ((count / total) * 100).toFixed(1) : "0.0";
      return `${truncate(key, 44)}(${pct}%)`;
    })
    .join(",");
  return `${label}=${summary}`;
}

function resetWindow() {
  networkStats.windowStartedAt = Date.now();
  networkStats.windowTotal = 0;
  networkStats.windowFailures = 0;
  networkStats.byHost.clear();
  networkStats.byEndpoint.clear();
  networkStats.byStatus.clear();
  networkStats.bySource.clear();
}

function logNetworkSummary(reason: string) {
  const now = Date.now();
  const windowMs = Math.max(0, now - networkStats.windowStartedAt);
  if (networkStats.windowTotal === 0) {
    return;
  }
  const windowSec = Math.max(1, Math.round(windowMs / 1000));
  const perSec = networkStats.windowTotal / (windowMs / 1000);
  const perMin = perSec * 60;
  const sections = [
    `w=${windowSec}s`,
    `n=${networkStats.windowTotal}`,
    `r=${perSec.toFixed(2)}/s(${perMin.toFixed(1)}/m)`,
    `why=${reason}`,
    formatTopCompact(networkStats.byHost, "h", networkStats.windowTotal),
    formatTopCompact(networkStats.byEndpoint, "ep", networkStats.windowTotal),
    formatTopCompact(networkStats.byStatus, "st", networkStats.windowTotal),
  ];
  if (networkStats.bySource.size > 0) {
    sections.push(formatTopCompact(networkStats.bySource, "src", networkStats.windowTotal));
  }
  const failed = networkStats.windowFailures;
  const topEntry = Array.from(networkStats.byHost.entries()).sort((a, b) => b[1] - a[1])[0];
  const topHost = topEntry
    ? `${truncate(topEntry[0], 32)} ${Math.round((topEntry[1] / networkStats.windowTotal) * 100)}%`
    : "";
  const headline = `Network — ${networkStats.windowTotal} calls/${windowSec}s, ${failed} failed${
    topHost ? ` · top ${topHost}` : ""
  }`;
  // Always-visible heartbeat (so you know polling is alive / what's failing even
  // when the individual poll reads are muted). Warns when the window had real
  // failures; the full per-host/status/source breakdown stays at trace.
  if (failed > 0) netLog.warn(headline);
  else netLog.event(headline);
  netLog.trace(`network detail ${sections.join(" ")}`);
  resetWindow();
}

function ensureStatsLogging() {
  if (statsInterval) return;
  statsInterval = setInterval(() => {
    logNetworkSummary("interval");
  }, NETWORK_STATS_LOG_INTERVAL_MS);
}

export function bumpNetworkSource(source: string) {
  if (!source) return;
  bump(networkStats.bySource, source);
}

let initialized = false;

function compactEndpoint(method: string, url: string): string {
  const { host, path } = parseUrl(url);
  return `${String(method || "GET").toUpperCase()} ${host}${normalizePath(path)}`;
}

function trimMap(map: Map<string, number>) {
  if (map.size <= NETWORK_LOG_SUPPRESS_MAX) return;
  const entries = Array.from(map.entries()).sort((a, b) => a[1] - b[1]);
  const removeCount = Math.max(1, map.size - NETWORK_LOG_SUPPRESS_MAX);
  for (let i = 0; i < removeCount; i += 1) {
    map.delete(entries[i][0]);
  }
}

function parseStackSourceLine(line: string): string | null {
  const trimmed = String(line || "").trim();
  if (!trimmed) return null;

  const a = trimmed.match(/at\s+([^\s(]+)\s+\((.+):(\d+):(\d+)\)$/);
  if (a) {
    const func = cleanFunc(a[1]);
    const file = compactPath(a[2]);
    const lineNo = Number(a[3]) || undefined;
    return `${file}${lineNo ? `:${lineNo}` : ""}#${func}`;
  }

  const b = trimmed.match(/at\s+(.+):(\d+):(\d+)$/);
  if (b) {
    const file = compactPath(b[1]);
    const lineNo = Number(b[2]) || undefined;
    return `${file}${lineNo ? `:${lineNo}` : ""}#anonymous`;
  }

  const c = trimmed.match(/^([^@]+)@(.+):(\d+):(\d+)$/);
  if (c) {
    const func = cleanFunc(c[1]);
    const file = compactPath(c[2]);
    const lineNo = Number(c[3]) || undefined;
    return `${file}${lineNo ? `:${lineNo}` : ""}#${func}`;
  }

  return null;
}

function inferRequestSourceFromStack(fallback?: string): string | undefined {
  const err = new Error();
  const stack = typeof err.stack === "string" ? err.stack : "";
  const lines = stack.split("\n").slice(1);

  for (const line of lines) {
    const parsed = parseStackSourceLine(line);
    if (!parsed) continue;
    if (parsed.includes("node_modules")) continue;
    const isInternal = NETWORK_STACK_INTERNAL_MARKERS.some((marker) => parsed.includes(marker));
    if (isInternal) continue;
    return parsed;
  }
  return fallback;
}

function inferRequestSourceFromUrl(url: string): string {
  const { host, path } = parseUrl(url);
  const normalizedPath = normalizePath(path);
  if (/alchemy\.com$/i.test(host)) return "rpc:alchemy";
  if (/mempool\.space$/i.test(host)) return `bitcoin:${normalizedPath}`;
  return `${host}${normalizedPath}`;
}

function resolveSource(rawSource: string | undefined, url: string): string {
  const source = String(rawSource || "").trim();
  if (
    !source ||
    /^unknown(#|$)/i.test(source) ||
    /^index\.bundle(?::\d+)?(?:#|$)/i.test(source) ||
    /#getCallerSource$/i.test(source)
  ) {
    return inferRequestSourceFromUrl(url);
  }
  return source;
}

function inferContextFromSource(source: string): LogContext {
  const s = String(source || "").toLowerCase();
  if (/\bpoll\b|pendingpoll|watchdog|interval|heartbeat/.test(s)) return "poll";
  if (/\bmanual\b|deeplink|onpress|press|tap|submit|send|copy|paste|scan/.test(s)) return "user";
  if (/init|prefetch|background|startup|resume|cache|refresh/.test(s)) return "background";
  return "system";
}

function expectedFetchErrorReason(url: string, _source: string, message: string): string | null {
  // Transient transport drop (iOS suspend, wifi/cellular handover) — not a failure anywhere.
  if (
    String(message || "")
      .toLowerCase()
      .includes("network connection was lost")
  ) {
    return "network_connection_lost";
  }
  const { path } = parseUrl(url);
  if (/\/v1\/indexer\/vtxos$/i.test(path)) return "arkade_indexer_vtxos_reconnect";
  if (/\/v1\/indexer\/script\/subscribe$/i.test(path)) {
    return "arkade_subscription_reconnect";
  }
  return /\/\.well-known\/lnurlp\//i.test(path) ? "lnurl_lookup_expected_failure" : null;
}

function isArkadeIndexerRateLimit(url: string, status: number): boolean {
  const { host, path } = parseUrl(url);
  return (
    status === 429 &&
    /^arkade\.computer$/i.test(host) &&
    (/\/v1\/indexer\/vtxos$/i.test(path) || /\/v1\/indexer\/script\/subscribe$/i.test(path))
  );
}

function isConfirmResultPendingStatus(url: string, status: number): boolean {
  const { path } = parseUrl(url);
  return (status === 404 || status === 410) && /\/v4\/arkade\/confirm\/result$/i.test(path);
}

async function expectedArkadeSubscriptionStatusReason(
  url: string,
  status: number,
  _resp: Response,
): Promise<string | null> {
  const { path } = parseUrl(url);
  if (status !== 500 || !/\/v1\/indexer\/script\/subscribe$/i.test(path)) return null;
  return "arkade_subscription_reconnect";
}

async function expectedFetchStatusReason(
  url: string,
  status: number,
  resp: Response,
  source?: string,
): Promise<string | null> {
  const { path } = parseUrl(url);
  const normalizedSource = String(source || "").toLowerCase();
  if (
    status === 404 &&
    /\/\.well-known\/lnurlp\//i.test(path) &&
    !normalizedSource.includes("services/bitcoin/lnurlservice")
  ) {
    return "lnurl_lookup_expected_failure";
  }
  if (isArkadeIndexerRateLimit(url, status)) {
    return "arkade_indexer_rate_limited";
  }
  const subscriptionReason = await expectedArkadeSubscriptionStatusReason(url, status, resp);
  if (subscriptionReason) {
    return subscriptionReason;
  }
  if (isConfirmResultPendingStatus(url, status)) {
    return "confirm_result_pending";
  }
  if (status === 404 && /\/esim\/complete$/i.test(path)) {
    return "esim_checkout_not_found";
  }
  // No swap-provider classifiers: the retired provider's endpoints are gone, so
  // there is nothing left to explain away.
  return null;
}

function shouldEmitSuccessLog(
  method: string,
  url: string,
  status: number,
  source: string,
): boolean {
  const { host, path } = parseUrl(url);
  const key = `${method} ${host}${normalizePath(path)} ${status} ${source}`;
  const now = Date.now();
  const previous = recentSuccessLogTs.get(key) || 0;
  recentSuccessLogTs.set(key, now);
  trimMap(recentSuccessLogTs);
  if (!previous) return true;
  return now - previous >= NETWORK_LOG_SUPPRESS_WINDOW_MS;
}

export function initializeNetworkLogging() {
  const g: any = typeof globalThis !== "undefined" ? globalThis : (global as any);
  if (g[NETWORK_STATS_GLOBAL_KEY]) return;
  g[NETWORK_STATS_GLOBAL_KEY] = true;
  if (initialized) return;
  initialized = true;
  ensureStatsLogging();

  // Patch global fetch
  const existingFetch = g.fetch;
  const fetchAlreadyWrapped = Boolean((existingFetch as any)?.[NETWORK_STATS_FETCH_WRAPPED_KEY]);
  const originalFetch =
    (existingFetch as any)?.[NETWORK_STATS_FETCH_ORIGINAL_KEY] || existingFetch?.bind(g) || fetch;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!fetchAlreadyWrapped) {
    const wrappedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (
        init?.method ||
        (input instanceof Request ? input.method : "GET") ||
        "GET"
      ).toUpperCase();
      const url = typeof input === "string" ? input : (input as URL | Request).toString();
      const source = resolveSource(
        (init as any)?.__nuriSource || inferRequestSourceFromStack(),
        url,
      );
      const context = inferContextFromSource(source);
      const { path } = parseUrl(url);
      const shouldLog = !isSilentPath(path);
      const op = shouldLog ? newOp("Network", "fetch", LOG_EMOJI.network, source, context) : null;
      recordRequest(method, url, source);
      try {
        const resp = await originalFetch(input as any, init);
        const expectedStatusReason = await expectedFetchStatusReason(
          url,
          resp.status,
          resp,
          source,
        );
        if (resp.ok) {
          reportNetworkSuccess();
        } else if (!expectedStatusReason) {
          networkStats.windowFailures += 1;
          reportNetworkFailure();
        }
        recordResponse(method, url, resp.status);
        if (resp.status === 500 && url.includes("/v1/indexer/script/subscribe")) {
          // arkade SDK ContractWatcher tries to resume a subscription whose
          // server-side state has been lost; the SDK's own recovery regex is
          // broken and never matches the real error format ("subscription not
          // found: <uuid>"), so it retries the dead UUID forever. Emit an event
          // so services/arkade/internal/subscriptions.ts can recreate the
          // ContractManager and open a fresh subscription. Body check keeps
          // us from reacting to unrelated 500s on this endpoint.
          void (async () => {
            try {
              const body = await resp.clone().text();
              const matched = body.toLowerCase().includes("subscription not found");
              console.log(
                `[NetworkLogger] subscribe 500 url=${url} bodyLen=${body.length} matched=${matched} bodyHead=${body.slice(0, 200)}`,
              );
              if (matched) {
                EventBus.emit("arkade:subscriptionLost", { url, body: body.slice(0, 200) });
              }
            } catch (e) {
              console.log(
                `[NetworkLogger] subscribe 500 body-read failed: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          })();
        }
        if (op && !resp.ok && expectedStatusReason) {
          op.log(
            `${compactEndpoint(method, url)} ←${resp.status} expected=${expectedStatusReason}`,
          );
          op.end(`HTTP_${resp.status}_EXPECTED`);
        } else if (op && !resp.ok) {
          op.error(`${compactEndpoint(method, url)} ←${resp.status}`);
          op.end(`HTTP_${resp.status}`);
        } else if (op && shouldEmitSuccessLog(method, url, resp.status, source)) {
          op.end(`${compactEndpoint(method, url)} ←${resp.status}`);
        }
        return resp;
      } catch (err) {
        recordResponse(method, url, "ERR");
        const message = err instanceof Error ? err.message : String(err);
        const expectedErrorReason = expectedFetchErrorReason(url, source, message);
        if (!expectedErrorReason) {
          networkStats.windowFailures += 1;
          reportNetworkFailure();
        }
        if (op) {
          if (expectedErrorReason) {
            if (/\/v1\/indexer\/script\/subscribe$/i.test(parseUrl(url).path)) {
              EventBus.emit("arkade:subscriptionLost", {
                url,
                body: expectedErrorReason,
              });
            }
            logWithId(
              `${LOG_EMOJI.network} Network.fetch`,
              "expected fetch failed",
              { method, endpoint: compactEndpoint(method, url), reason: expectedErrorReason },
              {
                event: "RETRY",
                result: "expected",
                scope: "Network",
                action: "fetch",
                source,
                context,
              },
            );
            op.log(`${compactEndpoint(method, url)} ×ERR expected=${expectedErrorReason}`);
            op.end("EXPECTED");
          } else {
            op.error(`${compactEndpoint(method, url)} ×ERR`, message);
            op.end("ERR");
          }
        }
        throw err;
      }
    };
    (wrappedFetch as any)[NETWORK_STATS_FETCH_WRAPPED_KEY] = true;
    (wrappedFetch as any)[NETWORK_STATS_FETCH_ORIGINAL_KEY] = originalFetch;
    g.fetch = wrappedFetch;
  }
}
