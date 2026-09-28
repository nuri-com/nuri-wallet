import { beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { bytesToHex, hexToBytes, sha256, utf8ToBytes } from "../../lib/crypto";

// Chain client seam: the service builds viem public/wallet clients internally,
// so we replace them with controllable stubs to drive broadcast/readback paths.
const chain = vi.hoisted(() => ({
  call: vi.fn(),
  sendTransaction: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  getTransaction: vi.fn(),
  getBalance: vi.fn(),
}));
const cache = new Map<string, unknown>();
const mocks = vi.hoisted(() => ({
  getEthereumAddress: vi.fn(),
  getSwapKitHtlcRoot: vi.fn(),
  getPrivateKey: vi.fn(),
  getCacheValue: vi.fn(),
  setCacheValue: vi.fn(),
}));

vi.mock("viem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem")>()),
  createPublicClient: () => ({
    call: chain.call,
    waitForTransactionReceipt: chain.waitForTransactionReceipt,
    getTransaction: chain.getTransaction,
    getBalance: chain.getBalance,
  }),
  createWalletClient: () => ({ sendTransaction: chain.sendTransaction }),
}));
vi.mock("../../lib/secureKeyStorage", () => ({
  getEthereumAddress: mocks.getEthereumAddress,
  getSwapKitHtlcRoot: mocks.getSwapKitHtlcRoot,
  getPrivateKey: mocks.getPrivateKey,
  getSwapKitHtlcKeyState: vi.fn(async () => (cache.get("keychain") as string) ?? null),
  storeSwapKitHtlcKeyState: vi.fn(async (json: string) => {
    cache.set("keychain", json);
  }),
}));
vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: mocks.getCacheValue,
  setCacheValue: mocks.setCacheValue,
}));

const PRIVATE_KEY = `0x${"11".repeat(32)}` as const;
const EOA = privateKeyToAccount(PRIVATE_KEY).address;
const RESULT_KEY = "swapkit:htlc-results:v1";
const HASH = `0x${"ab".repeat(32)}` as const;

function serverFingerprint(kind: string, request: unknown): string {
  const canon = (value: unknown): unknown => {
    if (typeof value === "bigint") return `0x${value.toString(16)}`;
    if (Array.isArray(value)) return value.map(canon);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((k) => [k, canon((value as Record<string, unknown>)[k])]),
      );
    }
    return value;
  };
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(canon({ kind, request })))));
}

beforeEach(() => {
  vi.clearAllMocks();
  cache.clear();
  vi.resetModules();
  mocks.getEthereumAddress.mockResolvedValue(EOA);
  mocks.getPrivateKey.mockImplementation(async () => hexToBytes(PRIVATE_KEY.slice(2)));
  mocks.getSwapKitHtlcRoot.mockImplementation(async (provider: string) =>
    sha256(utf8ToBytes(`test-root-${provider}`)),
  );
  mocks.getCacheValue.mockImplementation(async (key: string) => cache.get(key) ?? null);
  mocks.setCacheValue.mockImplementation(async (key: string, value: unknown) => {
    cache.set(key, JSON.parse(JSON.stringify(value)));
  });
  chain.call.mockResolvedValue({ data: "0x" });
  chain.sendTransaction.mockResolvedValue(HASH);
});

async function services() {
  const actionService = await import("./SwapKitHtlcActionService");
  const keyService = await import("./SwapKitHtlcKeyService");
  return { ...actionService, ...keyService };
}

// Build a validated send_transaction action bound to the active EOA.
async function sendTxAction(extra: Record<string, unknown> = {}) {
  const { deriveSwapKitHtlcMaterial, validateSwapKitHtlcAction } = await services();
  const material = await deriveSwapKitHtlcMaterial("satora", "derive-tx");
  const requestBody = {
    chainId: 8453,
    to: "0x2222222222222222222222222222222222222222",
    data: "0x1234",
    ...extra,
  };
  const action = {
    version: 2,
    actionId: "wa_tx-1",
    type: "htlc_signing_v2",
    capability: "htlc_signing_v2",
    requestEncoding: "eip712-canonical-v1",
    provider: "satora",
    operation: "redeem",
    externalId: "ext-tx",
    keyRef: {
      provider: "satora",
      keyIndex: material.keyIndex,
      preimageHash: material.preimageHash,
    },
    request: { kind: "send_transaction", ...requestBody },
    requestFingerprint: serverFingerprint("send_transaction", requestBody),
    needsPreimage: false,
  };
  return validateSwapKitHtlcAction(action, { eoa: EOA });
}

