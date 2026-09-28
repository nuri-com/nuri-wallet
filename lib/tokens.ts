/**
 * Fiat-token registry — single source of truth for all token addresses.
 */

export type FiatCode = "EUR" | "GBP" | "USD";

export type ChainId = 1 | 10 | 100 | 137 | 42161 | 8453 | 84532;

export interface TokenDeployment {
  address: `0x${string}`;
  chainId: ChainId;
  // Per-deployment decimals override. Most fiat tokens share the currency-level
  // `decimals`, but some deployments differ (e.g. Circle EURC on Base Sepolia is
  // 6, while EURe is 18). When set, this wins over `Currency.decimals`.
  decimals?: number;
}

export interface Currency {
  fiatCode: FiatCode;
  fiatSymbol: string;
  tokenSymbol: string;
  decimals: number;
  deployments: Partial<Record<ChainId, TokenDeployment>>;
}

export const CHAINS: Record<ChainId, { name: string }> = {
  1: { name: "Ethereum" },
  10: { name: "Optimism" },
  100: { name: "Gnosis" },
  137: { name: "Polygon" },
  42161: { name: "Arbitrum" },
  8453: { name: "Base" },
  84532: { name: "Base Sepolia" },
};

export const CIRCLE_EURC_BASE_MAINNET = {
  fiatCode: "EUR",
  tokenSymbol: "EURC",
  chainId: 8453,
  address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42",
  decimals: 6,
} as const;

export const CURRENCIES: Record<FiatCode, Currency> = {
  EUR: {
    fiatCode: "EUR",
    fiatSymbol: "€",
    tokenSymbol: "EURe",
    decimals: 18,
    deployments: {
      1: { address: "0x39b8B6385416f4cA36a20319F70D28621895279D", chainId: 1 },
      137: { address: "0xE0aEa583266584DafBB3f9C3211d5588c73fEa8d", chainId: 137 },
      42161: { address: "0x0c06cCF38114ddfc35e07427B9424adcca9F44F8", chainId: 42161 },
      8453: { address: "0xbf6e2966A9C3D99C9E4D069E04f7Bdb9C8aa762C", chainId: 8453 },
      // Wirex settlement EURC on Base Sepolia (6 dec) — the token the Wirex
      // account actually tracks (from /wallet balances[]), so EOA→AA deposits
      // and SEPA/card settle. NOT Circle's canonical EURC.
      84532: {
        address: "0xF70461ffb413981852683657A310892227e3989e",
        chainId: 84532,
        decimals: 6,
      },
    },
  },
  GBP: {
    fiatCode: "GBP",
    fiatSymbol: "£",
    tokenSymbol: "GBPe",
    decimals: 18,
    deployments: {
      1: { address: "0x78a20B7AF85156B4389a349Aa4c96efC2E509768", chainId: 1 },
      137: { address: "0x646BEea7a02FdAdA34c8e118949fE32350aB2206", chainId: 137 },
      42161: { address: "0x2D80dBf04D0802abD7A342DaFA5d7cB42bfbb52f", chainId: 42161 },
      8453: { address: "0xc4759Ed641DA77CbDc9fA2f37E9260a29BF7cC52", chainId: 8453 },
    },
  },
  USD: {
    fiatCode: "USD",
    fiatSymbol: "$",
    tokenSymbol: "USDC.e",
    decimals: 6,
    deployments: {
      // Wirex settlement USDC on Base Sepolia (6 dec) — from /wallet balances[].
      84532: { address: "0x7Af7cDbd557eD302F7538Db1e3d094C8BBcA665c", chainId: 84532 },
    },
  },
};

export const getAddress = (fiat: FiatCode, chain: ChainId): `0x${string}` | undefined =>
  CURRENCIES[fiat]?.deployments[chain]?.address;

// Decimals for a specific (fiat, chain) deployment. Prefers the per-deployment
// override, falling back to the currency-level default.
export const getDecimals = (fiat: FiatCode, chain: ChainId): number =>
  CURRENCIES[fiat]?.deployments[chain]?.decimals ?? CURRENCIES[fiat].decimals;

export const findCurrencyByAddress = (addr: string): Currency | undefined => {
  const lower = addr.toLowerCase();
  return Object.values(CURRENCIES).find((c) =>
    Object.values(c.deployments).some((d) => d.address.toLowerCase() === lower),
  );
};

/**
 * The ISO code an amount is stated in — "EUR", "USD", "GBP". Amounts are
 * written code-first ("EUR 10.11"), never with a glyph: one convention for
 * every currency, and no symbol a reader has to recognise.
 */
export const resolveFiatCode = (code: string | null): FiatCode => {
  if (!code) return "EUR";
  const upper = code.toUpperCase();
  if (upper === "EURE") return "EUR";
  if (upper === "USDE" || upper === "USDC.E") return "USD";
  if (upper === "GBPE") return "GBP";
  return CURRENCIES[upper as FiatCode] ? (upper as FiatCode) : "EUR";
};

/** Map a tokenSymbol (e.g. "EURe") to its FiatCode (e.g. "EUR"). */
export const fiatCodeFromTokenSymbol = (tokenSymbol: string): FiatCode | null => {
  const entry = Object.values(CURRENCIES).find(
    (c) => c.tokenSymbol.toLowerCase() === tokenSymbol.toLowerCase(),
  );
  return entry?.fiatCode ?? null;
};

export const SUPPORTED_FIAT_CODES = ["EUR", "GBP", "USD"] as const satisfies readonly FiatCode[];
