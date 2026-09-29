// What the connected payer actually holds, from LI.FI's wallet balances API
// (`li.quest/v1/wallets/<address>/balances`). The pay page offers only these
// tokens: the payer picks one instead of typing a symbol, so a mistyped or
// look-alike token can never be quoted.
//
// Only Hypernative-verified ERC-20s on the chains the page can pay from are
// offered — the same verification bar the found-money sweep applies — and
// every figure stays exact (base units as bigint), never a float.
import { formatBaseUnits } from "../../lib/pay/payTarget";
import { PAY_WALLET_CHAIN_IDS, type PayWalletToken } from "./PayWalletSwapService";

const SOURCE = "https://li.quest/v1/wallets";
const REQUEST_TIMEOUT_MS = 15_000;
/** Below this a swap costs more in gas than it moves. */
const MIN_USD = 1;

/** A token the payer holds and can pay with. */
export type PayWalletHolding = PayWalletToken & {
  name: string;
  /** Exact balance in base units. */
  units: bigint;
  /** Exact balance as a plain decimal ("700.25"). */
  amount: string;
  /** Approximate value, for sorting and display only — never for money. */
  usd: number | null;
  logoURI: string | null;
};

type RawBalance = {
  address?: unknown;
  chainId?: unknown;
  symbol?: unknown;
  name?: unknown;
  decimals?: unknown;
  amount?: unknown;
  priceUSD?: unknown;
  logoURI?: unknown;
  verificationStatus?: unknown;
};

const NATIVE = "0x0000000000000000000000000000000000000000";

/** Keep what the page can pay with; drop anything malformed, native, unverified or dust. */
export function parsePayWalletHoldings(body: unknown): PayWalletHolding[] {
  const balances = (body as { balances?: Record<string, unknown> } | null)?.balances;
  if (!balances || typeof balances !== "object") return [];
  const holdings: PayWalletHolding[] = [];
  for (const [chainKey, list] of Object.entries(balances)) {
    const chainId = Number(chainKey);
    if (!PAY_WALLET_CHAIN_IDS.includes(chainId) || !Array.isArray(list)) continue;
    for (const raw of list as RawBalance[]) {
      const address = String(raw?.address ?? "");
      const symbol = String(raw?.symbol ?? "").trim();
      const decimals = Number(raw?.decimals);
      const amount = String(raw?.amount ?? "");
      if (Number(raw?.chainId ?? chainId) !== chainId) continue;
      if (raw?.verificationStatus !== "verified") continue;
      if (!/^0x[0-9a-fA-F]{40}$/.test(address) || address.toLowerCase() === NATIVE) continue;
      // The symbol becomes the SwapKit id (SYMBOL_CHAIN): same rule as the quote.
      if (!/^[A-Za-z0-9.]{1,20}$/.test(symbol)) continue;
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) continue;
      if (!/^\d+$/.test(amount)) continue;
      const units = BigInt(amount);
      if (units <= 0n) continue;
      const price = Number(raw?.priceUSD);
      const whole = formatBaseUnits(units, decimals);
      const usd = Number.isFinite(price) && price > 0 ? Number(whole) * price : null;
      if (usd !== null && usd < MIN_USD) continue;
      holdings.push({
        chainId,
        address: address as `0x${string}`,
        decimals,
        symbol,
        name: String(raw?.name ?? symbol),
        units,
        amount: whole,
        usd,
        logoURI: typeof raw?.logoURI === "string" && raw.logoURI ? raw.logoURI : null,
      });
    }
  }
  // Largest value first; unpriced tokens last.
  return holdings.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
}

/** The payer's payable holdings, or null when the lookup failed (not "holds nothing"). */
export async function fetchPayWalletHoldings(
  account: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PayWalletHolding[] | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(account)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${SOURCE}/${account}/balances?extended=true`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { walletAddress?: unknown };
    // The answer must be about the wallet we asked for.
    if (String(body?.walletAddress ?? "").toLowerCase() !== account.toLowerCase()) return null;
    return parsePayWalletHoldings(body);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Hosts token logos may load from. The page CSP keeps `img-src` closed so an
 * image URL cannot become a data-leak channel; these are fixed public CDNs
 * (no attacker-readable access logs) and are the ones LI.FI's balances use
 * for nearly every token. Anything else falls back to a plain avatar.
 */
export const PAY_WALLET_LOGO_HOSTS = [
  "static.debank.com",
  "raw.githubusercontent.com",
  "assets.coingecko.com",
] as const;

/** An image source for a LI.FI logo URL, or null when it may not load here. */
export function payWalletLogoSource(logoURI: string | null): { uri: string } | null {
  if (!logoURI) return null;
  try {
    const url = new URL(logoURI);
    if (url.protocol !== "https:") return null;
    if (!(PAY_WALLET_LOGO_HOSTS as readonly string[]).includes(url.hostname)) return null;
    return { uri: url.toString() };
  } catch {
    return null;
  }
}

/** Whether `amount` (plain decimal) is more than the holding has. Exact. */
export function exceedsHolding(holding: PayWalletHolding, units: bigint): boolean {
  return units > holding.units;
}
