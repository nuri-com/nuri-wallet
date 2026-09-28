import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256, utf8ToBytes } from "../../lib/crypto";

const cache = new Map<string, unknown>();
const mocks = vi.hoisted(() => ({
  getEthereumAddress: vi.fn(),
  getSwapKitHtlcRoot: vi.fn(),
  getSwapKitHtlcKeyState: vi.fn(),
  storeSwapKitHtlcKeyState: vi.fn(),
  getCacheValue: vi.fn(),
  setCacheValue: vi.fn(),
  restoreSnapshot: vi.fn(),
}));

vi.mock("../../lib/secureKeyStorage", () => ({
  getEthereumAddress: mocks.getEthereumAddress,
  getSwapKitHtlcRoot: mocks.getSwapKitHtlcRoot,
  getSwapKitHtlcKeyState: mocks.getSwapKitHtlcKeyState,
  storeSwapKitHtlcKeyState: mocks.storeSwapKitHtlcKeyState,
}));
vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: mocks.getCacheValue,
  setCacheValue: mocks.setCacheValue,
}));
vi.mock("../nostr/NostrBackupService", () => ({
  restoreSwapKitRecoverySnapshotFromNostr: mocks.restoreSnapshot,
}));

const EOA = "0x1111111111111111111111111111111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  cache.clear();
  vi.resetModules();
  mocks.getEthereumAddress.mockResolvedValue(EOA);
  // Distinct deterministic root per provider, like the real HMAC derivation.
  mocks.getSwapKitHtlcRoot.mockImplementation(async (provider: string) =>
    sha256(utf8ToBytes(`test-root-${provider}`)),
  );
  // Keychain-backed key state (authoritative store since the cache-DB exodus).
  mocks.getSwapKitHtlcKeyState.mockImplementation(
    async () => (cache.get("keychain") as string) ?? null,
  );
  mocks.storeSwapKitHtlcKeyState.mockImplementation(async (json: string) => {
    cache.set("keychain", json);
  });
  // No published snapshot unless a test provides one.
  mocks.restoreSnapshot.mockResolvedValue(null);
  // Legacy cache row — only consulted for the one-time migration.
  mocks.getCacheValue.mockImplementation(async (key: string) => cache.get(key) ?? null);
  mocks.setCacheValue.mockImplementation(async (key: string, value: unknown) => {
    // Deep-copy like real persistence so later mutations can't leak in.
    cache.set(key, JSON.parse(JSON.stringify(value)));
  });
});

async function service() {
  return await import("./SwapKitHtlcKeyService");
}

