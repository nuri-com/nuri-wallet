import { isAddress } from "viem";
import { isEnsName, resolveEnsName } from "./resolveEns";
import type { QrParseResult } from "./types";
import { parseQr } from "./universalQrParser";

/**
 * Maps any scanned payment target onto a SwapKit destination. The wallet pays
 * from its own balance; SwapKit routes to `to` and settles at `settleTarget`.
 * Returns null when the scan is either handled natively elsewhere (plain
 * Base/EVM sends) or not payable — the caller shows the normal invalid toast.
 */
export type SwapScanTarget = {
  /** SwapKit asset id of the destination, e.g. "SOL_SOLANA", "BTC_LN". */
  to: string;
  /** Recipient the swap settles to: bolt11 invoice or chain address. */
  settleTarget: string;
  /** Fixed settle amount when a Lightning invoice carries one. */
  sats?: number;
  /** Short human label for the confirm UI. */
  label: string;
  /** ENS name the user typed, when `settleTarget` came from resolving it. */
  ensName?: string;
};

// Chain-prefixed payment URIs. The EVM keys are ERC-3770 `shortName`s from the
// ethereum-lists/chains registry (`eth`, `gno`, `pol`, `arb1`) — that is the
// only agreed-on standard for this format — plus the loose spellings people
// actually type. Value = the asset such a request is paid in on that chain.
// ponytail: hand-written map, not the 2000-entry registry. Only the four
// chains we hold a SwapKit asset for can be paid at all; unknown prefixes hit
// the invalid toast. Pull the real list in if that stops being true.
const CHAIN_PREFIX_ASSET: Record<string, string> = {
  solana: "SOL_SOLANA",
  sol: "SOL_SOLANA",
  gno: "EURE_GNOSIS", // ERC-3770
  gnosis: "EURE_GNOSIS",
  xdai: "EURE_GNOSIS",
  pol: "USDC_POLYGON", // ERC-3770 (was `matic` before the token rename)
  matic: "USDC_POLYGON",
  polygon: "USDC_POLYGON",
  arb1: "USDC_ARBITRUM", // ERC-3770
  arb: "USDC_ARBITRUM",
  arbitrum: "USDC_ARBITRUM",
  eth: "USDC_ETH", // ERC-3770
  mainnet: "USDC_ETH",
  // ponytail: no `ethereum:` — that's EIP-681, handled by the "evm" case above.
  // No `base:` either — Base sends stay on the native EURC path.
};

// eip155 chain ids → payment asset. Base (8453) is deliberately absent: plain
// Base sends stay on the native EURC path.
const EVM_CHAIN_ASSET: Record<number, string> = {
  1: "USDC_ETH",
  100: "EURE_GNOSIS",
  137: "USDC_POLYGON",
  42161: "USDC_ARBITRUM",
};

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const shorten = (value: string): string =>
  value.length > 16 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;

const assetLabel = (asset: string): string => {
  const [symbol, chain] = asset.split("_");
  return chain ? `${symbol} · ${chain.charAt(0)}${chain.slice(1).toLowerCase()}` : symbol;
};

/**
 * `toSwapTarget` plus ENS, for chain-prefixed names only: `gno:vitalik.eth`
 * resolves and settles on the prefixed chain.
 *
 * A BARE `vitalik.eth` returns null on purpose — one rule governs both address
 * forms: no chain info means Base, so a bare name takes the native EURC path
 * exactly like a bare `0x…`. An ENS name resolves to a plain EOA that exists
 * on every EVM chain, so Ethereum is not "more correct" than Base — it is just
 * where the name is registered, and routing there would force a swap the user
 * never asked for. The wallet's scan handler resolves bare names with
 * `resolveEnsName` and hands the address to the native Base send.
 *
 * Rejects with the RPC error when a name cannot be checked — never silently
 * degrades a lookup failure into "invalid address".
 */
export async function toSwapTargetAsync(raw: string): Promise<SwapScanTarget | null> {
  const value = String(raw || "").trim();
  const [, prefix = "", rest = ""] = value.match(/^([a-z0-9]+):(.+)$/i) ?? [];
  // A payment URI may carry parameters (`gno:vitalik.eth?amount=1`). The
  // address path already strips them before validating; do the same here, or
  // the name never looks like a name and a valid URI is rejected.
  const queryAt = rest.indexOf("?");
  const name = queryAt === -1 ? rest : rest.slice(0, queryAt);
  const query = queryAt === -1 ? "" : rest.slice(queryAt);
  if (!prefix || !isEnsName(name)) return toSwapTarget(value);
  const address = await resolveEnsName(name);
  if (!address) return null;
  const target = toSwapTarget(`${prefix}:${address}${query}`);
  // Show the name the user scanned AND the address it resolved to — the user
  // must be able to verify where the funds actually go before signing.
  return target && { ...target, ensName: name, label: `${name} (${shorten(address)})` };
}

