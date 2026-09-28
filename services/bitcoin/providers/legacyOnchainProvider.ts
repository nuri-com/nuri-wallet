// Legacy onchain Bitcoin L2 provider.
//
// Wraps mempool.space (via blockchainService + balance/transactions modules)
// for the user's mainnet bitcoin address. No push subscription channel —
// updates come from periodic polling in higher-level hooks.

import { blockchainService } from "../BlockchainService";
import { walletService } from "../WalletService";
import {
  fetchBitcoinTransactions,
  refreshBitcoinTransactionsHead,
} from "../../balance/transactions/bitcoinTransactions";
import type { AddressTx } from "../../../types/bitcoin";
import type { BitcoinBalance } from "../BitcoinBalanceService";
import { EMPTY_BITCOIN_BALANCE } from "../BitcoinBalanceService";
import type {
  BtcL2GetBalanceOptions,
  BtcL2GetTransactionsOptions,
  BtcL2GetTransactionsResult,
  BtcL2Provider,
  BtcL2SubscribeHandlers,
} from "../BtcL2Provider";
import type { BitcoinSendResult, BitcoinSendTarget } from "../BitcoinSendService";

const NOOP_STOP = () => {};

export const legacyOnchainProvider: BtcL2Provider = {
  async getBalance(opts: BtcL2GetBalanceOptions): Promise<BitcoinBalance> {
    const address = (opts.address || "").trim();
    if (!address) return EMPTY_BITCOIN_BALANCE;
    // Deliberately unguarded: a failed read is NOT a zero balance. Reporting
    // zeros here is what emptied the on-chain rail whenever mempool.space was
    // unreachable — the caller keeps the last known figure instead.
    const bal = await blockchainService.getBalanceSummary(address);
    const total = Math.trunc(Number(bal?.total) || 0);
    const confirmed = Math.trunc(Number(bal?.confirmed) || 0);
    const unconfirmed = Math.trunc(Number(bal?.unconfirmed) || 0);
    const txCount = Math.trunc(Number(bal?.txCount) || 0);
    return {
      total,
      byChannel: { onchain: total, arkade: 0, lightning: 0 },
      detail: {
        onchain: { confirmed, unconfirmed, txCount },
        arkade: { boardingConfirmed: 0, boardingUnconfirmed: 0 },
      },
    };
  },

  async getTransactions(opts: BtcL2GetTransactionsOptions): Promise<BtcL2GetTransactionsResult> {
    const address = (opts.address || "").trim();
    if (!address) {
      return { rows: [], legacyRaw: [], isFullCache: false, error: null };
    }
    const legacyMode = opts.legacyMode ?? "head";
    const fetcher =
      legacyMode === "full" ? fetchBitcoinTransactions : refreshBitcoinTransactionsHead;
    try {
      const r = await fetcher({ address });
      const legacyRaw: AddressTx[] = Array.isArray(r.txs) ? r.txs : [];
      return {
        // Row mapping (classify + filter Arkade commitments) lives in the
        // wrapper, where the cross-source dedup also happens. Provider just
        // returns raw legacy txs.
        rows: [],
        legacyRaw,
        isFullCache: legacyMode === "full" && !r.error,
        error: r.error ?? null,
      };
    } catch (e) {
      return {
        rows: [],
        legacyRaw: [],
        isFullCache: false,
        error: e instanceof Error ? e.message : "legacy fetch failed",
      };
    }
  },

  async send(_target: BitcoinSendTarget): Promise<BitcoinSendResult> {
    // The on-chain send is a 2-of-2 round with the v4 co-signer and is owned by
    // `services/bitcoin/OnchainSendService.ts`, which carries its own approval
    // and status callbacks. Routing through this method intentionally throws so
    // callers go there rather than pretending the provider can do it.
    throw new Error("legacy onchain send is not routed through BtcL2Provider");
  },

  async getReceiveAddress(): Promise<string> {
    // The on-chain rail IS a receive target, at the one Arkade-cosigned (v4)
    // MuSig2 address the app derives. No other on-chain address is ever handed
    // out: money sent anywhere else is money this app cannot see or spend.
    const address = walletService.getAddressSnapshot().musig2Address.trim();
    if (!address) throw new Error("no onchain address yet");
    return address;
  },

  subscribe(_handlers: BtcL2SubscribeHandlers): () => void {
    // mempool.space has no push channel; higher layers poll.
    return NOOP_STOP;
  },
};
