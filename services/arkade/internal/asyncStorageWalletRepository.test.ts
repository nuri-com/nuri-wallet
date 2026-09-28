// Storage round-trip fidelity, which a balance depends on.
//
// SDK 0.5 removed `WalletRepositoryImpl`, so this repository replaces it. Its
// 0.4.62 reader piped every stored vtxo through `normalizeVtxo` — filling
// `isSpent`/`isSwept`/`spentBy`/`commitmentTxIds` and reviving `expiresAt` as a
// `Date` — and converted asset amounts back to `bigint`. Dropping either makes
// cached coins read wrong: expiry comparisons against a string are meaningless
// and the wallet can show a zero balance for funds it still holds.
import { describe, expect, it } from "vitest";
import { hasTerminalSpend } from "@arkade-os/sdk";

import { AsyncStorageWalletRepository } from "./asyncStorageWalletRepository";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: async (k: string): Promise<string | null> => map.get(k) ?? null,
    setItem: async (k: string, v: string): Promise<void> => {
      map.set(k, v);
    },
    removeItem: async (k: string): Promise<void> => {
      map.delete(k);
    },
    map,
  };
}

// A funded, unspent vtxo as the SDK hands it over: byte fields present, taproot
// leaves as [controlBlock, script], an expiry, and an asset amount in bigint.
function sampleVtxo(overrides: Record<string, unknown> = {}) {
  const cb = {
    version: 1,
    internalKey: new Uint8Array(32).fill(7),
    merklePath: [] as Uint8Array[],
  };
  return {
    txid: "a".repeat(64),
    vout: 0,
    value: 1234,
    status: { confirmed: true, isLeaf: true },
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    tapTree: new Uint8Array([1, 2, 3]),
    forfeitTapLeafScript: [cb, new Uint8Array([4, 5])],
    intentTapLeafScript: [cb, new Uint8Array([6, 7])],
    assets: [{ assetId: "btc", amount: 1234n }],
    ...overrides,
  } as never;
}

describe("AsyncStorageWalletRepository round trip", () => {
  it("keeps an unspent vtxo spendable after save and reload", async () => {
    const storage = memoryStorage();
    const repo = new AsyncStorageWalletRepository(storage);
    const address = "ark1qtest";

    await repo.saveVtxos(address, [sampleVtxo()]);
    const [loaded] = await repo.getVtxos(address);

    expect(loaded).toBeDefined();
    expect(loaded.value).toBe(1234);
    // The predicate the balance uses. A vtxo that survives storage must not
    // come back looking spent.
    expect(hasTerminalSpend(loaded)).toBe(false);
  });

  it("restores the defaults normalizeVtxo used to apply", async () => {
    const storage = memoryStorage();
    const repo = new AsyncStorageWalletRepository(storage);
    const address = "ark1qtest";

    // Stored without the optional flags, as an older cache entry would be.
    await repo.saveVtxos(address, [
      sampleVtxo({ isSpent: undefined, isSwept: undefined, spentBy: undefined }),
    ]);
    const [loaded] = await repo.getVtxos(address);

    expect(loaded.isSpent).toBe(false);
    expect(loaded.isSwept).toBe(false);
    expect(loaded.spentBy).toBe("");
    expect(Array.isArray(loaded.commitmentTxIds)).toBe(true);
  });

  it("revives expiresAt as a Date, not the JSON string", async () => {
    const storage = memoryStorage();
    const repo = new AsyncStorageWalletRepository(storage);
    const address = "ark1qtest";

    await repo.saveVtxos(address, [sampleVtxo()]);
    const [loaded] = await repo.getVtxos(address);

    // A string here silently breaks every expiry comparison downstream.
    expect(loaded.expiresAt).toBeInstanceOf(Date);
    expect((loaded.expiresAt as unknown as Date).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("keeps asset amounts as bigint", async () => {
    const storage = memoryStorage();
    const repo = new AsyncStorageWalletRepository(storage);
    const address = "ark1qtest";

    await repo.saveVtxos(address, [sampleVtxo()]);
    const [loaded] = await repo.getVtxos(address);

    const assets = loaded.assets as unknown as { assetId: string; amount: bigint }[];
    expect(assets).toHaveLength(1);
    expect(typeof assets[0].amount).toBe("bigint");
    expect(assets[0].amount).toBe(1234n);
  });
});
