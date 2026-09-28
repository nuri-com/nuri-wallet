// Registry of BtcL2Provider implementations.
// Adding a new L2 = implement BtcL2Provider in a new file + wire it here.

import type { BtcL2Provider } from "../BtcL2Provider";
import { arkadeProvider } from "./arkadeProvider";
import { legacyOnchainProvider } from "./legacyOnchainProvider";

/** Which wallet a balance, transaction row or send belongs to. */
export type BtcSourceId = "arkade" | "onchain";

/**
 * The default provider — arkade. Callers that only need one rail (receive
 * address, incoming subscription) keep using this.
 */
export function getBtcL2Provider(): BtcL2Provider {
  return arkadeProvider;
}

export function getBtcL2ProviderFor(source: BtcSourceId): BtcL2Provider {
  return source === "onchain" ? legacyOnchainProvider : arkadeProvider;
}

/**
 * Both rails, in display order. The Bitcoin tab holds an arkade balance and a
 * MuSig2 on-chain balance at the same time, so balance and history views
 * aggregate across this list rather than picking one provider.
 *
 * NOTE: `legacyOnchainProvider.send()` deliberately throws — the on-chain send
 * is a 2-of-2 round with the v4 co-signer, owned by
 * `services/bitcoin/OnchainSendService.ts`. Route on-chain sends there, not
 * through the provider.
 */
export const BTC_SOURCES: ReadonlyArray<{ id: BtcSourceId; provider: BtcL2Provider }> = [
  { id: "arkade", provider: arkadeProvider },
  { id: "onchain", provider: legacyOnchainProvider },
];
