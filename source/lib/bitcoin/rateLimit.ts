// Reading a failed history fetch: was it rate limited, or is something else
// wrong? Esplora answers a burst with 429 Too Many Requests (the status text
// lands in the error message), and the Arkade indexer says the same thing in
// its own words. A rate-limited read says nothing about the history itself, so
// it must never be reported as "your history failed" or wipe the rows already
// shown.
const RATE_LIMIT_PATTERNS = [
  /\b429\b/,
  /too many requests/i,
  /rate[ -]?limit(ed|ing)?/i,
  /cloudflare_1015/i,
];

export function isRateLimitError(message: string | null | undefined): boolean {
  const text = String(message || "").trim();
  if (!text) return false;
  return RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * The copy key the Bitcoin activity list shows for a failed history read.
 * Never the error text itself: provider and network messages ("Failed to
 * fetch transactions: Not Found") are not for users (#1383). The real error
 * stays in the console log.
 */
export function historyErrorCopyKey(
  message: string | null | undefined,
):
  | "screen.BitcoinTransactionsModal.errorRateLimited"
  | "screen.BitcoinTransactionsModal.errorLoadFailed" {
  return isRateLimitError(message)
    ? "screen.BitcoinTransactionsModal.errorRateLimited"
    : "screen.BitcoinTransactionsModal.errorLoadFailed";
}
