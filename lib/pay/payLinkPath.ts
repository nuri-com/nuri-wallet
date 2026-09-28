// `/pay/@username` — the public payment link.
//
// Deliberately a separate parser from `parsePasskeyUsernamePath`: `/@username`
// signs a returning owner in, `/pay/@username` shows a stranger how to pay that
// owner, and the two must never be reachable from one another's path. Sharing a
// matcher would make a typo in one flow land in the other.
const USERNAME = /^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/;

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
