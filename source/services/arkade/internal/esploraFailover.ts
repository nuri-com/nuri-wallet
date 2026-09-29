// Which Esplora the Arkade SDK is given at wallet creation, and how it recovers
// when that host dies later.
//
// The SDK takes ONE provider and keeps it for the wallet's life, and every send
// and every boarding read consults it — so a host that is slow or unreachable
// from the user's network does not degrade the wallet, it stops it: the send
// sits on a fetch that never returns and the screen says "Preparing" forever.
//
// The app already keeps a second Esplora for its own reads. This gives the SDK
// the same courtesy, in two layers:
//
//   1. `resolveArkadeEsploraUrl` — probe at boot, so a host that is ALREADY
//      unreachable is never handed over in the first place.
//   2. `buildArkadeOnchainProvider` — wrap both hosts, so a host that starts
//      failing AFTER boot is failed over per-call. mempool.space rate-limits
//      per IP in bursts (429), which is exactly the case layer 1 cannot see:
//      it answers the probe and refuses everything a few seconds later.
//
// Both speak the same API, so the only thing that changes is which host.
import { EsploraProvider, type OnchainProvider } from "@arkade-os/sdk";
import { ESPLORA_FALLBACK_API_BASE_URL } from "../../../config/endpoints";
import { FailoverOnchainProvider } from "./failoverOnchainProvider";
import { emitTrace } from "./logging";
import { truncateForLog } from "./utils";

// Short on purpose: this runs before the wallet exists, and the point is to
// notice an unreachable host, not to wait out a slow one.
const ESPLORA_PROBE_TIMEOUT_MS = 4_000;

/**
 * Whether `ESPLORA_FALLBACK_API_BASE_URL` describes the same chain as the given
 * host. The fallback is mainnet's, so a testnet/regtest primary has nothing to
 * fall back to — a wrong-network Esplora would be worse than a slow one.
 */
function fallbackEligible(primary: string): boolean {
  return primary.startsWith("https://mempool.space/api");
}

async function answers(baseUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ESPLORA_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/blocks/tip/height`, {
      method: "GET",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The Esplora to hand the SDK: the preferred host when it answers, the mainnet
 * fallback when it does not.
 *
 * Returns the preferred host unchanged when there is nothing to fall back to
 * (a non-mainnet network, or no host at all).
 */
export async function resolveArkadeEsploraUrl(preferred: string | null): Promise<string | null> {
  const primary = String(preferred || "").trim();
  if (!primary) return null;
  if (!fallbackEligible(primary)) return primary;
  if (await answers(primary)) return primary;
  if (!(await answers(ESPLORA_FALLBACK_API_BASE_URL))) {
    // Neither answered: keep the preferred host rather than pinning the wallet
    // to a second unreachable one. This is a network-down case, not a
    // host-down case.
    emitTrace({
      atMs: Date.now(),
      op: "wallet_esplora",
      status: "unreachable",
      detail: `primary=${truncateForLog(primary, 60)} fallback=${truncateForLog(ESPLORA_FALLBACK_API_BASE_URL, 60)}`,
    });
    return primary;
  }
  emitTrace({
    atMs: Date.now(),
    op: "wallet_esplora",
    status: "failover",
    detail: `from=${truncateForLog(primary, 60)} to=${truncateForLog(ESPLORA_FALLBACK_API_BASE_URL, 60)}`,
  });
  return ESPLORA_FALLBACK_API_BASE_URL;
}

/**
 * The `OnchainProvider` to hand `Wallet.create`.
 *
 * A plain `EsploraProvider` when there is only one usable host (no URL, or a
 * non-mainnet chain the fallback does not serve), and a failing-over pair
 * otherwise. `resolvedUrl` is the output of `resolveArkadeEsploraUrl`, so the
 * host it already chose stays the preferred one.
 */
export function buildArkadeOnchainProvider(
  resolvedUrl: string | null,
): OnchainProvider | undefined {
  const url = String(resolvedUrl || "").trim();
  if (!url) return undefined;
  const primary = new EsploraProvider(url);
  const eligible = fallbackEligible(url) || url === ESPLORA_FALLBACK_API_BASE_URL;
  if (!eligible) return primary;
  // The boot probe may already have moved us to the fallback; in that case the
  // other host is mempool.space and it is still worth retrying against.
  const otherUrl =
    url === ESPLORA_FALLBACK_API_BASE_URL
      ? "https://mempool.space/api"
      : ESPLORA_FALLBACK_API_BASE_URL;
  return new FailoverOnchainProvider(
    primary,
    new EsploraProvider(otherUrl),
    hostLabel(url),
    hostLabel(otherUrl),
  );
}

function hostLabel(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
