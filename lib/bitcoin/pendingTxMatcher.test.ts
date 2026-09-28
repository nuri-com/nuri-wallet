import { describe, expect, it } from "vitest";
import { isMatchSafeForRow, matchPendingIncomingCandidate } from "./pendingTxMatcher";

const tx = (amountSats: number, confirmed = true) => ({
  txid: "abc",
  amountSats,
  confirmed,
  blockTime: 1,
});

describe("isMatchSafeForRow", () => {
  it("rejects when there is no match", () => {
    expect(isMatchSafeForRow({ expectedSats: 25603, match: null })).toBe(false);
  });

  it("clears when the matched amount is within tolerance", () => {
    // #688: a real Mercuryo boarding tx differs from the purchase by only network/sweep fee.
    expect(isMatchSafeForRow({ expectedSats: 25603, match: tx(25600) })).toBe(true);
  });

  it("does NOT clear from an unrelated tx whose amount is outside tolerance", () => {
    // This is the matcher's single-candidate fallback that used to delete the wrong row,
    // including the arkade case where the row sits on the scanned boarding address.
    expect(isMatchSafeForRow({ expectedSats: 25603, match: tx(1000) })).toBe(false);
  });

  it("does NOT clear when the expected amount is unknown (defers to TTL)", () => {
    expect(isMatchSafeForRow({ expectedSats: 0, match: tx(25603) })).toBe(false);
  });
});

describe("matchPendingIncomingCandidate", () => {
  const candidate = (
    txid: string,
    amountSats: number,
    blockTime: number | null,
    confirmed = true,
  ) => ({
    txid,
    amountSats,
    confirmed,
    blockTime,
  });

  it("prefers an exact amount match inside the created-at time scope", () => {
    const createdAtMs = 1_000_000;
    const exact = candidate("exact", 25_603, 1_000);
    const tooOld = candidate("old", 25_603, 800);

    expect(
      matchPendingIncomingCandidate({
        expectedSats: 25_603,
        createdAtMs,
        candidates: [tooOld, exact],
      }),
    ).toBe(exact);
  });

  it("uses amount tolerance before loose single-candidate fallback", () => {
    const near = candidate("near", 25_100, null, false);
    const far = candidate("far", 10_000, null, false);

    expect(
      matchPendingIncomingCandidate({
        expectedSats: 25_603,
        createdAtMs: null,
        candidates: [far, near],
      }),
    ).toBe(near);
  });

  it("falls back to the nearest timed confirmed candidate when amount is unknown", () => {
    const createdAtMs = 3_600_000;
    const near = candidate("near", 1000, 3_610);
    const far = candidate("far", 2000, 7_200);

    expect(
      matchPendingIncomingCandidate({ expectedSats: 0, createdAtMs, candidates: [far, near] }),
    ).toBe(near);
  });

  it("falls back to a sole scoped candidate when amount and timing cannot decide", () => {
    const only = candidate("only", 1234, null, false);
    expect(
      matchPendingIncomingCandidate({ expectedSats: 0, createdAtMs: null, candidates: [only] }),
    ).toBe(only);
  });
});
