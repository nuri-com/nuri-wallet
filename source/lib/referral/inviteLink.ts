// `/invite/@username` (or `/invite/username`): someone's invite link.
//
// A separate path from `/@username`, which signs that user in with their own
// passkey: an invite opened there would send the new user to the inviter's
// login instead of signup.
const USERNAME = /^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/;

/** `username`'s invite link, or null for a handle the link would refuse. */
export function inviteLinkUrl(origin: string, username: string | null | undefined): string | null {
  const handle = String(username ?? "")
    .trim()
    .toLowerCase();
  if (!USERNAME.test(handle)) return null;
  return `${origin.replace(/\/+$/, "")}/invite/@${handle}`;
}

/** The inviter's username in an invite path, or null for anything else. */
export function parseInviteLinkPath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(String(pathname || ""));
  } catch {
    return null;
  }
  const match = /^\/invite\/@?([^/@]+)\/?$/.exec(decoded);
  const username = match?.[1]?.trim().toLowerCase() || "";
  return USERNAME.test(username) ? username : null;
}
