import { describe, expect, it } from "vitest";
import { getWalletTransactionsCacheKey, getWalletTransactionsDbCacheKey } from "./cacheKeys";

// The euro and dollar rails are ONE address holding two tokens. Keyed by address
// alone, whichever list was fetched last overwrote the other — the Dollar rail
// then rendered euro rows out of the cache.
describe("wallet transaction cache keys", () => {
  const ADDR = "0xAbC0000000000000000000000000000000000001";

  it("keeps euro on the key it has always had", () => {
    expect(getWalletTransactionsCacheKey(ADDR, null, null, "EUR")).toBe(
      getWalletTransactionsCacheKey(ADDR, null, null),
    );
  });

  it("gives another token its own key", () => {
    const eur = getWalletTransactionsDbCacheKey(ADDR, null, null, "EUR");
    const usd = getWalletTransactionsDbCacheKey(ADDR, null, null, "USD");
    expect(usd).not.toBe(eur);
    expect(usd).toContain("usd");
  });

  it("has no key without an address, token or not", () => {
    expect(getWalletTransactionsDbCacheKey(null, null, null, "USD")).toBe("");
  });
});