describe("send_transaction idempotency + preflight parity", () => {
  it("journals the broadcast hash and survives a receipt-readback RPC failure", async () => {
    const { executeSwapKitHtlcAction } = await services();
    const validated = await sendTxAction();
    // Broadcast succeeds, but the receipt readback throws (transient RPC).
    chain.waitForTransactionReceipt.mockRejectedValue(new Error("rpc down"));

    const result = await executeSwapKitHtlcAction(validated);
    expect(result).toEqual({ txHash: HASH });
    // The hash was journaled despite the readback failure — idempotency secured.
    expect((cache.get(RESULT_KEY) as Record<string, unknown>)["wa_tx-1"]).toEqual({ txHash: HASH });
    expect(chain.sendTransaction).toHaveBeenCalledTimes(1);

    // A re-presented actionId replays the journaled hash — never re-broadcasts.
    const replay = await executeSwapKitHtlcAction(validated);
    expect(replay).toEqual({ txHash: HASH });
    expect(chain.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("mirrors the EIP-7702 authorizationList into the preflight call", async () => {
    const { executeSwapKitHtlcAction } = await services();
    const authorizationList = [
      {
        address: "0x3333333333333333333333333333333333333333",
        chainId: 8453,
        nonce: 7,
        r: `0x${"11".repeat(32)}`,
        s: `0x${"22".repeat(32)}`,
        yParity: 1,
      },
    ];
    const validated = await sendTxAction({ authorizationList });
    // Skip the mined-tuple readback to isolate the preflight assertion.
    chain.waitForTransactionReceipt.mockRejectedValue(new Error("rpc down"));

    await executeSwapKitHtlcAction(validated);
    expect(chain.call).toHaveBeenCalledTimes(1);
    expect(chain.call.mock.calls[0][0]).toMatchObject({ authorizationList });
  });

  it("fails closed on a non-zero native value before broadcasting", async () => {
    const { executeSwapKitHtlcAction } = await services();
    const validated = await sendTxAction({ value: "0x1" });
    await expect(executeSwapKitHtlcAction(validated)).rejects.toThrow(/non-zero value/);
    expect(chain.sendTransaction).not.toHaveBeenCalled();
  });

  it("treats a confirmed onchain revert as terminal but keeps the journaled hash", async () => {
    const { executeSwapKitHtlcAction } = await services();
    const validated = await sendTxAction();
    chain.waitForTransactionReceipt.mockResolvedValue({ status: "reverted" });
    chain.getTransaction.mockResolvedValue({});

    await expect(executeSwapKitHtlcAction(validated)).rejects.toThrow(/reverted onchain/);
    // Journaled before the terminal check, so a rerun replays instead of re-sending.
    expect((cache.get(RESULT_KEY) as Record<string, unknown>)["wa_tx-1"]).toEqual({ txHash: HASH });
  });

  it("keeps a confirmed revert terminal even when the tx readback then fails", async () => {
    const { executeSwapKitHtlcAction } = await services();
    const validated = await sendTxAction();
    // Receipt confirms a revert, but the subsequent getTransaction read throws.
    // The revert must NOT be swallowed as a transient readback failure.
    chain.waitForTransactionReceipt.mockResolvedValue({ status: "reverted" });
    chain.getTransaction.mockRejectedValue(new Error("rpc down"));

    await expect(executeSwapKitHtlcAction(validated)).rejects.toThrow(/reverted onchain/);
    // getTransaction is never reached — the status check fires first.
    expect(chain.getTransaction).not.toHaveBeenCalled();
    expect((cache.get(RESULT_KEY) as Record<string, unknown>)["wa_tx-1"]).toEqual({ txHash: HASH });
  });
});
