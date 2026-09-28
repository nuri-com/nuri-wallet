export type ReconciledBalanceSource =
  | "live_api_onchain"
  | "live_api"
  | "onchain_fallback"
  | "cache_fallback"
  | "preserved";

export type ReconciledBalance = {
  source: ReconciledBalanceSource;
  settledAmount: number;
  totalAmount: number;
  pendingAmount: number;
  apiPendingAmount: number;
  deltaPendingAmount: number;
  onchainAmount: number | null;
  isFallback: boolean;
};

type BalanceInput = number | null | undefined;

const normalizeAmount = (value: BalanceInput): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, value);
};

export const isFallbackBalanceSource = (
  source: ReconciledBalanceSource | null | undefined,
): boolean =>
  source === "onchain_fallback" || source === "cache_fallback" || source === "preserved";

export const suppressOptimisticPendingForSource = (
  source: ReconciledBalanceSource | null | undefined,
): boolean =>
  source === "onchain_fallback" || source === "cache_fallback" || source === "preserved";

export const reconcileBalance = (params: {
  apiAmount?: BalanceInput;
  apiPending?: BalanceInput;
  onchainAmount?: BalanceInput;
  fallbackAmount?: BalanceInput;
  fallbackSource?: Extract<
    ReconciledBalanceSource,
    "onchain_fallback" | "cache_fallback" | "preserved"
  >;
}): ReconciledBalance => {
  const apiAmount = normalizeAmount(params.apiAmount);
  const apiPendingAmount = normalizeAmount(params.apiPending) ?? 0;
  const onchainAmount = normalizeAmount(params.onchainAmount);

  if (apiAmount !== null) {
    if (onchainAmount !== null) {
      const settledAmount = Math.min(apiAmount, onchainAmount);
      const deltaPendingAmount = Math.max(0, onchainAmount - settledAmount);
      return {
        source: "live_api_onchain",
        settledAmount,
        totalAmount: onchainAmount,
        pendingAmount: deltaPendingAmount,
        apiPendingAmount,
        deltaPendingAmount,
        onchainAmount,
        isFallback: false,
      };
    }

    return {
      source: "live_api",
      settledAmount: apiAmount,
      totalAmount: apiAmount,
      pendingAmount: apiPendingAmount,
      apiPendingAmount,
      deltaPendingAmount: 0,
      onchainAmount: null,
      isFallback: false,
    };
  }

  const fallbackAmount = normalizeAmount(params.fallbackAmount) ?? 0;
  const fallbackSource = params.fallbackSource ?? "preserved";

  return {
    source: fallbackSource,
    settledAmount: fallbackAmount,
    totalAmount: fallbackAmount,
    pendingAmount: 0,
    apiPendingAmount: 0,
    deltaPendingAmount: 0,
    onchainAmount: fallbackSource === "onchain_fallback" ? fallbackAmount : onchainAmount,
    isFallback: true,
  };
};
