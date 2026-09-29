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
 * a client-side fact (SwapKit settles Base USDC/EURC plus the Bitcoin rails), so
 * it is written here rather than inferred from the directory.
 */

import type { BaseStableAssetId } from "../../services/swapkit/SwapKitStableAssets";
import type { PayRecipient } from "./resolvePayRecipient";

export const PAY_SOURCE_ASSETS = [
  "BTC",
  "BTC_LN",
  "BTC_ARKADE",
  "USDC_BASE",
  "EURC_BASE",
  // Any token the payer's browser wallet holds, swapped in-page straight into
  // the recipient's settlement currency (the wallet signs the route itself).
  "EVM_WALLET",
  // Any ERC-20 sent to the recipient's own address on any supported chain; the
  // recipient's found-money sweep converts it to their Base currency.
  "EVM_ANY",
] as const;

export type PaySourceAsset = (typeof PAY_SOURCE_ASSETS)[number];

/** What the recipient ends up holding when a source is swapped in-page. */
export type PaySettleAsset = BaseStableAssetId;

export type PayRail =
  | { kind: "btc-onchain"; source: PaySourceAsset; address: string }
  | { kind: "lightning"; source: PaySourceAsset; lightningAddress: string }
  | { kind: "arkade"; source: PaySourceAsset; address: string }
  | { kind: "evm-stable"; source: PaySourceAsset; asset: BaseStableAssetId; address: string }
  | { kind: "wallet-swap"; source: PaySourceAsset; to: PaySettleAsset; settleTarget: string }
  | { kind: "evm-any"; source: PaySourceAsset; address: string };

/**
 * The rail a source asset takes to this recipient, or null when the recipient
 * has nothing that source can reach. Null is a real answer — the page says the
 * asset cannot be paid rather than quietly substituting another destination.
 */
export function selectPayRail(
  source: PaySourceAsset,
  recipient: PayRecipient,
  settle: PaySettleAsset = "EURC_BASE",
): PayRail | null {
  switch (source) {
    case "EVM_WALLET":
      return recipient.evmAddress
        ? { kind: "wallet-swap", source, to: settle, settleTarget: recipient.evmAddress }
        : null;
    case "EVM_ANY":
      return recipient.evmAddress
        ? { kind: "evm-any", source, address: recipient.evmAddress }
        : null;
    case "BTC":
      return recipient.btcAddress
        ? { kind: "btc-onchain", source, address: recipient.btcAddress }
        : null;
    case "BTC_LN":
      return recipient.lightningAddress
        ? { kind: "lightning", source, lightningAddress: recipient.lightningAddress }
        : null;
    case "BTC_ARKADE":
      return recipient.arkadeAddress
        ? { kind: "arkade", source, address: recipient.arkadeAddress }
        : null;
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

/** The source assets this recipient can be paid with, in presentation order. */
export function availablePaySources(recipient: PayRecipient): PaySourceAsset[] {
  return PAY_SOURCE_ASSETS.filter((source) => selectPayRail(source, recipient) !== null);
}

/** Whether the rail needs an amount before anything payable can be produced. */
export function railRequiresAmount(rail: PayRail): boolean {
  return rail.kind === "lightning" || rail.kind === "wallet-swap";
}
