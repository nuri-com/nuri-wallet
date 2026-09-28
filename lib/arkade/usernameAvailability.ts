// LUD-16 username availability lookup against the arkade server.
// 200 = name taken, 404 = available, anything else = network_error.
import { arkadeServerConfigService } from "../../services/arkade/ArkadeServerConfigService";

export type UsernameAvailability = "available" | "taken" | "invalid" | "network_error";

/** Server-side regex (matches the LNURL register handler): /^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/ */
export const USERNAME_REGEX = /^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/;

export function isUsernameFormatValid(name: string): boolean {
  const normalized = String(name || "")
    .trim()
    .toLowerCase();
  return USERNAME_REGEX.test(normalized);
}

export async function checkUsernameAvailability(name: string): Promise<UsernameAvailability> {
  const normalized = String(name || "")
    .trim()
    .toLowerCase();
  if (!isUsernameFormatValid(normalized)) return "invalid";

  // LNURL aliases live on the signer server (arkade.nuri.com), not the SDK
  // indexer (arkade.computer). The `.well-known/lnurlp/<username>` route is
  // served from the signer host root, so strip the trailing /v4 path before
  // appending. Hitting the wrong host returned 404 for every name and made
  // every name look "available" even when taken.
  const signer = arkadeServerConfigService.getSignerServerUrl().replace(/\/+$/, "");
  const base = signer.replace(/\/v4$/, "");
  const url = `${base}/.well-known/lnurlp/${encodeURIComponent(normalized)}`;

  try {
    const res = await fetch(url, { method: "GET" });
    if (res.status === 404) return "available";
    if (res.ok) return "taken";
    // Anything else (5xx, captive portal, transient network failure) →
    // network_error. The username step is mandatory and must not be skipped,
    // so the picker keeps the Continue button disabled on this state — users
    // retry by editing the name to trigger a fresh lookup.
    return "network_error";
  } catch {
    return "network_error";
  }
}
