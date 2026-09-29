// `/pay/@username` — the public payment link.
//
// Deliberately a separate parser from `parsePasskeyUsernamePath`: `/@username`
// signs a returning owner in, `/pay/@username` shows a stranger how to pay that
// owner, and the two must never be reachable from one another's path. Sharing a
// matcher would make a typo in one flow land in the other.
const USERNAME = /^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/;

/**
 * What the recipient receives when the payer's token is swapped in-page:
 * `?to=USDC_BASE` asks for dollars, anything else (or nothing) is euros. Only
 * the recipient's own Base currencies are accepted — the link can choose the
 * currency, never a destination.
 */
export function parsePaySettle(search: string): "EURC_BASE" | "USDC_BASE" {
  let to = "";
  try {
    to = new URLSearchParams(String(search || "")).get("to") || "";
  } catch {
    return "EURC_BASE";
  }
  return to.trim().toUpperCase() === "USDC_BASE" ? "USDC_BASE" : "EURC_BASE";
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
