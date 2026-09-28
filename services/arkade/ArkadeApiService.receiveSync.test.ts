import { afterEach, describe, expect, it, vi } from "vitest";

const cacheMocks = vi.hoisted(() => ({
  getCacheValue: vi.fn(async () => null),
  setCacheValue: vi.fn(async () => undefined),
}));

vi.mock("../balance/TransactionCacheService", () => cacheMocks);

import {
  type ArkadeReceiveOwner,
  arkadeReceiveSync,
  ensureSettlementMinExpiryGapMs,
} from "./ArkadeApiService";
import { resetSettlementMinExpiryGapForTests } from "./internal/vtxoSettleability";

// #738: arkadeReceiveSync must single-flight per owner so the several receive
// flows that fire close together share one request instead of a sync storm.

const ownerA: ArkadeReceiveOwner = { credIdB64u: "credA", clientPublicKey33Hex: "pubA" };
const ownerB: ArkadeReceiveOwner = { credIdB64u: "credB", clientPublicKey33Hex: "pubB" };

const okResponse = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

// fetch mock gated on a promise so concurrent callers genuinely overlap in-flight.
function gatedFetch(make: () => Promise<Response>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const fetchMock = vi.fn(async () => {
    await gate;
    return make();
  });
  return { fetchMock, release };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetSettlementMinExpiryGapForTests();
  cacheMocks.getCacheValue.mockClear();
  cacheMocks.setCacheValue.mockClear();
});

describe("settlement gap bootstrap", () => {
  it("single-flights public health and remembers its operator value", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({ ok: true, settlement_min_expiry_gap_seconds: 2_505_216 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const [first, second] = await Promise.all([
      ensureSettlementMinExpiryGapMs(),
      ensureSettlementMinExpiryGapMs(),
    ]);

    expect(first).toBe(2_505_216_000);
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await ensureSettlementMinExpiryGapMs()).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("arkadeReceiveSync single-flight (#738)", () => {
  it("collapses concurrent same-owner calls into one request, then refetches after settle", async () => {
    const { fetchMock, release } = gatedFetch(async () => okResponse({ restores: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const p1 = arkadeReceiveSync(ownerA);
    const p2 = arkadeReceiveSync(ownerA);
    const p3 = arkadeReceiveSync(ownerA);
    release();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(fetchMock).toHaveBeenCalledTimes(1); // one network call for the whole burst
    expect(r1).toBe(r2); // shared promise -> identical result object
    expect(r2).toBe(r3);

    // cleared on success -> a later call hits the network again (no stale cache)
    const second = gatedFetch(async () => okResponse({ restores: [] }));
    vi.stubGlobal("fetch", second.fetchMock);
    const p4 = arkadeReceiveSync(ownerA);
    second.release();
    await p4;
    expect(second.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not collapse different owners into one request", async () => {
    const { fetchMock, release } = gatedFetch(async () => okResponse({ restores: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const pA = arkadeReceiveSync(ownerA);
    const pB = arkadeReceiveSync(ownerB);
    release();
    await Promise.all([pA, pB]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("propagates failure to every waiter and clears in-flight so the next call retries", async () => {
    const { fetchMock, release } = gatedFetch(async () => {
      throw new Error("boom");
    });
    vi.stubGlobal("fetch", fetchMock);

    const p1 = arkadeReceiveSync(ownerA);
    const p2 = arkadeReceiveSync(ownerA);
    release();
    await expect(p1).rejects.toThrow("boom");
    await expect(p2).rejects.toThrow("boom");
    expect(fetchMock).toHaveBeenCalledTimes(1); // both shared the one failing request

    // cleared in finally -> retry actually hits the network, not a cached rejection
    const ok = vi.fn(async () => okResponse({ restores: [] }));
    vi.stubGlobal("fetch", ok);
    await arkadeReceiveSync(ownerA);
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
