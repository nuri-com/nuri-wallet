import { ARBITRUM_USDC, BASE_EURC, BASE_USDC } from "../../config/network";
import type { FiatCode } from "../../lib/tokens";

/**
 * SINGLE source of truth for the token pair a SwapKit leg is parameterised by.
 *
 * Every direction the app supports is one of these on the stable side, so no
 * service may hardcode an asset id, a contract or a decimal count of its own:
 *
 *   EURC ⇄ USDC   single Base tx, LI.FI  → SwapKitDirectEvmSwapService
 *   stable → BTC  deposit/CoW/HTLC rail  → StableToBtcSwapService
 *   BTC → stable  funded BTC send        → SwapKitCardTopupService
 */
export type SwapKitStableToken = {
  chainId: number;
  /** SwapKit asset id — SYMBOL_CHAIN (see lib/formatting). */
  asset: string;
  /** Display symbol, used in error text and progress traces. */
  symbol: string;
  /** ERC-20 contract on `chainId`; the only token an approval may name. */
  token: `0x${string}`;
  decimals: number;
};

export const EURC_BASE_TOKEN: SwapKitStableToken = {
  chainId: BASE_EURC.chainId,
  asset: "EURC_BASE",
  symbol: "EURC",
  token: BASE_EURC.address,
  decimals: BASE_EURC.decimals,
};

export const USDC_BASE_TOKEN: SwapKitStableToken = {
  chainId: BASE_USDC.chainId,
  asset: "USDC_BASE",
  symbol: "USDC",
  token: BASE_USDC.address,
  decimals: BASE_USDC.decimals,
};

export const USDC_ARBITRUM_TOKEN: SwapKitStableToken = {
  chainId: ARBITRUM_USDC.chainId,
  asset: "USDC_ARBITRUM",
  symbol: "USDC",
  token: ARBITRUM_USDC.address,
  decimals: ARBITRUM_USDC.decimals,
};

/** The Base stables a swap may be denominated in on this app's own chain. */
export type BaseStableAssetId = "EURC_BASE" | "USDC_BASE";

const BASE_STABLES: Record<BaseStableAssetId, SwapKitStableToken> = {
  EURC_BASE: EURC_BASE_TOKEN,
  USDC_BASE: USDC_BASE_TOKEN,
};

// What a send to an address on another network settles in there (#1783,
// lib/send/evmNetworks). Contracts as LI.FI's token registry names them, the
// same registry the SwapKit server resolves its assets from; the route binding
// checks a payout against them.
const SEND_SETTLE_STABLES: Readonly<Record<string, SwapKitStableToken>> = {
  USDC_ETH: {
    chainId: 1,
    asset: "USDC_ETH",
    symbol: "USDC",
    token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    decimals: 6,
  },
  USDC_POLYGON: {
    chainId: 137,
    asset: "USDC_POLYGON",
    symbol: "USDC",
    token: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    decimals: 6,
  },
  USDC_OPTIMISM: {
    chainId: 10,
    asset: "USDC_OPTIMISM",
    symbol: "USDC",
    token: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    decimals: 6,
  },
  EURE_GNOSIS: {
    chainId: 100,
    asset: "EURE_GNOSIS",
    symbol: "EURe",
    token: "0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430",
    decimals: 18,
  },
  [USDC_ARBITRUM_TOKEN.asset]: USDC_ARBITRUM_TOKEN,
};

/** A stable a send can settle in on another network than Base, or null. */
export function sendSettleStable(asset: string): SwapKitStableToken | null {
  return SEND_SETTLE_STABLES[asset] ?? null;
}

/** What a direct swap settles in: a Base stable, or, for a send to an address
 * on another network (#1783), that network's stable. */
export type DirectEvmSettleAssetId = BaseStableAssetId | string;

/**
 * The token a direct swap settles in. Another network's stable only pays
 * someone else's address: this wallet's own balances are on Base.
 */
export function directEvmSettleToken(
  asset: DirectEvmSettleAssetId,
  external: boolean,
): SwapKitStableToken {
  if (asset === "EURC_BASE" || asset === "USDC_BASE") return baseStableToken(asset);
  const other = external ? sendSettleStable(asset) : null;
  if (!other) throw new Error(`Unsupported settle asset: ${asset}`);
  return other;
}

const STABLES_BY_ASSET: Readonly<Record<string, SwapKitStableToken>> = {
  ...BASE_STABLES,
  ...SEND_SETTLE_STABLES,
};

export function baseStableToken(asset: BaseStableAssetId): SwapKitStableToken {
  const token = BASE_STABLES[asset];
  if (!token) throw new Error(`Unsupported Base stable asset: ${asset}`);
  return token;
}

/** Every stable deployment the app knows, for allowance guards. */
export function listSwapKitStableTokens(): SwapKitStableToken[] {
  return Object.values(STABLES_BY_ASSET);
}

/** Resolve every stable deployment supported by direct-swap recovery/resume. */
export function swapKitStableToken(asset: string): SwapKitStableToken {
  const token = STABLES_BY_ASSET[asset];
  if (!token) throw new Error(`Unsupported SwapKit stable asset: ${asset}`);
  return token;
}

/**
 * The money a stable IS. A screen that settles one of these states an amount to
 * a person, and a person is owed the currency, not the token — so the ISO code
 * comes from here rather than from a conditional at each figure.
 */
export function stableFiatCode(stable: SwapKitStableToken): FiatCode {
  return stable.asset === USDC_BASE_TOKEN.asset || stable.asset === USDC_ARBITRUM_TOKEN.asset
    ? "USD"
    : "EUR";
}

// ── Bitcoin side ──────────────────────────────────────────────────────
// SwapKit's asset ids for the three Bitcoin rails this wallet can use.
//
// BTC_ARKADE and BTC_LN are the arkade wallet. `BTC` is on-chain Bitcoin, and
// which local wallet fills it depends on the DIRECTION:
//
//  - RECEIVING BTC (stable → BTC) settles to the arkade BOARDING address
//    (getArkadeBoardingAddress). The legacy MuSig2 wallet can NOT be the settle
//    target: it is a 2-of-2 cosigned wallet whose receive addresses are not the
//    wallet the app credits a swap to, so a swap paid there would land outside
//    the balance the user sees. This is why EURC → BTC (and USDC → BTC) always
//    boards into arkade.
//  - SENDING BTC (BTC → stable) funds a deposit address, so either wallet can
//    pay it: arkade offboards (BitcoinSendService `bitcoin_onchain`), and the
//    MuSig2 wallet pays through
//    services/bitcoin/OnchainSendService#sendBitcoinOnchainFromMusig2, which is
//    what SwapKitCardTopupService already does for `sendSource: "onchain"`.
export const BTC_ONCHAIN_ASSET = "BTC";
export const BTC_ARKADE_ASSET = "BTC_ARKADE";
export const BTC_LIGHTNING_ASSET = "BTC_LN";
