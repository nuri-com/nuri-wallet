// `/pay/@username` — the public payment link.
//
// Deliberately a separate parser from `parsePasskeyUsernamePath`: `/@username`
// signs a returning owner in, `/pay/@username` shows a stranger how to pay that
// owner, and the two must never be reachable from one another's path. Sharing a
// matcher would make a typo in one flow land in the other.
const USERNAME = /^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/;

/**
 * What the recipient receives: `?to=USDC_BASE` asks for dollars, `?to=BTC` for
 * on-chain bitcoin, anything else (or nothing) is euros. Only the recipient's
 * own currencies are accepted — the link can choose the currency, never a
 * destination.
 */
export function parsePaySettle(search: string): "EURC_BASE" | "USDC_BASE" | "BTC" {
  let to = "";
  try {
    to = new URLSearchParams(String(search || "")).get("to") || "";
  } catch {
    return "EURC_BASE";
  }
  const asked = to.trim().toUpperCase();
  if (asked === "USDC_BASE") return "USDC_BASE";
  if (asked === "BTC") return "BTC";
  return "EURC_BASE";
}

export type PaySettleCurrency = "EURC_BASE" | "USDC_BASE" | "BTC";

/** Decimal places each link currency can state an amount in. */
const SETTLE_DECIMALS: Record<PaySettleCurrency, number> = {
  EURC_BASE: 6,
  USDC_BASE: 6,
  BTC: 8,
};

/**
 * Everything a pay link's query asks for.
 *
 *   settle    what the recipient receives (`?to=`, euros by default)
 *   explicit  whether the link NAMED that currency — only then does the page
 *             hide the ways to pay that land in something else
 *   amount    what the recipient receives, in `settle`, as a plain decimal
 *             (`?amount=`); null when absent or unreadable. A link with an
 *             amount but no `to` is a euro link.
 *
 * An amount that is not a plain positive decimal, or has more decimals than
 * the currency, is not rounded into one — the link simply carries none.
 */
export function parsePayLink(search: string): {
  settle: PaySettleCurrency;
  explicit: boolean;
  amount: string | null;
} {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(String(search || ""));
  } catch {
    return { settle: "EURC_BASE", explicit: false, amount: null };
  }
  const settle = parsePaySettle(search);
  const rawAmount = (params.get("amount") || "").trim();
  const amount = isPayLinkAmount(rawAmount, settle) ? normalizeAmount(rawAmount) : null;
  // Only a currency the page recognises narrows the options; an unknown or
  // legacy `to` (e.g. `BTC_LN`) falls back to euros exactly like a plain link.
  const asked = (params.get("to") || "").trim().toUpperCase();
  const named = asked === "EURC_BASE" || asked === "USDC_BASE" || asked === "BTC";
  const explicit = named || amount !== null;
  return { settle, explicit, amount };
}

/** A plain positive decimal with no more places than `settle` has. */
export function isPayLinkAmount(value: string, settle: PaySettleCurrency): boolean {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value || "").trim());
  if (!match) return false;
  if ((match[2]?.length ?? 0) > SETTLE_DECIMALS[settle]) return false;
  return /[1-9]/.test(value);
}

function normalizeAmount(value: string): string {
  const [whole = "0", fraction = ""] = value.split(".");
  const w = whole.replace(/^0+(?=\d)/, "");
  const f = fraction.replace(/0+$/, "");
  return f ? `${w}.${f}` : w;
}

/**
 * A link that asks for `amount` of `settle` for `username`, or null when the
 * handle or the amount would be refused by the page. No amount = the payer
 * chooses it.
 */
export function prefilledPayLinkUrl(
  origin: string,
  username: string | null | undefined,
  settle: PaySettleCurrency,
  amount: string | null,
): string | null {
  const base = payLinkUrl(origin, username);
  if (!base) return null;
  const typed = String(amount ?? "").trim();
  if (typed && !isPayLinkAmount(typed, settle)) return null;
  const params = new URLSearchParams({ to: settle });
  if (typed) params.set("amount", normalizeAmount(typed));
  return `${base}?${params.toString()}`;
}

export function parsePayLinkPath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(String(pathname || ""));
  } catch {
    return null;
  }
  const match = /^\/pay\/@([^/]+)\/?$/.exec(decoded);
  const username = match?.[1]?.trim().toLowerCase() || "";
  return USERNAME.test(username) ? username : null;
}

/** The link that opens `username`'s pay page, or null for a handle the page would refuse. */
export function payLinkUrl(origin: string, username: string | null | undefined): string | null {
  const handle = String(username ?? "")
    .trim()
    .toLowerCase();
  if (!USERNAME.test(handle)) return null;
  return `${origin.replace(/\/+$/, "")}/pay/@${handle}`;
}
