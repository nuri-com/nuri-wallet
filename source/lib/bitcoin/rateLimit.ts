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
