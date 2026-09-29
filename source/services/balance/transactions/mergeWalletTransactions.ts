import type { WalletTransactionRow } from "../../../types/wallet";

const getOnchainRowTimestamp = (o: WalletTransactionRow | null | undefined): number => {
  const iso = o?.meta?.placedAt || "";
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

export function mergeWalletTransactions(args: {
  onchain: WalletTransactionRow[];
}): WalletTransactionRow[] {
  const { onchain } = args;

  const byId = new Map<string, WalletTransactionRow>();
  for (const row of onchain) {
    const id = row?.id || JSON.stringify(row);
    if (!byId.has(id)) byId.set(id, row);
  }
  const merged = Array.from(byId.values());
  merged.sort((a, b) => getOnchainRowTimestamp(b) - getOnchainRowTimestamp(a));
  return merged;
}
