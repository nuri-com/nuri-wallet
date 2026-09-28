// Is a wallet-summary failure the transient kind that should arm the backoff?
//
// A leaf module on purpose: `walletSummary.ts` reaches `@arkade-os/sdk`, which
// vitest cannot transform, so the rule cannot be tested where it is used.
//
// The rule matters because the backoff is the app's only brake on its own
// request rate. It failed to engage on the PWA for a whole class of failure:
// mempool.space's 429 has no `Access-Control-Allow-Origin`, so the browser
// rejects the response before any code sees a status, and the SDK reports
// `Network request failed: GET https://mempool.space/...`. Nothing in the
// original patterns matched that, so the app kept polling at full rate while
// rate-limited and held itself in the limit.

/** A rate-limit, or a failure indistinguishable from one. */
export function isRateLimitErrorMessage(message: string): boolean {
  if (!message) return false;
  return (
    // Explicit, when a status or body actually reaches us (native).
    /\b429\b|rate[ _-]?limit|too many requests/i.test(message) ||
    // mempool.space's 429 bodies are often empty, so the SDK's text is just
    // "Failed to fetch UTXOs:" with no status hint.
    /failed to fetch utxos/i.test(message) ||
    // The PWA shape: a CORS-less error response the browser refuses, wrapped by
    // the SDK's FetchError. This is the one that was missing.
    /network request failed/i.test(message) ||
    // A CSP-blocked host will not start answering on retry either, so treat it
    // as a reason to back off rather than to spin.
    /refused to connect|content security policy/i.test(message)
  );
}

export function isWalletSummaryTimeoutErrorMessage(message: string): boolean {
  return /wallet_summary_[a-z_]+ timeout after \d+ms/i.test(message);
}

export function isTransientWalletSummaryErrorMessage(message: string): boolean {
  return isRateLimitErrorMessage(message) || isWalletSummaryTimeoutErrorMessage(message);
}
