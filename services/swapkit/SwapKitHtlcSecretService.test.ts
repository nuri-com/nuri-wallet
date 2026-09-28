import { beforeEach, describe, expect, it, vi } from "vitest";
import { bytesToHex, secp256k1, sha256, utf8ToBytes } from "../../lib/crypto";

const cache = new Map<string, unknown>();
const mocks = vi.hoisted(() => ({
  getEthereumAddress: vi.fn(),
  getSwapKitHtlcRoot: vi.fn(),
  getSwapKitHtlcKeyState: vi.fn(),
  storeSwapKitHtlcKeyState: vi.fn(),
  getCacheValue: vi.fn(),
}));

vi.mock("../../lib/secureKeyStorage", () => ({
  getEthereumAddress: mocks.getEthereumAddress,
  getSwapKitHtlcRoot: mocks.getSwapKitHtlcRoot,
  getSwapKitHtlcKeyState: mocks.getSwapKitHtlcKeyState,
  storeSwapKitHtlcKeyState: mocks.storeSwapKitHtlcKeyState,
}));
vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: mocks.getCacheValue,
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
  mocks.getSwapKitHtlcKeyState.mockImplementation(
    async () => (cache.get("keychain") as string) ?? null,
  );
  mocks.storeSwapKitHtlcKeyState.mockImplementation(async (json: string) => {
    cache.set("keychain", json);
  });
  mocks.getCacheValue.mockResolvedValue(null);
});

async function services() {
  const keyService = await import("./SwapKitHtlcKeyService");
  const secretService = await import("./SwapKitHtlcSecretService");
  return { ...keyService, ...secretService };
}

describe("SwapKitHtlcSecretService", () => {
  it("preimage matches the advertised hash and stays out of the material", async () => {
    const { deriveSwapKitHtlcMaterial, materializeSwapKitHtlcPreimage } = await services();
    const material = await deriveSwapKitHtlcMaterial("satora", "action-1");
    const preimage = await materializeSwapKitHtlcPreimage("satora", material.keyIndex);
    expect(`0x${Buffer.from(sha256(preimage)).toString("hex")}`).toBe(material.preimageHash);
    expect(JSON.stringify(material)).not.toContain(Buffer.from(preimage).toString("hex"));
  });

  it("swap key is the private half of the derive_material publicKey", async () => {
    const { deriveSwapKitHtlcMaterial, materializeSwapKitHtlcSwapKey } = await services();
    const material = await deriveSwapKitHtlcMaterial("satora", "action-1");
    const swapKey = await materializeSwapKitHtlcSwapKey("satora", material.keyIndex);
    expect(`0x${bytesToHex(secp256k1.getPublicKey(swapKey, true))}`).toBe(material.publicKey);
  });

  it("rejects unknown providers and invalid keyIndexes", async () => {
    const { materializeSwapKitHtlcPreimage, materializeSwapKitHtlcSwapKey } = await services();
    await expect(materializeSwapKitHtlcPreimage("lendasat", 0)).rejects.toThrow(/provider/i);
    await expect(materializeSwapKitHtlcPreimage("satora", -1)).rejects.toThrow(/keyIndex/);
    await expect(materializeSwapKitHtlcSwapKey("satora", 1.5)).rejects.toThrow(/keyIndex/);
  });
});
