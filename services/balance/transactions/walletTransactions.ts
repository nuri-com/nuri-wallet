import type { WalletTransactionRow } from "../../../types/wallet";
import { setCacheValue } from "../TransactionCacheService";
import { getWalletTransactionsDbCacheKey } from "./cacheKeys";
import { mergeWalletTransactions } from "./mergeWalletTransactions";
import { EURC_SCAN_TOKEN, fetchOnchainWalletTransfers, type OnchainScanToken } from "./onchainScan";

export type WalletTransactionsFetchParams = {
  primaryAddress?: string | null;
  secondaryAddress?: string | null;
  address?: string | null;
  /**
   * Which token's transfers this history is. The wallet holds euro and dollar on
   * the same address, so without it both rails read the same list. Defaults to
   * euro.
   */
  token?: OnchainScanToken;
};

export type WalletTransactionsFetchResult = {
  orders: WalletTransactionRow[] | null;
  pendingWalletFiat: number;
  error: string | null;
  authRequired: boolean;
};

export async function fetchWalletTransactions(
  params: WalletTransactionsFetchParams,
): Promise<WalletTransactionsFetchResult> {
  const rawWalletAddrs = [
    params.primaryAddress ?? params.address ?? null,
    params.secondaryAddress ?? null,
  ]
    .map((a) => (a ? String(a).trim().toLowerCase() : null))
    .filter((a): a is string => !!a);
  const walletAddrs = Array.from(new Set(rawWalletAddrs));

  const token = params.token ?? EURC_SCAN_TOKEN;
  const onchainRows = await fetchOnchainWalletTransfers({
    walletAddrs,
    selfFilterAddrs: walletAddrs,
    token,
  });

  const merged = mergeWalletTransactions({
    onchain: onchainRows,
  });

  console.log("[WalletTransactions] fetchWalletTransactions done", {
    total: merged.length,
    onchainNew: onchainRows.length,
  });

  const writeCacheKey = getWalletTransactionsDbCacheKey(
    params.primaryAddress ?? params.address,
    params.secondaryAddress,
    params.address,
    token.fiatCode,
  );
  if (writeCacheKey) {
    try {
      await setCacheValue(writeCacheKey, merged);
    } catch {}
  }

  return {
    orders: merged,
    pendingWalletFiat: 0,
    error: null,
    authRequired: false,
  };
}
