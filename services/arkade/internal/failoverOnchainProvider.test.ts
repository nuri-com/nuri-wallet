import { describe, expect, it, vi } from "vitest";

import { FailoverOnchainProvider } from "./failoverOnchainProvider";

vi.mock("./logging", () => ({
  emitTrace: vi.fn(),
}));

type AnyProvider = Record<string, ReturnType<typeof vi.fn>>;

const provider = (overrides: Partial<AnyProvider> = {}): AnyProvider => ({
  getCoins: vi.fn(async () => []),
  getFeeRate: vi.fn(async () => 1),
  getTxOutspends: vi.fn(async () => []),
  getTransactions: vi.fn(async () => []),
  getRawTransaction: vi.fn(async () => new Uint8Array()),
  getTxStatus: vi.fn(async () => ({ confirmed: false })),
  getChainTip: vi.fn(async () => ({ height: 1, time: 1, hash: "h" })),
  broadcastTransaction: vi.fn(async () => "txid"),
  watchAddresses: vi.fn(async () => () => {}),
  ...overrides,
});

const build = (primary: AnyProvider, fallback: AnyProvider) =>
  new FailoverOnchainProvider(
    primary as never,
    fallback as never,
    "mempool.space",
    "blockstream.info",
  );

describe("FailoverOnchainProvider", () => {
  it("uses the primary while it answers", async () => {
    const primary = provider({ getCoins: vi.fn(async () => [{ txid: "a" }] as never) });
    const fallback = provider();

    await expect(build(primary, fallback).getCoins("addr")).resolves.toEqual([{ txid: "a" }]);
    expect(fallback.getCoins).not.toHaveBeenCalled();
  });

  it("falls over to the second Esplora when the primary throws", async () => {
    // The real failure: mempool answers the boot probe, then rate-limits. The
    // browser rejects the 429 for want of CORS, so the SDK throws this.
    const primary = provider({
      getCoins: vi.fn(async () => {
        throw new Error("Network request failed: GET https://mempool.space/api/address/x/utxo");
      }),
    });
    const fallback = provider({ getCoins: vi.fn(async () => [{ txid: "b" }] as never) });

    await expect(build(primary, fallback).getCoins("addr")).resolves.toEqual([{ txid: "b" }]);
  });

  it("stays on the host that answered rather than paying the dead one every call", async () => {
    const primary = provider({
      getCoins: vi.fn(async () => {
        throw new Error("Network request failed");
      }),
    });
    const fallback = provider({ getCoins: vi.fn(async () => [] as never) });
    const subject = build(primary, fallback);

    await subject.getCoins("addr");
    await subject.getCoins("addr");
    await subject.getChainTip();

    expect(primary.getCoins).toHaveBeenCalledTimes(1);
    expect(fallback.getCoins).toHaveBeenCalledTimes(2);
    expect(fallback.getChainTip).toHaveBeenCalledTimes(1);
    expect(primary.getChainTip).not.toHaveBeenCalled();
    expect(subject.activeLabel).toBe("blockstream.info");
  });

  it("surfaces the primary's error when BOTH hosts refuse", async () => {
    const primary = provider({
      getCoins: vi.fn(async () => {
        throw new Error("primary down");
      }),
    });
    const fallback = provider({
      getCoins: vi.fn(async () => {
        throw new Error("fallback down");
      }),
    });

    await expect(build(primary, fallback).getCoins("addr")).rejects.toThrow("primary down");
  });

  // Review finding (#1433): `read()` used to consult mutable active/standby
  // state AFTER its awaits and then TOGGLE the preference. Two concurrent
  // primary failures could therefore flip it twice and land back on the dead
  // host, or the second call could observe the first call's flip and "fail over"
  // to the primary it had just seen fail.
  it("two concurrent failures leave the preference on the host that answered", async () => {
    let failPrimary = true;
    const primary = provider({
      getCoins: vi.fn(async () => {
        if (failPrimary) throw new Error("Network request failed");
        return [{ txid: "primary" }] as never;
      }),
    });
    const fallback = provider({ getCoins: vi.fn(async () => [{ txid: "fallback" }] as never) });
    const subject = build(primary, fallback);

    const [a, b] = await Promise.all([subject.getCoins("a"), subject.getCoins("b")]);

    expect(a).toEqual([{ txid: "fallback" }]);
    expect(b).toEqual([{ txid: "fallback" }]);
    // The bug: a double toggle would read "mempool.space" here, i.e. right back
    // onto the host that just failed both calls.
    expect(subject.activeLabel).toBe("blockstream.info");

    // And the next read must go to the working host, not the dead one.
    failPrimary = false;
    await expect(subject.getCoins("c")).resolves.toEqual([{ txid: "fallback" }]);
  });

  it("a concurrent call never retries the host the other call just saw fail", async () => {
    // Both calls start while the primary is preferred. Neither may end up
    // treating the primary as its fallback target.
    const primary = provider({
      getCoins: vi.fn(async () => {
        throw new Error("Network request failed");
      }),
    });
    const fallback = provider({ getCoins: vi.fn(async () => [] as never) });
    const subject = build(primary, fallback);

    await Promise.all([subject.getCoins("a"), subject.getCoins("b")]);

    // Once each, as the first attempt — never as a retry target.
    expect(primary.getCoins).toHaveBeenCalledTimes(2);
    expect(fallback.getCoins).toHaveBeenCalledTimes(2);
  });

  it("does NOT fail over a broadcast", async () => {
    // Re-submitting the same transaction to a second host after an ambiguous
    // failure is a double-broadcast risk, and the failure may be a rejection.
    const primary = provider({
      broadcastTransaction: vi.fn(async () => {
        throw new Error("rejected: min relay fee not met");
      }),
    });
    const fallback = provider();

    await expect(build(primary, fallback).broadcastTransaction("hex")).rejects.toThrow(
      "min relay fee",
    );
    expect(fallback.broadcastTransaction).not.toHaveBeenCalled();
  });

  it("covers every read on the provider interface", async () => {
    // A method left unwrapped silently keeps talking to the dead host, so this
    // asserts the whole read surface goes through the failover.
    const reads = [
      "getCoins",
      "getFeeRate",
      "getTxOutspends",
      "getTransactions",
      "getRawTransaction",
      "getTxStatus",
      "getChainTip",
    ] as const;

    for (const method of reads) {
      const primary = provider({
        [method]: vi.fn(async () => {
          throw new Error("down");
        }),
      });
      const fallback = provider();
      const subject = build(primary, fallback) as unknown as Record<
        string,
        (arg?: unknown) => Promise<unknown>
      >;

      await subject[method]("arg");
      expect(fallback[method], `${method} did not fail over`).toHaveBeenCalled();
    }
  });
});
