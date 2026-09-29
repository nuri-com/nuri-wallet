const USERNAME = /^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/;

export function parsePasskeyUsernamePath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(String(pathname || ""));
  } catch {
    return null;
  }
  const match = /^\/@([^/]+)\/?$/.exec(decoded);
  const username = match?.[1]?.trim().toLowerCase() || "";
  return USERNAME.test(username) ? username : null;
}

export function shouldWipeForPasskeySwitch(
  currentCredentialId: string | null | undefined,
  targetCredentialId: string,
  hasWallet: boolean,
): boolean {
  if (!hasWallet) return false;
  return String(currentCredentialId || "").trim() !== targetCredentialId.trim();
}