describe("SwapKitHtlcKeyService", () => {
  it("returns byte-identical public material on replay without consuming an index", async () => {
    const { deriveSwapKitHtlcMaterial } = await service();
    const first = await deriveSwapKitHtlcMaterial("satora", "action-1");
    const replay = await deriveSwapKitHtlcMaterial("satora", "action-1");
    expect(replay).toEqual(first);
    expect(first.keyIndex).toBe(0);
    const next = await deriveSwapKitHtlcMaterial("satora", "action-2");
    expect(next.keyIndex).toBe(1);
    expect(next.publicKey).not.toBe(first.publicKey);
  });

  it("refuses the retired boltz namespace instead of deriving material", async () => {
    // Boltz is shut down and the server no longer returns it: naming it must
    // fail closed rather than key new material into a dead corridor.
    const { deriveSwapKitHtlcMaterial } = await service();
    await expect(deriveSwapKitHtlcMaterial("boltz", "action-1")).rejects.toThrow(/provider/i);
  });

  it("emits only public, well-formed material", async () => {
    const { deriveSwapKitHtlcMaterial } = await service();
    const material = await deriveSwapKitHtlcMaterial("satora", "action-1");
    // Compressed 33-byte secp256k1 points and a 32-byte hash — nothing else.
    expect(material.publicKey).toMatch(/^0x(02|03)[0-9a-f]{64}$/);
    expect(material.userId).toMatch(/^0x(02|03)[0-9a-f]{64}$/);
    expect(material.preimageHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(material.evmAddress).toBe(EOA);
    expect(Object.keys(material).sort()).toEqual([
      "evmAddress",
      "keyIndex",
      "preimageHash",
      "publicKey",
      "userId",
    ]);
  });

  it("survives a restart: persisted allocations replay the same material", async () => {
    const first = await (await service()).deriveSwapKitHtlcMaterial("satora", "action-1");
    vi.resetModules(); // new process; cache map persists like SQLite
    const after = await (await service()).deriveSwapKitHtlcMaterial("satora", "action-1");
    expect(after).toEqual(first);
    // ...and the counter continues instead of reusing index 0.
    const next = await (await service()).deriveSwapKitHtlcMaterial("satora", "action-9");
    expect(next.keyIndex).toBe(1);
  });

  // Preimage/swap-key consistency tests moved to SwapKitHtlcSecretService.test.ts
  // along with the secret-materialization functions (T7 key-seam split).

  it("rebuilds the counter floor from the Nostr snapshot when local state is wiped", async () => {
    // Browser storage eviction (or a reinstall) drops the counter while the
    // roots stay re-derivable from the PRF — the exact shape that re-issues an
    // already-used preimage. The published snapshot carries the used indices.
    mocks.restoreSnapshot.mockResolvedValue([
      { recovery: { provider: "satora", keyIndex: 0 } },
      { recovery: { provider: "satora", keyIndex: 4 } },
      // A stale entry for the retired provider is ignored, not re-issued.
      { recovery: { provider: "boltz", keyIndex: 2 } },
      { recovery: null },
      {},
    ]);
    const { deriveSwapKitHtlcMaterial } = await service();
    // Highest satora index seen is 4, so the next allocation must clear it.
    expect((await deriveSwapKitHtlcMaterial("satora", "fresh-1")).keyIndex).toBe(5);
  });

  it("keeps the local counter when one exists — the snapshot is a floor, not an override", async () => {
    mocks.restoreSnapshot.mockResolvedValue([{ recovery: { provider: "satora", keyIndex: 9 } }]);
    cache.set("keychain", JSON.stringify({ nextKeyIndex: { satora: 2 }, allocations: {} }));
    const { deriveSwapKitHtlcMaterial } = await service();
    expect((await deriveSwapKitHtlcMaterial("satora", "a")).keyIndex).toBe(2);
    expect(mocks.restoreSnapshot).not.toHaveBeenCalled();
  });

  it("still allocates from zero when no snapshot exists (fresh wallet)", async () => {
    const { deriveSwapKitHtlcMaterial } = await service();
    expect((await deriveSwapKitHtlcMaterial("satora", "a")).keyIndex).toBe(0);
  });

  it("rejects unknown providers and missing actionIds", async () => {
    const { deriveSwapKitHtlcMaterial } = await service();
    await expect(deriveSwapKitHtlcMaterial("lendasat", "a")).rejects.toThrow(/provider/i);
    await expect(deriveSwapKitHtlcMaterial("satora", " ")).rejects.toThrow(/actionId/);
  });

  it("allocates concurrent actionIds atomically — no shared index", async () => {
    const { deriveSwapKitHtlcMaterial } = await service();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => deriveSwapKitHtlcMaterial("satora", `action-${i}`)),
    );
    const indices = results.map((r) => r.keyIndex).sort((a, b) => a - b);
    expect(indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("honors the server's minimumKeyIndex fast-forward (v0.6.21)", async () => {
    const { deriveSwapKitHtlcMaterial } = await service();
    await deriveSwapKitHtlcMaterial("satora", "action-1"); // counter -> 1
    const jumped = await deriveSwapKitHtlcMaterial("satora", "action-2", 320);
    expect(jumped.keyIndex).toBe(320);
    // Replay of the fast-forwarded action stays pinned; the counter continues past it.
    expect((await deriveSwapKitHtlcMaterial("satora", "action-2", 320)).keyIndex).toBe(320);
    expect((await deriveSwapKitHtlcMaterial("satora", "action-3")).keyIndex).toBe(321);
    // A minimum below the local counter never rolls it back.
    expect((await deriveSwapKitHtlcMaterial("satora", "action-4", 5)).keyIndex).toBe(322);
  });

  it("reallocates a pinned allocation when a re-armed action raises the minimum", async () => {
    const { deriveSwapKitHtlcMaterial } = await service();
    // Allocated before the server learned the material is provider-known…
    expect((await deriveSwapKitHtlcMaterial("satora", "parked-action")).keyIndex).toBe(0);
    // …then the parked tx re-arms the SAME actionId with a raised floor
    // (v0.6.26): replaying index 0 forever is the 2 Hz loop — jump instead.
    expect((await deriveSwapKitHtlcMaterial("satora", "parked-action", 1024)).keyIndex).toBe(1024);
    // The reallocation is pinned like any other.
    expect((await deriveSwapKitHtlcMaterial("satora", "parked-action", 1024)).keyIndex).toBe(1024);
  });

  it("migrates legacy cache-DB state into the keychain once", async () => {
    cache.set("swapkit:htlc-keys:v1", {
      nextKeyIndex: { satora: 7 },
      allocations: { "satora:old-action": 3 },
    });
    const { deriveSwapKitHtlcMaterial } = await service();
    expect((await deriveSwapKitHtlcMaterial("satora", "old-action")).keyIndex).toBe(3);
    expect((await deriveSwapKitHtlcMaterial("satora", "new-action")).keyIndex).toBe(7);
    // The keychain is authoritative after the first persist.
    expect(mocks.storeSwapKitHtlcKeyState).toHaveBeenCalled();
    expect(mocks.setCacheValue).not.toHaveBeenCalled();
  });
});
