// Resume-time executor rebuild (contract 2.2.0, P1: resume rebuild).
//
// On restart, every non-terminal stored order is re-armed. Flows that use the
// standard executor set (direct_evm, stable_to_btc, arkade_lightning) need
// nothing here — the default set is correct. But btc_to_stable and sweep orders
// carry a BOUNDED, flow-specific set (a send_asset funder with an exact-sats
// ceiling, a chain allowlist, an approval ceiling). Resuming those with the
// default set would reject their still-ready funding action and strand funds.
//
// This module reconstructs the exact bounded set from the JSON-safe
// `executorSpec` persisted at creation, so a resumed order behaves identically
// to a freshly created one. It reuses the flows' OWN builders — there is no
// second, drifting copy of the funder logic.
import type { SwapKitV2StoredOrder } from "./SwapKitV2OrderStore";
import type { SwapKitV2Executors } from "./SwapKitV2ActionService";
import { buildBtcToStableExecutorsFromSpec } from "./SwapKitV2BtcToStableService";
import { standardEvmLoopOptions } from "./SwapKitV2Executors";
import { settleBindingForOrder } from "./SwapKitV2EvmRouteBinding";
import { swapKitStableToken } from "./SwapKitStableAssets";
import { decimalUnits } from "./SwapKitV2ApprovalBounds";
import { makeSweepV2ExecutorsFor } from "./SwapKitV2SweepService";

export type RebuiltV2Executors = {
  executors: SwapKitV2Executors;
  allowedEvmChains?: readonly number[];
};

const BASE_CHAIN_ID = 8453;

/** Rebuild the flow-specific executor set for a resumed order, or null when the
 * flow uses the standard set (caller keeps the default). Throws only on a
 * genuinely unreconstructable bounded flow, so the caller can fail closed. */
export async function rebuildV2ExecutorsForOrder(
  order: SwapKitV2StoredOrder,
): Promise<RebuiltV2Executors | null> {
  const spec = order.executorSpec;
  if (!spec) return null;

  if (spec.flow === "standard_evm") {
    const amount = Number(spec.acceptedDeposit);
    // A bounded spec that cannot be read is NOT "use the default": returning
    // null here would let the caller fall back to the universal set. Throw so
    // every resume path fails closed on it.
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("standard_evm order has no readable accepted deposit to bound it");
    }
    // The SAME builder the live flow uses — not a parallel copy. The two were
    // built separately and drifted: the live path removed the Arkade/Lightning
    // funding executors, this one rebuilt the universal set, so after a restart
    // an EVM-source order could debit the unrelated Arkade wallet again.
    // Older rows lack sourceToken; the order's own `from` asset names it. No
    // fallback beyond that: an unresolvable token fails the resume closed.
    const sourceToken = spec.sourceToken ?? swapKitStableToken(order.from).token;
    return standardEvmLoopOptions(
      spec.chainId,
      amount,
      spec.tokenDecimals,
      sourceToken,
      // Same derivation as the live path: the committed recipient, token and
      // minimum settlement from the order row itself.
      settleBindingForOrder(order),
    );
  }

  if (spec.flow === "btc_to_stable") {
    const executors = buildBtcToStableExecutorsFromSpec({
      rail: spec.rail,
      sats: spec.sats ?? null,
      expectedUsdc: spec.expectedUsdc ?? null,
      sendSource: spec.sendSource ?? null,
    });
    // btc_to_stable settles on Base; EVM legs (if any) are Base-only.
    return { executors, allowedEvmChains: [BASE_CHAIN_ID] };
  }

  if (spec.flow === "sweep") {
    // Reconstruct the RegistryToken from the persisted spec — no live lookup,
    // no registry dependency. The address was validated as the canonical token
    // when the order was created; decimals/symbol are pinned with it.
    if (!/^0x[0-9a-fA-F]{40}$/.test(spec.tokenAddress)) return null;
    const token = {
      chainId: spec.chainId,
      address: spec.tokenAddress as `0x${string}`,
      decimals: spec.tokenDecimals,
      symbol: spec.tokenSymbol,
    };
    // Exact units when the order carries them; older orders fall back to the
    // decimal, parsed as text (never through a float).
    const detected =
      spec.detectedUnits && /^\d+$/.test(spec.detectedUnits)
        ? BigInt(spec.detectedUnits)
        : decimalUnits(spec.detectedAmount, spec.tokenDecimals);
    if (detected === null) return null;
    const executors = makeSweepV2ExecutorsFor(token, detected, settleBindingForOrder(order));
    if (!executors) return null;
    return {
      executors,
      allowedEvmChains: [spec.chainId, BASE_CHAIN_ID].filter((id) => Number.isFinite(id)),
    };
  }

  return null;
}
