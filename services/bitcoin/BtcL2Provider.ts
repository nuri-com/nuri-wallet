// Contract every Bitcoin L2 implementation satisfies. The registry in
// services/bitcoin/providers/registry.ts maps WalletMode → BtcL2Provider, so
// adding a third L2 means: implement this interface in a new file + register
// it. Existing screens / wrappers don't change.
//
// Cross-source concerns (NEAR swaps, pending purchases, arkade↔legacy
// dedup, fiat-price prefetch) stay in the consumer wrappers — those aren't
// owned by any single L2.

import type { BitcoinBalance } from "./BitcoinBalanceService";
import type { BitcoinTransaction } from "./BitcoinTransactionsService";
import type { BitcoinSendTarget, BitcoinSendResult } from "./BitcoinSendService";
import type { AddressTx } from "../../types/bitcoin";

export type BtcL2GetBalanceOptions = {
  address?: string;
  /** Bypass any internal cooldown on the underlying summary fetch. */
  forceFresh?: boolean;
  /** Arkade-only side effects; ignored by legacy. */
  scheduleAutoClaim?: boolean;
  scheduleAutoRecover?: boolean;
  scheduleAutoBoardingSweep?: boolean;
};

export type BtcL2GetTransactionsOptions = {
  address?: string;
  /** Legacy-only mode hint; ignored by arkade. */
  legacyMode?: "head" | "full";
};

export type BtcL2GetTransactionsResult = {
  rows: BitcoinTransaction[];
  /** Raw legacy onchain txs (only populated by the legacy provider). The
   *  wrapper uses these for arkade↔legacy dedup; arkade returns []. */
  legacyRaw: AddressTx[];
  /** Set when the provider performed a full (cache-priming) fetch. */
  isFullCache: boolean;
  /** Non-fatal source error. */
  error: string | null;
};

export type BtcL2SubscribeHandlers = {
  onIncoming?: (payload: {
    newVtxos: number;
    spentVtxos: number;
    coins: number;
  }) => void;
  onError?: (err: unknown) => void;
};

export interface BtcL2Provider {
  /** Headline balance for the active L2. */
  getBalance(opts: BtcL2GetBalanceOptions): Promise<BitcoinBalance>;
  /** Transactions the user owns on this L2. Cross-source merge happens above. */
  getTransactions(opts: BtcL2GetTransactionsOptions): Promise<BtcL2GetTransactionsResult>;
  /** Send through this L2's send path. Returns a unified result. */
  send(target: BitcoinSendTarget): Promise<BitcoinSendResult>;
  /** The receive address the user should be shown for this L2. */
  /**
   * Where this rail receives. Takes no caller-supplied fallback: a receive
   * address is a money destination, and the one thing worse than not having it
   * is substituting another. Returns "" when the rail cannot produce it, so the
   * caller aborts.
   */
  getReceiveAddress(): Promise<string>;
  /** Subscribe to incoming-funds / error events. Returns a stop function.
   *  Providers without a push channel (legacy mempool) return a no-op stop. */
  subscribe(handlers: BtcL2SubscribeHandlers): () => void;
}
