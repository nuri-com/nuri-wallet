import { ARBITRUM_TBTC } from "../../config/network";
import { getChainRpcUrl } from "../../lib/rpc/chainRpc";
import type { ChainId } from "../../lib/tokens";
import { getCacheValue, setCacheValue } from "../balance/TransactionCacheService";

/**
 * The canonical contract for a chain+symbol, resolved the way the SwapKit server
 * resolves it: LI.FI's per-token endpoint, exact-symbol match, cached.
 *
 * The sweep server hardcodes no addresses (see its src/tokens.mjs) — it asks
 * this endpoint at scan time and hands the app whatever it returns. A static
 * allow-list in the app therefore drifts the moment the server's asset list
 * grows, and the app refuses money the server just announced. Asking the same
 * authority keeps the two definitions of "canonical" identical by construction.
 *
 * This is still a bind, not a bypass: the scanned contract must equal what this
 * returns for that chain+symbol.
 *
 * Resolutions are also written to durable storage and kept indefinitely there.
 * When LI.FI is unreachable the last known answer for that chain+symbol is used
 * — the server does the same with its KV ("stale beats broken"), and a contract
 * address that has already been confirmed once does not change. Only a token we
 * have NEVER resolved fails closed during an outage.
 */

const SOURCE = "https://li.quest/v1/token";
// Addresses effectively never change; a day matches the server's own TTL.
const TTL_MS = 24 * 60 * 60 * 1000;
// A "no" is cached far more briefly than a "yes". A timeout, a 5xx and a genuine
// miss all arrive as "no answer", and holding that for a day would make valid
// balances unclaimable until tomorrow because LI.FI blipped once.
const MISS_TTL_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_000;

export type RegistryToken = {
  chainId: number;
  address: `0x${string}`;
  decimals: number;
  symbol: string;
};

type CacheEntry = { at: number; token: RegistryToken | null };

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<RegistryToken | null>>();

const PINNED_TOKENS: Record<string, RegistryToken> = {
  "42161:TBTC": {
    chainId: ARBITRUM_TBTC.chainId,
    address: ARBITRUM_TBTC.address,
    decimals: ARBITRUM_TBTC.decimals,
    symbol: "tBTC",
  },
};

const keyFor = (chainId: number, symbol: string) => `${chainId}:${symbol.toUpperCase()}`;
const storageKeyFor = (key: string) => `swapkit:token:v1:${key}`;

/**
 * The last resolution that succeeded for this key, whenever that was. Only ever
 * consulted after a live lookup failed, so a stale address can never win over a
 * fresh one.
 */
async function lastKnownToken(key: string): Promise<RegistryToken | null> {
  try {
    const stored = await getCacheValue<RegistryToken>(storageKeyFor(key));
    if (!stored) return null;
    return /^0x[0-9a-fA-F]{40}$/.test(String(stored.address)) && Number.isInteger(stored.decimals)
      ? stored
      : null;
  } catch {
    return null;
  }
}

/** Only chains this app has an RPC for can be carried, whatever the registry says. */
export const isSignableChain = (chainId: number): boolean =>
  Boolean(getChainRpcUrl(chainId as ChainId));

async function fetchToken(chainId: number, symbol: string): Promise<RegistryToken | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = `${SOURCE}?chain=${chainId}&token=${encodeURIComponent(symbol)}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      address?: unknown;
      decimals?: unknown;
      symbol?: unknown;
    };
    const address = String(body?.address || "");
    const decimals = Number(body?.decimals);
    // The same guard the server applies: a fuzzy match must never pass as the
    // token whose balance we are about to move.
    if (String(body?.symbol || "").toUpperCase() !== symbol.toUpperCase()) return null;
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
    return { chainId, address: address as `0x${string}`, decimals, symbol: String(body.symbol) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The canonical token for this chain+symbol, or null when it cannot be
 * established. Concurrent asks for the same key share one request; a null result
 * is cached too, so a scan carrying several unresolvable assets does not fire a
 * request per item per pass.
 */
export async function resolveCanonicalToken(
  chainId: number,
  symbol: string,
): Promise<RegistryToken | null> {
  if (!Number.isFinite(chainId) || chainId <= 0 || !symbol.trim()) return null;
  const key = keyFor(chainId, symbol);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < (cached.token ? TTL_MS : MISS_TTL_MS)) {
    return cached.token;
  }

  const existing = inflight.get(key);
  if (existing) return existing;

  const request = fetchToken(chainId, symbol.trim())
    .then(async (fresh) => {
      // A miss is not proof the token is unknown — it is also what a timeout, a
      // 5xx, or a captive network looks like. Fall back to the last confirmed
      // answer rather than refusing to carry money over a transient outage. For
      // first-party SwapKit recovery assets that must appear in found-money even
      // before the registry has ever succeeded locally, use the pinned contract
      // already shared by the recovery consent path.
      const token = fresh ?? (await lastKnownToken(key)) ?? PINNED_TOKENS[key] ?? null;
      cache.set(key, { at: Date.now(), token });
      if (fresh) {
        try {
          await setCacheValue(storageKeyFor(key), fresh);
        } catch {}
      }
      return token;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, request);
  return request;
}

/** Test seam — the registry is process-wide state. */
export function __resetTokenRegistryCache(): void {
  cache.clear();
  inflight.clear();
}