export function toSwapTarget(raw: string): SwapScanTarget | null {
  const value = String(raw || "").trim();
  if (!value) return null;
  return parsedToSwapTarget(parseQr(value), value);
}

/** Same mapping for callers that already hold a parseQr result. */
export function parsedToSwapTarget(parsed: QrParseResult, raw?: string): SwapScanTarget | null {
  const value = String(raw ?? "").trim();
  switch (parsed.type) {
    case "lightning-invoice":
      return {
        to: "BTC_LN",
        settleTarget: parsed.invoice,
        ...(parsed.amountSats && parsed.amountSats > 0 ? { sats: parsed.amountSats } : {}),
        label: `Lightning · ${shorten(parsed.invoice)}`,
      };
    case "monero":
      // XMR_MONERO is derived on demand server-side (pairRule); while no
      // provider routes it yet the quote fails into the honest try-again
      // screen — the scan side is ready the day the server enables a route.
      return {
        to: "XMR_MONERO",
        settleTarget: parsed.address,
        label: `${assetLabel("XMR_MONERO")} · ${shorten(parsed.address)}`,
      };
    case "zcash":
      return {
        to: "ZEC_ZCASH",
        settleTarget: parsed.address,
        label: `${assetLabel("ZEC_ZCASH")} · ${shorten(parsed.address)}`,
      };
    case "caip10": {
      if (parsed.namespace === "solana") {
        return {
          to: "SOL_SOLANA",
          settleTarget: parsed.address,
          label: `${assetLabel("SOL_SOLANA")} · ${shorten(parsed.address)}`,
        };
      }
      if (parsed.namespace === "eip155") {
        const asset = EVM_CHAIN_ASSET[Number(parsed.chainRef)];
        if (!asset) return null;
        return {
          to: asset,
          settleTarget: parsed.address,
          label: `${assetLabel(asset)} · ${shorten(parsed.address)}`,
        };
      }
      return null;
    }
    case "evm": {
      // No chainId or Base: the native EURC send path owns it (caller order).
      if (parsed.chainId == null || parsed.chainId === 8453) return null;
      const asset = EVM_CHAIN_ASSET[parsed.chainId];
      if (!asset) return null;
      // EIP-681 token transfer: `parsed.address` is the TOKEN CONTRACT, not the
      // recipient. We only map a chain to a single stable asset and have no
      // verified contract→asset registry to confirm the requested token IS that
      // asset — so honoring it would execute e.g. a DAI request as USDC. Reject
      // unverifiable token requests rather than substitute the asset; plain
      // address sends (no transfer function) still map by chain.
      if (parsed.functionName === "transfer" || parsed.transferRecipient != null) return null;
      // A positive native `value` (e.g. `ethereum:<addr>@1?value=100000000000000000`)
      // is an ETH / native-coin payment intent, but each chain maps to its single
      // STABLE asset here — honoring it would settle USDC for a request that asked
      // for the native coin. Reject rather than substitute the asset; a valueless
      // address intent still maps by chain below.
      if (parsed.value != null && parsed.value > 0n) return null;
      const recipient = parsed.address;
      return {
        to: asset,
        settleTarget: recipient,
        label: `${assetLabel(asset)} · ${shorten(recipient)}`,
      };
    }
    case "unknown": {
      // 2-part chain prefix: `solana:ADDR`, `gno:0x…` (query params dropped).
      const prefixed = value.match(/^([a-z][a-z0-9]{1,11}):(.+)$/i);
      if (prefixed) {
        const asset = CHAIN_PREFIX_ASSET[prefixed[1].toLowerCase()];
        const address = prefixed[2].split("?")[0].trim();
        // EVM assets must get a real 0x address; Solana keeps the base58 shape.
        const ok = asset?.endsWith("_SOLANA") ? BASE58_ADDRESS.test(address) : isAddress(address);
        if (asset && ok) {
          return {
            to: asset,
            settleTarget: address,
            label: `${assetLabel(asset)} · ${shorten(address)}`,
          };
        }
        return null;
      }
      // Bare base58 of Solana address length → Solana (pragmatic v1 default;
      // a chain-picker for ambiguous bare addresses is the first fast-follow).
      if (BASE58_ADDRESS.test(value)) {
        return {
          to: "SOL_SOLANA",
          settleTarget: value,
          label: `${assetLabel("SOL_SOLANA")} · ${shorten(value)}`,
        };
      }
      return null;
    }
    default:
      return null;
  }
}
