// Rebuilding a bitcoin balance from what was cached.
//
// The cache holds two rows — the arkade headline and the onchain rail — each
// stamped with the wallet that wrote it. Restoring is a decision, not a read: which
// rows belong to THIS wallet, and is there anything left worth showing. Kept out
// of the store (and free of its native dependencies) so that decision can be
// stated on its own and tested.
import type { BitcoinBalance } from "./balanceShape";

export type CachedBalanceRow = {
  amount?: number | null;
  address?: string | null;
} | null;

const sats = (value: number | null | undefined): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
};

const ownedBy = (row: CachedBalanceRow, owner: string | null | undefined): number => {
  const wallet = owner?.trim().toLowerCase();
  const writer = row?.address?.trim().toLowerCase();
  if (!wallet || !writer || wallet !== writer) return 0;
  return sats(row?.amount);
};

/**
 * The balance to show before the network answers, or null when there is nothing
 * this wallet can be shown.
 *
 * The two rails are restored independently, because that is what they are: the
 * headline `total` is the ARKADE figure alone (see BitcoinBalanceService) and
 * the onchain row is a number beside it, not a share of it. Either one alone is
 * enough to hydrate — a wallet spent to zero on one rail still has the other to
 * state.
 */
export function cachedBitcoinBalance(params: {
  owner: string | null | undefined;
  arkade: CachedBalanceRow;
  onchain: CachedBalanceRow;
}): BitcoinBalance | null {
  const arkade = ownedBy(params.arkade, params.owner);
  const onchain = ownedBy(params.onchain, params.owner);
  if (arkade <= 0 && onchain <= 0) return null;
  return {
    total: arkade,
    byChannel: { onchain, arkade, lightning: 0 },
    detail: {
      onchain: { confirmed: onchain, unconfirmed: 0, txCount: 0 },
      arkade: { boardingConfirmed: 0, boardingUnconfirmed: 0, recoverable: 0 },
    },
  };
}
