// Centralized formatting utilities — extracted from screen files

export const truncateId = (value?: string | null) => {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-4)}`;
};

export const truncateToken = (token: string): string => {
  if (!token) return "n/a";
  if (token.length <= 16) return `${token.slice(0, 4)}…${token.slice(-4)}`;
  return `${token.slice(0, 8)}…${token.slice(-6)} (len=${token.length})`;
};

export const shortValue = (value: unknown, keep = 12): string => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.length <= keep) return raw;
  return `${raw.slice(0, keep)}…`;
};

export const shortAddress = (value: unknown): string => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.length <= 16) return raw;
  return `${raw.slice(0, 8)}…${raw.slice(-6)}`;
};

export function shortId(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "n/a";
  if (raw.length <= 12) return raw;
  return `${raw.slice(0, 8)}...${raw.slice(-4)}`;
}

// Thousands are separated by a no-break space, never a comma: a comma is a
// DECIMAL point to half the app's users, so "1,234" reads as one and a bit.
// No-break, so a number never wraps across two lines.
export function groupDigits(value: string): string {
  const cleaned = value.replace(/[^0-9]/g, "");
  return cleaned.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/**
 * The two number formatters the app displays with. Nothing here calls
 * `toLocaleString` or `Intl.NumberFormat`: those separate by the DEVICE's
 * locale, so one phone reads "1,234.50" where the next reads "1.234,50".
 */

/** A whole number for display: negatives clamped away, thousands grouped. */
export function groupCount(value: number): string {
  return groupDigits(String(Math.max(0, Math.trunc(value))));
}

/** A fixed-decimal amount, e.g. 1234.5 -> "1 234.50". The point stays a point. */
export function groupAmount(value: number, decimals = 2): string {
  const [whole, fraction] = Math.abs(value).toFixed(decimals).split(".");
  const sign = value < 0 ? "-" : "";
  return fraction ? `${sign}${groupDigits(whole)}.${fraction}` : `${sign}${groupDigits(whole)}`;
}

export const previewValue = (value?: string | null, max = 180): string => {
  if (!value) return "none";
  const singleLine = String(value).replace(/\s+/g, " ").trim();
  if (singleLine.length <= max) return singleLine;
  return `${singleLine.slice(0, max)}...`;
};

export function trimSlashes(value: string): string {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

export function ensurePath(value: string): string {
  const raw = String(value || "").trim();
  return raw.startsWith("/") ? raw : `/${raw}`;
}

export function shortB64u(value: string, keep = 12): string {
  const raw = String(value || "").trim();
  if (!raw) return "n/a";
  if (raw.length <= keep) return raw;
  return `${raw.slice(0, keep)}…`;
}

// SwapKit asset ids are SYMBOL[_CHAIN] (BTC_LN, USDC_ARBITRUM, EURC_BASE).
// UI shows just the symbol; the swap context makes the chain obvious.
const swapAssetSymbol = (id: unknown): string => String(id || "").split("_")[0] || String(id || "");

type SwapRouteLike = {
  path?: string[];
  providers?: Array<string | null | undefined>;
  etaSeconds?: number | null;
};

function swapEta(seconds: number | null | undefined): string | null {
  if (!(typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0)) return null;
  if (seconds < 60) return `~${Math.ceil(seconds)} sec`;
  return `~${Math.ceil(seconds / 60)} min`;
}

const SWAP_PROVIDER_LABELS: Record<string, string> = {
  cow: "CoW",
  fixedfloat: "FixedFloat",
  bitcoinvn: "BitcoinVN",
  lifi: "LI.FI",
  satora: "Satora",
  oneclick: "1Click",
  "arkade-intents": "Arkade Intents",
};

/**
 * "Arkade" / "Lightning" from a SwapKit routeId. The swap ENTRY screens lead
 * with the amount; the network is the first detail on each route card.
 */
export function swapRouteNetwork(routeId: string | null | undefined): string | null {
  const id = String(routeId || "").toLowerCase();
  if (id.includes("arkade")) return "Arkade";
  if (id.includes("lightning") || /(^|-)ln(-|$)/.test(id)) return "Lightning";
  return null;
}

// "USDC_BASE" → "USDC Base" — symbol + chain, compact.
const swapAssetCompact = (id: unknown): string => {
  const [symbol, chain] = String(id || "")
    .toUpperCase()
    .split("_");
  return chain ? `${symbol} ${chain.charAt(0)}${chain.slice(1).toLowerCase()}` : symbol || "";
};

/**
 * One compact detail line per route card: hop currencies first, then the
 * network, then the SwapKit provider names —
 * "USDC Base · Arkade · CoW + Satora" (Emin: currency before network, names
 * not domains).
 */
export function swapRouteCardDetail(
  route: (SwapRouteLike & { routeId?: string | null }) | null | undefined,
): string | null {
  const network = swapRouteNetwork(route?.routeId);
  const hubs = (route?.path ?? []).slice(1, -1).filter(Boolean).map(swapAssetCompact).join(" → ");
  const providers = formatSwapProviders(route?.providers);
  const parts = [hubs || null, network, providers, swapEta(route?.etaSeconds)].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** "CoW + FixedFloat" — human provider names for a route's provider list. */
export function formatSwapProviders(
  providers: Array<string | null | undefined> | null | undefined,
): string | null {
  const names = (providers ?? [])
    .filter(Boolean)
    .map((provider) => SWAP_PROVIDER_LABELS[String(provider)] ?? String(provider));
  return names.length ? names.join(" + ") : null;
}

/** "BTC → USDC → EURC · fixedfloat + lifi" from a SwapKit route. Never hardcodes hops. */
export function formatSwapRoute(route: SwapRouteLike | null | undefined): string | null {
  const path = (route?.path ?? []).filter(Boolean).map(swapAssetSymbol);
  const providers = (route?.providers ?? []).filter(Boolean) as string[];
  const pathText = path.join(" → ");
  const providerText = providers.join(" + ");
  if (pathText && providerText) return `${pathText} · ${providerText}`;
  return pathText || providerText || null;
}

// Hubs keep their chain ("USDC·Arbitrum") — alternatives often differ only there.
const swapHubLabel = (id: unknown): string => {
  const [sym, ...chain] = String(id || "").split("_");
  const chainText = chain.join("_");
  if (!chainText) return sym;
  return `${sym}·${chainText.charAt(0)}${chainText.slice(1).toLowerCase()}`;
};

/** Compact backup-route summary: the intermediate hubs (or "direct") of each alternative. */
export function formatSwapAlternatives(
  alternatives: SwapRouteLike[] | null | undefined,
): string | null {
  const hubs = (alternatives ?? [])
    .map((alt) => {
      const path = (alt.path ?? []).filter(Boolean);
      const middle = path.slice(1, -1).map(swapHubLabel).join("→");
      return middle || (path.length ? "direct" : "");
    })
    .filter(Boolean);
  if (!hubs.length) return null;
  return hubs.join(", ");
}
