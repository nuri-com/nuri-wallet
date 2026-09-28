import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  BOARDING_UTXO_CACHE_TTL_MS,
  readBoardingUtxosShared,
  resetBoardingUtxoCache,
} from "./boardingUtxoCache";

vi.mock("./logging", () => ({
  logArkadeWalletSignTrace: vi.fn(),
}));

type Utxo = { txid: string };

const walletWith = (impl: () => Promise<Utxo[]>) => ({ getBoardingUtxos: vi.fn(impl) });

beforeEach(() => {
  resetBoardingUtxoCache("test");
  vi.useRealTimers();
});

describe("readBoardingUtxosShared", () => {
  it("serves a second caller from cache instead of a second Esplora round-trip", async () => {
    // The whole point: one boarding read is one HTTP request PER boarding
    // address, and the unlock monitor used to make this call twice per tick.
    const wallet = walletWith(async () => [{ txid: "a" }]);

    const first = await readBoardingUtxosShared(wallet, "owner-1");
    const second = await readBoardingUtxosShared(wallet, "owner-1");

    expect(first).toEqual([{ txid: "a" }]);
    expect(second).toEqual([{ txid: "a" }]);
    expect(wallet.getBoardingUtxos).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent callers onto one request", async () => {
    let release: (rows: Utxo[]) => void = () => {};
    const wallet = walletWith(
      () =>
        new Promise<Utxo[]>((resolve) => {
          release = resolve;
        }),
    );

    const a = readBoardingUtxosShared(wallet, "owner-1");
    // Let the first call install its in-flight promise before the second asks,
    // which is the real ordering: separate timers, milliseconds apart.
    await Promise.resolve();
    const b = readBoardingUtxosShared(wallet, "owner-1");
    release([{ txid: "a" }]);

    expect(await a).toEqual([{ txid: "a" }]);
    expect(await b).toEqual([{ txid: "a" }]);
    expect(wallet.getBoardingUtxos).toHaveBeenCalledTimes(1);
  });

  it("re-reads once the window has passed", async () => {
    const wallet = walletWith(async () => [{ txid: "a" }]);
    const nowSpy = vi.spyOn(Date, "now");

    nowSpy.mockReturnValue(1_000);
    await readBoardingUtxosShared(wallet, "owner-1");
    nowSpy.mockReturnValue(1_000 + BOARDING_UTXO_CACHE_TTL_MS + 1);
    await readBoardingUtxosShared(wallet, "owner-1");

    expect(wallet.getBoardingUtxos).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it("forceFresh bypasses the cache — the sweep signs over a live read", async () => {
    const wallet = walletWith(async () => [{ txid: "a" }]);

    await readBoardingUtxosShared(wallet, "owner-1");
    await readBoardingUtxosShared(wallet, "owner-1", { forceFresh: true });

    expect(wallet.getBoardingUtxos).toHaveBeenCalledTimes(2);
  });

  it("never serves another wallet's UTXOs", async () => {
    const wallet = walletWith(async () => [{ txid: "a" }]);

    await readBoardingUtxosShared(wallet, "owner-1");
    await readBoardingUtxosShared(wallet, "owner-2");

    expect(wallet.getBoardingUtxos).toHaveBeenCalledTimes(2);
  });

  it("a failed read is not cached as an empty wallet", async () => {
    // An empty boarding list is indistinguishable from "owns nothing", which is
    // exactly what strands a sweep. A throw must not install that.
    let attempt = 0;
    const wallet = walletWith(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("Network request failed: GET mempool.space");
      return [{ txid: "a" }];
    });

    await expect(readBoardingUtxosShared(wallet, "owner-1")).rejects.toThrow(
      "Network request failed",
    );
    await expect(readBoardingUtxosShared(wallet, "owner-1")).resolves.toEqual([{ txid: "a" }]);
    expect(wallet.getBoardingUtxos).toHaveBeenCalledTimes(2);
  });

  it("reset drops the cache", async () => {
    const wallet = walletWith(async () => [{ txid: "a" }]);

    await readBoardingUtxosShared(wallet, "owner-1");
    resetBoardingUtxoCache("identity_changed");
    await readBoardingUtxosShared(wallet, "owner-1");

    expect(wallet.getBoardingUtxos).toHaveBeenCalledTimes(2);
  });
});
