import { describe, expect, it } from "vitest";

import {
  isRateLimitErrorMessage,
  isTransientWalletSummaryErrorMessage,
} from "./walletSummaryErrors";

describe("isRateLimitErrorMessage", () => {
  // The regression this fixes. mempool.space's 429 carries no
  // Access-Control-Allow-Origin, so the browser rejects the response before any
  // code sees a status and the SDK reports only this. It matched nothing, so
  // the 30s backoff never armed and the app kept hammering a host that was
  // already rate-limiting it.
  it("matches the PWA's CORS-less 429, which arrives as a FetchError", () => {
    expect(
      isRateLimitErrorMessage(
        "Network request failed: GET https://mempool.space/api/address/bc1paxc0/utxo",
      ),
    ).toBe(true);
  });

  it("matches a CSP-blocked host", () => {
    expect(
      isRateLimitErrorMessage(
        "Refused to connect to https://blockstream.info/api because it does not appear in the connect-src directive of the Content Security Policy",
      ),
    ).toBe(true);
  });

  it("still matches the shapes it always did", () => {
    expect(isRateLimitErrorMessage("HTTP 429")).toBe(true);
    expect(isRateLimitErrorMessage("Too Many Requests")).toBe(true);
    expect(isRateLimitErrorMessage("rate-limited by upstream")).toBe(true);
    expect(isRateLimitErrorMessage("Failed to fetch UTXOs:")).toBe(true);
  });

  it("does not match a real, non-transient failure", () => {
    // Over-matching is the opposite failure: it would silence errors that need
    // a retry now, not in 30 seconds.
    expect(isRateLimitErrorMessage("")).toBe(false);
    expect(isRateLimitErrorMessage("wallet_vtxos_failed err=invalid contract")).toBe(false);
    expect(isRateLimitErrorMessage("Insufficient funds")).toBe(false);
    expect(isRateLimitErrorMessage("AddressMismatch: solver lockup address does not match")).toBe(
      false,
    );
    expect(isRateLimitErrorMessage("arkade swap repository owner invalid")).toBe(false);
  });
});

describe("isTransientWalletSummaryErrorMessage", () => {
  it("covers the summary's own timeouts", () => {
    expect(
      isTransientWalletSummaryErrorMessage("wallet_summary_boarding_utxos timeout after 8000ms"),
    ).toBe(true);
  });

  it("covers the rate-limit class", () => {
    expect(isTransientWalletSummaryErrorMessage("Network request failed: GET https://x/y")).toBe(
      true,
    );
  });

  it("leaves a genuine error alone", () => {
    expect(isTransientWalletSummaryErrorMessage("recovery_default_wallet_missing")).toBe(false);
  });
});
