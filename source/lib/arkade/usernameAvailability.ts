// LUD-16 username availability lookup against the arkade server.
// 200 = name taken, 404 = available, anything else = network_error.
import { arkadeServerConfigService } from "../../services/arkade/ArkadeServerConfigService";

export type UsernameAvailability = "available" | "taken" | "invalid" | "network_error";

// A stalled lookup never settles: the picker stays on "checking" forever, so
// Continue stays disabled with no status text (onboarding uses
// statusMode="errors"). Bound it so a dead request becomes network_error.
const LOOKUP_TIMEOUT_MS = 8000;

/**
 * Every username that exists, for lookups (matches the server's handlers). Names
 * claimed before the ENS rule below can hold a dot or an underscore.
 */
export const USERNAME_REGEX = /^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/;

/**
 * A name that can be claimed now: also one valid ENS label, so `<name>.nuri.eth`
 * resolves (server-arkade-v4 isEnsUsername). No dot, no underscore, no "--" in
 * places 3 and 4.
 */
const CLAIMABLE_USERNAME_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;

export function isUsernameFormatValid(name: string): boolean {
  const normalized = String(name || "")
    .trim()
    .toLowerCase();
  return CLAIMABLE_USERNAME_REGEX.test(normalized) && normalized.slice(2, 4) !== "--";
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

  // AbortController + setTimeout, NOT AbortSignal.timeout: React Native
  // (setUpXHR.js) replaces the global AbortSignal with abort-controller@3,
  // which has no static `timeout`. Calling it throws inside this try, the
  // catch turns that into `network_error`, and the lookup dies silently on
  // every native build — no request issued, `taken` unreachable. Node-env
  // vitest and `tsc` (lib.dom) both miss it. This is the convention every
  // other timeout in the repo uses (ArkadeApiService#fetchWithTimeout et al).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    if (res.status === 404) return "available";
    if (res.ok) return "taken";
    // Anything else (5xx, captive portal, transient network failure) →
    // network_error. The claim itself is authoritative and rejects a taken
    // name with a visible error, so Continue stays submittable on this state.
    return "network_error";
  } catch {
    return "network_error";
  } finally {
    clearTimeout(timer);
  }
}
