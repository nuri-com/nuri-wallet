// The shape of a Bitcoin balance, plus the pure mapping from an Arkade wallet
// summary onto it. A leaf module on purpose: BitcoinBalanceService imports the
// provider registry, the registry imports arkadeProvider, and arkadeProvider
// needs `balanceFromArkadeSummary`. Importing it back from the service closed a
// require cycle (issue #874). Nothing here imports a provider, so the cycle is
// gone rather than merely tolerated.

import type { ArkadeWalletSummary } from "../arkade/types/wallet";

export type BitcoinBalance = {
  /** Headline confirmed-spendable amount. Screens should read this. */
  total: number;
  /** Per-source headline numbers. Add new keys here; screens stay unchanged. */
  byChannel: {
    onchain: number;
    arkade: number;
    lightning: number;
  };
  /** Source-specific detail for infra callers that need more than total. */
  detail: {
    onchain: {
      confirmed: number;
      unconfirmed: number;
      txCount: number;
      /**
       * The part of `byChannel.onchain` a send can actually move: the balance
       * read for the one MuSig2 address the app derives, which is also the only
       * address it will send from. Kept separate from the total so the send path
       * caps by a figure it can attribute to that address. Absent when the
       * figure did not come from a per-address read: a cache row states one
       * number and not which address it belongs to.
       */
      spendable?: number;
    };
    arkade: {
      /** Confirmed onchain to boarding, awaiting arkade auto-sweep. */
      boardingConfirmed: number;
      /** In mempool to boarding, awaiting onchain confirmation. */
      boardingUnconfirmed: number;
      /** Recoverable Arkade sats awaiting automatic wallet refresh. */
      recoverable?: number;
    };
  };
};

export const EMPTY_BITCOIN_BALANCE: BitcoinBalance = {
  total: 0,
  byChannel: { onchain: 0, arkade: 0, lightning: 0 },
  detail: {
    onchain: { confirmed: 0, unconfirmed: 0, txCount: 0 },
    arkade: { boardingConfirmed: 0, boardingUnconfirmed: 0, recoverable: 0 },
  },
};

function parseArkadeSats(value: string | number | undefined): number {
  const sats = Number(value ?? 0);
  return Number.isFinite(sats) && sats > 0 ? Math.trunc(sats) : 0;
}

function arkadeTotalFromSummary(summary: ArkadeWalletSummary): number {
  // Headline ≡ off-chain send gate. The send path (BitcoinSendScreen
  // `spendable`) sums settled + tooFresh + preconfirmed: all three fund an
  // offchain send, and the SDK's coin selection takes them. `tooFresh` are
  // settled VTXOs still inside the settlement min-expiry gap — spendable
  // offchain, just not accepted as an on-chain settlement input. The
  // settleable cap for on-chain exits stays separate in the send screen.
  // (The 31,597-vs-1,006 incident was spent VTXOs leaking into
  // `available` — fixed at the source in walletSummary + vtxoPagination;
  // tooFresh is genuinely spendable and belongs in the headline.)
  return (
    parseArkadeSats(summary.balanceAvailableSats) + parseArkadeSats(summary.balanceTooFreshSats)
  );
}

export function balanceFromArkadeSummary(summary: ArkadeWalletSummary): BitcoinBalance {
  const arkade = arkadeTotalFromSummary(summary);
  const boardingConfirmed = parseArkadeSats(summary.balanceBoardingConfirmedSats);
  const boardingUnconfirmed = parseArkadeSats(summary.balanceBoardingUnconfirmedSats);
  const recoverable = parseArkadeSats(summary.balanceRecoverableSats);
  return {
    total: arkade,
    byChannel: { onchain: 0, arkade, lightning: 0 },
    detail: {
      onchain: { confirmed: 0, unconfirmed: 0, txCount: 0 },
      arkade: { boardingConfirmed, boardingUnconfirmed, recoverable },
    },
  };
}
