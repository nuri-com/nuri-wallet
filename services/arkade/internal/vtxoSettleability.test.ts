import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCacheValue: vi.fn(),
  setCacheValue: vi.fn(),
}));

vi.mock("../../balance/TransactionCacheService", () => ({
  getCacheValue: mocks.getCacheValue,
  setCacheValue: mocks.setCacheValue,
}));

import {
  adoptServerSettlementMinExpiryGapSeconds,
  getSettlementMinExpiryGapMs,
  isVtxoSettleable,
  loadSettlementMinExpiryGapMs,
  partitionVtxosBySettleability,
  rememberSettlementMinExpiryGapMs,
  resetSettlementMinExpiryGapForTests,
} from "./vtxoSettleability";

const NOW = 1_800_000_000_000;
const GAP_MS = 695 * 3_600_000; // the mainnet ~29d gap, as the server reports it

const settled = (value: number, batchExpiry: number) => ({
  value,
  virtualStatus: { state: "settled", batchExpiry },
});
const preconfirmed = (value: number) => ({
  value,
  virtualStatus: { state: "preconfirmed" },
});

beforeEach(() => {
  resetSettlementMinExpiryGapForTests();
  mocks.getCacheValue.mockReset();
  mocks.setCacheValue.mockReset();
});

describe("isVtxoSettleable", () => {
  it("keeps every unspent vtxo while the gap is unknown", () => {
    expect(isVtxoSettleable(settled(1000, NOW + GAP_MS * 2), null, NOW)).toBe(true);
  });

  it("accepts a vtxo exactly at the gap boundary and refuses one past it", () => {
    expect(isVtxoSettleable(settled(1000, NOW + GAP_MS), GAP_MS, NOW)).toBe(true);
    expect(isVtxoSettleable(settled(1000, NOW + GAP_MS + 1), GAP_MS, NOW)).toBe(false);
  });

  it("never settles a preconfirmed vtxo, gap or not", () => {
    expect(isVtxoSettleable(preconfirmed(1000), null, NOW)).toBe(false);
    expect(isVtxoSettleable(preconfirmed(1000), GAP_MS, NOW)).toBe(false);
  });

  it("ignores spent vtxos", () => {
    expect(isVtxoSettleable({ ...settled(1000, NOW), isSpent: true }, GAP_MS, NOW)).toBe(false);
  });

  it("reads a seconds-valued expiry as seconds, not as a long-past ms one", () => {
    // The indexer speaks seconds; unnormalized it would look far inside the gap
    // and every fresh vtxo would sail through as settleable.
    const freshSeconds = Math.trunc((NOW + GAP_MS + 3_600_000) / 1000);
    const oldSeconds = Math.trunc((NOW + GAP_MS - 3_600_000) / 1000);
    expect(
      isVtxoSettleable(
        { value: 1, virtualStatus: { state: "settled", batchExpiry: freshSeconds } },
        GAP_MS,
        NOW,
      ),
    ).toBe(false);
    expect(
      isVtxoSettleable(
        { value: 1, virtualStatus: { state: "settled", batchExpiry: oldSeconds } },
        GAP_MS,
        NOW,
      ),
    ).toBe(true);
  });

  it("keeps a vtxo with no batch expiry to judge (recoverable/swept)", () => {
    expect(isVtxoSettleable({ value: 1000, virtualStatus: { state: "swept" } }, GAP_MS, NOW)).toBe(
      true,
    );
  });
});

