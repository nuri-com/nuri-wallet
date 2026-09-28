const normalizeAddress = (value?: string | null): string | null => {
  if (!value) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed.toLowerCase() : null;
};

// The euro and dollar rails are the SAME address holding two tokens, so the
// address alone cannot key their histories apart — one list would overwrite the
// other in the cache. Euro keeps the unsuffixed key it has always had; every
// other token gets its own.
const tokenSuffix = (fiatCode?: string | null): string => {
  const code = (fiatCode ?? "").trim().toLowerCase();
  return !code || code === "eur" ? "" : `|${code}`;
};

export const getWalletTransactionsCacheKey = (
  primary?: string | null,
  secondary?: string | null,
  fallback?: string | null,
  fiatCode?: string | null,
) => {
  const primaryKey = normalizeAddress(primary ?? fallback) ?? "";
  const secondaryKey = normalizeAddress(secondary) ?? "";
  if (!primaryKey && !secondaryKey) return "";
  return `${primaryKey}|${secondaryKey}${tokenSuffix(fiatCode)}`;
};

export const getWalletTransactionsDbCacheKey = (
  primary?: string | null,
  secondary?: string | null,
  fallback?: string | null,
  fiatCode?: string | null,
) => {
  const key = getWalletTransactionsCacheKey(primary, secondary, fallback, fiatCode);
  return key ? `wallet:${key}` : "";
};

export const getCardTransactionsCacheKey = (safe?: string | null) => {
  const key = (safe ?? "").trim().toLowerCase();
  return key ? `card:${key}` : "";
};

export const getBitcoinTransactionsCacheKey = (address?: string | null) => {
  const key = (address ?? "").trim().toLowerCase();
  return key ? `btc:${key}` : "";
};

export const getBitcoinTransactionsMetaCacheKey = (address?: string | null) => {
  const key = (address ?? "").trim().toLowerCase();
  return key ? `btcmeta:${key}` : "";
};

// The Arkade rail's own history. Keyed by the boarding address like the legacy
// rows — it identifies the same wallet — under its own prefix so the two lists
// never overwrite each other.
export const getArkadeTransactionsCacheKey = (address?: string | null) => {
  const key = (address ?? "").trim().toLowerCase();
  return key ? `ark:${key}` : "";
};
