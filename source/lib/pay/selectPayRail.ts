/**
 * Which way a chosen source asset reaches the recipient.
 *
 * The pay page has no destination picker: the destination IS the recipient, and
 * this decides the fewest-hop way to get there. A source that matches one of the
 * recipient's own rails is a plain transfer with no exchange in it; anything else
 * has to be swapped, and the swap settles into the rail the recipient can
 * actually use.
 *
 * A record's PRESENCE is not a capability claim. The gateway serves one EVM
 * address for every chain, so `evmAddress` says "this address exists", never
 * "this chain is supported". Which chains and stables the app can settle into is
 * a client-side fact (SwapKit settles Base USDC/EURC plus on-chain Bitcoin), so
 * it is written here rather than inferred from the directory.
 */

import type { BaseStableAssetId } from "../../services/swapkit/SwapKitStableAssets";
import type { PayRecipient } from "./resolvePayRecipient";

export const PAY_SOURCE_ASSETS = [
  // One Bitcoin source; the payer then says how they send it (PayBitcoinMethod).
  "BTC",
  "USDC_BASE",
  "EURC_BASE",
  // Any token the payer's browser wallet holds, swapped in-page straight into
  // the link's currency (the wallet signs the route itself).
  "EVM_WALLET",
  // Any ERC-20 sent to the recipient's own address on any supported chain; the
  // recipient's found-money sweep converts it to their Base currency.
  "EVM_ANY",
] as const;

export type PaySourceAsset = (typeof PAY_SOURCE_ASSETS)[number];

/**
 * How a Bitcoin payer sends. The recipient's app receives on-chain only, so
 * Lightning is swapped into their on-chain address (SwapKit BTC_LN -> BTC).
 */
export type PayBitcoinMethod = "onchain" | "lightning";

/** What the recipient ends up holding: the link's `?to=` currency. */
export type PaySettleAsset = BaseStableAssetId | "BTC";

export type PayRail =
  | { kind: "btc-onchain"; source: PaySourceAsset; address: string }
  | { kind: "btc-lightning"; source: PaySourceAsset; settleTarget: string }
  | { kind: "evm-stable"; source: PaySourceAsset; asset: BaseStableAssetId; address: string }
  | { kind: "wallet-swap"; source: PaySourceAsset; to: PaySettleAsset; settleTarget: string }
  | { kind: "evm-any"; source: PaySourceAsset; address: string };

/** Where the link's currency lands for this recipient, or null when they have no such rail. */
export function payoutTarget(recipient: PayRecipient, settle: PaySettleAsset): string | null {
  return settle === "BTC" ? recipient.btcAddress : recipient.evmAddress;
}

/**
 * The rail a source asset takes to this recipient, or null when the recipient
 * has nothing that source can reach. Null is a real answer — the page says the
 * asset cannot be paid rather than quietly substituting another destination.
 */
export function selectPayRail(
  source: PaySourceAsset,
  recipient: PayRecipient,
  settle: PaySettleAsset = "EURC_BASE",
  bitcoinMethod: PayBitcoinMethod = "onchain",
): PayRail | null {
  switch (source) {
    case "EVM_WALLET": {
      const target = payoutTarget(recipient, settle);
      return target ? { kind: "wallet-swap", source, to: settle, settleTarget: target } : null;
    }
    case "EVM_ANY":
      return recipient.evmAddress
        ? { kind: "evm-any", source, address: recipient.evmAddress }
        : null;
    case "BTC":
      if (!recipient.btcAddress) return null;
      return bitcoinMethod === "lightning"
        ? { kind: "btc-lightning", source, settleTarget: recipient.btcAddress }
        : { kind: "btc-onchain", source, address: recipient.btcAddress };
    case "USDC_BASE":
      return recipient.evmAddress
        ? { kind: "evm-stable", source, asset: "USDC_BASE", address: recipient.evmAddress }
        : null;
    case "EURC_BASE":
      return recipient.evmAddress
        ? { kind: "evm-stable", source, asset: "EURC_BASE", address: recipient.evmAddress }
        : null;
    default:
      return null;
  }
}

/**
 * What a source lands as at the recipient. `EVM_ANY` lands as whatever token
 * was sent, converted later by the recipient's own found-money sweep, so it
 * guarantees neither the currency nor an amount.
 */
function landsIn(source: PaySourceAsset, settle: PaySettleAsset): boolean {
  switch (source) {
    case "EVM_WALLET":
      return true; // swapped in-page into the link's currency
    case "BTC":
      return settle === "BTC";
    case "EURC_BASE":
    case "USDC_BASE":
      return source === settle;
    default:
      return false;
  }
}

/**
 * The sources a link offers, in presentation order.
 *
 * A link that names its currency (`?to=`, or an amount) offers only what lands
 * in it: that stable or Bitcoin directly, plus any token swapped by the payer's
 * wallet. "Send any token to the address" guarantees neither the currency nor
 * an amount (the recipient's later sweep converts into THEIR stored currency),
 * so it stays on plain links only. A fixed BTC amount has no connect-wallet
 * route: SwapKit's LI.FI adapter quotes no exact-output (settle-side) swap into
 * BTC, so the option is hidden there rather than ending at "no route". A plain
 * link offers everything the recipient can receive, as before.
 */
export function availablePaySources(
  recipient: PayRecipient,
  settle: PaySettleAsset = "EURC_BASE",
  link: { explicit?: boolean; amount?: string | null } = {},
): PaySourceAsset[] {
  const narrow = settle === "BTC" || Boolean(link.explicit);
  const fixed = Boolean(link.amount);
  return PAY_SOURCE_ASSETS.filter((source) => {
    if (selectPayRail(source, recipient, settle) === null) return false;
    if (!narrow) return true;
    if (source === "EVM_ANY") return false;
    if (source === "EVM_WALLET" && settle === "BTC" && fixed) return false;
    return landsIn(source, settle);
  });
}

/** Whether the rail needs an amount before anything payable can be produced. */
export function railRequiresAmount(rail: PayRail): boolean {
  return rail.kind === "btc-lightning" || rail.kind === "wallet-swap";
}