describe("partitionVtxosBySettleability", () => {
  it("splits a mixed set and totals only the too-fresh sats", () => {
    const old = settled(5000, NOW + GAP_MS - 60_000);
    const fresh = settled(24_728, NOW + GAP_MS + 3_600_000);
    const finalizing = preconfirmed(1234);

    const result = partitionVtxosBySettleability([old, fresh, finalizing], GAP_MS, NOW);

    expect(result.settleable).toEqual([old]);
    expect(result.tooFresh).toEqual([fresh]);
    // The preconfirmed one is already shown as finalizing — it must not be
    // counted a second time as too fresh.
    expect(result.tooFreshSats).toBe(24_728);
  });

  it("keeps fresh change pending while older VTXOs remain available", () => {
    const liveGapMs = 2_505_216_000;
    const result = partitionVtxosBySettleability(
      [
        settled(13_331, NOW + liveGapMs - 60_000),
        settled(10_245, NOW + liveGapMs),
        settled(36_087, NOW + liveGapMs + 3_600_000),
      ],
      liveGapMs,
      NOW,
    );

    expect(result.settleable.reduce((sum, vtxo) => sum + vtxo.value, 0)).toBe(23_576);
    expect(result.tooFreshSats).toBe(36_087);
  });

  it("leaves the whole set settleable while the gap is unknown", () => {
    const vtxos = [settled(5000, NOW + GAP_MS * 3), settled(1000, NOW)];
    const result = partitionVtxosBySettleability(vtxos, null, NOW);
    expect(result.settleable).toHaveLength(2);
    expect(result.tooFresh).toHaveLength(0);
    expect(result.tooFreshSats).toBe(0);
  });

  it("drops spent vtxos from both sides", () => {
    const result = partitionVtxosBySettleability(
      [{ ...settled(5000, NOW), isSpent: true }],
      GAP_MS,
      NOW,
    );
    expect(result.settleable).toHaveLength(0);
    expect(result.tooFresh).toHaveLength(0);
  });

  it("survives a missing or malformed vtxo list", () => {
    expect(partitionVtxosBySettleability(null, GAP_MS, NOW).settleable).toEqual([]);
    expect(partitionVtxosBySettleability(undefined, GAP_MS, NOW).tooFreshSats).toBe(0);
  });
});

describe("learned gap", () => {
  it("persists what the server reported and answers with it", async () => {
    await rememberSettlementMinExpiryGapMs(GAP_MS);
    expect(getSettlementMinExpiryGapMs()).toBe(GAP_MS);
    expect(mocks.setCacheValue).toHaveBeenCalledWith(
      "arkade:settlement:min-expiry-gap-ms:v1",
      GAP_MS,
    );
  });

  it("ignores a nonsense gap", async () => {
    await rememberSettlementMinExpiryGapMs(0);
    await rememberSettlementMinExpiryGapMs(Number.NaN);
    expect(getSettlementMinExpiryGapMs()).toBeNull();
    expect(mocks.setCacheValue).not.toHaveBeenCalled();
  });

  it("loads the stored gap once per session", async () => {
    mocks.getCacheValue.mockResolvedValue(GAP_MS);
    expect(await loadSettlementMinExpiryGapMs()).toBe(GAP_MS);
    expect(await loadSettlementMinExpiryGapMs()).toBe(GAP_MS);
    expect(mocks.getCacheValue).toHaveBeenCalledTimes(1);
  });

  it("stays unknown when storage fails", async () => {
    mocks.getCacheValue.mockRejectedValue(new Error("storage gone"));
    expect(await loadSettlementMinExpiryGapMs()).toBeNull();
  });
});

describe("server-published gap", () => {
  // nuri-server-musig2-v4-arkade#75: seconds on /arkade/info and /health.
  const ARKD_SECONDS = 2_505_216; // 695h53m36s

  it("converts the published seconds to milliseconds", async () => {
    expect(await adoptServerSettlementMinExpiryGapSeconds(ARKD_SECONDS)).toBe(ARKD_SECONDS * 1000);
    expect(getSettlementMinExpiryGapMs()).toBe(ARKD_SECONDS * 1000);
  });

  it("accepts the value as a numeric string", async () => {
    expect(await adoptServerSettlementMinExpiryGapSeconds(String(ARKD_SECONDS))).toBe(
      ARKD_SECONDS * 1000,
    );
  });

  it("leaves the gap unknown when the deployment publishes null or nonsense", async () => {
    for (const raw of [undefined, null, "", 0, -5, 1.5 * 0, "nope"]) {
      expect(await adoptServerSettlementMinExpiryGapSeconds(raw)).toBeNull();
    }
    expect(getSettlementMinExpiryGapMs()).toBeNull();
  });
});
