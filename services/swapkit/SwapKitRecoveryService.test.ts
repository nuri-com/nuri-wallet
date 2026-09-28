import { beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { encodeAbiParameters, encodeEventTopics, erc20Abi } from "viem";

const mocks = vi.hoisted(() => ({
  owner: vi.fn(),
  key: vi.fn(),
  write: vi.fn(),
  read: vi.fn(),
  fetch: vi.fn(),
  loop: vi.fn(),
  cow: vi.fn(),
  receipt: vi.fn(),
  removePending: vi.fn(),
  emit: vi.fn(),
  recover: vi.fn(),
}));
vi.mock("../../lib/secureKeyStorage", () => ({
  getEthereumAddress: mocks.owner,
  getPrivateKey: mocks.key,
}));
vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: mocks.read,
  setCacheValue: mocks.write,
}));
vi.mock("../nostr/NostrBackupService", () => ({
  publishSwapKitRecoverySnapshotToNostr: async (): Promise<void> => {},
  restoreSwapKitRecoverySnapshotFromNostr: async (): Promise<null> => null,
}));
vi.mock("../logging/LoggerService", () => ({ log: vi.fn() }));
vi.mock("../../lib/OperationLogUtils", () => ({
  LOG_EMOJI: {},
  logWithId: vi.fn(),
  errorWithId: vi.fn(),
}));
vi.mock("viem", async (original) => ({
  ...(await original<typeof import("viem")>()),
  createPublicClient: () => ({ getTransactionReceipt: mocks.receipt }),
}));
vi.mock("./SwapKitService", async (original) => ({
  ...(await original<typeof import("./SwapKitService")>()),
  runSwapKitSwapLoop: mocks.loop,
}));
vi.mock("../base/BaseTokenTransferService", async (original) => ({
  ...(await original<typeof import("../base/BaseTokenTransferService")>()),
  signCowOrderOnBase: mocks.cow,
}));
vi.mock("./SwapKitHtlcActionService", () => ({ handleSwapKitHtlcAction: vi.fn() }));
vi.mock("./SwapKitArkadeActionService", () => ({ handleSwapKitArkadeAction: vi.fn() }));
vi.mock("./SwapKitDirectEvmSwapService", () => ({
  resumeDirectEvmSwaps: async (): Promise<void> => {},
}));
vi.mock("./SwapKitDirectSwapStore", () => ({
  SwapKitDirectSwapStore: { list: (): never[] => [], hydrate: async () => {} },
  listAbandonedSwapOrders: async () => new Set(),
}));
vi.mock("./SwapKitEvmSigner", () => ({
  SWAPKIT_SWEEP_CHAIN_IDS: [],
  signAndBroadcastSwapKitEvmTx: vi.fn(),
}));
vi.mock("./SwapKitUsdcRecoveryService", () => ({ recoverStrandedUsdc: mocks.recover }));
vi.mock("../balance/MultiCurrencyBalanceService", () => ({ getErc20BalanceUnits: vi.fn() }));
vi.mock("../events/AppEventBusService", () => ({ EventBus: { emit: mocks.emit } }));
vi.mock("../app/PendingPurchasesStore", () => ({
  PendingPurchasesStore: {
    remove: mocks.removePending,
    hydrate: async () => {},
    list: (): never[] => [],
  },
}));
vi.mock("../balance/PendingWalletTransfersStore", () => ({
  PendingWalletTransfersStore: { list: async (): Promise<never[]> => [] },
}));

import { ARBITRUM_TBTC, BASE_EURC } from "../../config/network";
import { signSwapKitRecoveryQuote } from "../base/BaseTokenTransferService";
import { SwapKitOrderStore, type SwapKitOrder } from "./SwapKitOrderStore";
import { RECOVERY_FIELDS, type SwapKitRecoveryQuote } from "./SwapKitRecoveryQuote";
import {
  acceptedRecoveryQuote,
  continueSwapKitRecovery,
  previewSwapKitRecovery,
  recoveryPayoutProven,
} from "./SwapKitRecoveryService";
import { startSwapKitOrderTracking, hydrateAndResumeSwapKitOrders } from "./SwapKitPendingTracker";
import type { ParsedSwapTypedDataAction } from "./SwapKitService";
import { trackSwapKitSwap } from "./SwapKitService";
import completedTrack from "./__fixtures__/cow-completed-track.json";

// Public deterministic fixture key. Never a customer account; no live transport.
const KEY = `0x${"01".repeat(32)}` as const;
const OWNER = privateKeyToAccount(KEY).address;
const OTHER = `0x${"22".repeat(20)}`;
const TX = "fixture-original-funded-order";
const HASH = `0x${"ab".repeat(32)}` as const;
function quote(): SwapKitRecoveryQuote {
  const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 120_000).toISOString();
  const q = {
    txId: TX,
    quoteId: "fixture-quote",
    owner: OWNER,
    recipient: OWNER,
    sourceChainId: 42161,
    sourceToken: ARBITRUM_TBTC.address,
    sourceAmountUnits: "50000000000000",
    expectedUsdcUnits: "4900000",
    minimumUsdcUnits: "4800000",
    maximumSellUsdcUnits: "5000000",
    expectedReceiveUnits: "4200000",
    minimumReceiveUnits: "4100000",
    receiveAsset: "EURC_BASE" as const,
    expiresAt,
  };
  return {
    ...q,
    typedData: {
      domain: { name: "SwapKit Recovery", version: "1", chainId: 42161 },
      primaryType: "SwapRecovery",
      types: { SwapRecovery: RECOVERY_FIELDS.map(([name, type]) => ({ name, type })) },
      message: {
        ...Object.fromEntries(
          Object.entries(q)
            .filter(([key]) => key !== "receiveAsset")
            .map(([key, value]) => [key, String(value)]),
        ),
        receiveChainId: "8453",
        receiveToken: BASE_EURC.address,
        expiresAt: String(Date.parse(expiresAt) / 1000),
      },
    },
  };
}
function acceptance(q: SwapKitRecoveryQuote) {
  return {
    txId: q.txId,
    quoteId: q.quoteId,
    status: "ACCEPTED",
    clientBounds: {
      owner: q.owner,
      recipient: q.recipient,
      expectedUsdcUnits: q.expectedUsdcUnits,
      maximumSellUsdcUnits: q.maximumSellUsdcUnits,
      minimumReceiveUnits: q.minimumReceiveUnits,
      receiveAsset: q.receiveAsset,
    },
  };
}
let offered: SwapKitRecoveryQuote;
let calls: { name: string; arguments: Record<string, string> }[];
let persisted: unknown;
const order = (kind: SwapKitOrder["kind"] = "card_topup"): SwapKitOrder => ({
  kind,
  txId: TX,
  settleTarget: OWNER,
  expectedUsdc: 6,
  minEurc: 5,
  usdcBaseline: "9000000",
  sats: 1000,
  createdAt: 1,
  attempts: 0,
  recovery: { provider: "satora", actionId: "keep-late-result" },
});
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(async () => {
  vi.clearAllMocks();
  await SwapKitOrderStore.clear();
  offered = quote();
  calls = [];
  persisted = null;
  mocks.owner.mockReset().mockResolvedValue(OWNER);
  mocks.key.mockReset().mockImplementation(async () => new Uint8Array(32).fill(1));
  mocks.read.mockReset().mockImplementation(async () => persisted);
  mocks.write.mockReset().mockImplementation(async (_key, value) => {
    persisted = JSON.parse(JSON.stringify(value));
  });
  mocks.loop.mockReset().mockResolvedValue({ txId: TX, status: "PENDING" });
  mocks.removePending.mockResolvedValue(undefined);
  mocks.receipt.mockReset().mockResolvedValue({ status: "success", logs: [] });
  mocks.fetch.mockReset().mockImplementation(async (_url, init) => {
    const params = JSON.parse(init.body).params;
    calls.push(params);
    const payload =
      params.name === "swap_recovery_quote"
        ? offered
        : params.name === "swap_recovery_accept"
          ? acceptance(offered)
          : { transactions: [] as never[] };
    return new Response(
      JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }),
    );
  });
  vi.stubGlobal("fetch", mocks.fetch);
  await SwapKitOrderStore.add(order());
});

describe("same-order current-rate consent (offline)", () => {
  it("opening an expired checkpoint never accepts, replaces, or signs it", async () => {
    const old = await previewSwapKitRecovery(TX);
    const signature = await signSwapKitRecoveryQuote(old, {
      txId: TX,
      owner: OWNER,
      recipient: OWNER,
    });
    await SwapKitOrderStore.checkpointRecovery(TX, { quote: old, signature });
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(old.expiresAt) + 1);
    calls.length = 0;
    mocks.key.mockClear();
    try {
      expect(await previewSwapKitRecovery(TX, false)).toEqual(old);
      expect(calls).toEqual([]);
      expect(mocks.key).not.toHaveBeenCalled();
      expect(SwapKitOrderStore.list()[0].recoveryConsent?.accepted).toBeUndefined();
      expect(SwapKitOrderStore.list()[0].recoveryNextQuote).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
    }
  });
  it.each([
    "id only",
    "matching aliases",
    "txId only",
    "missing ids",
    "wrong id",
    "wrong txId",
    "conflicting aliases",
    "null id",
    "numeric id",
    "empty id",
    "padded id",
    "malformed alias",
    "missing hash",
    "wrong receiver",
    "reverted receipt",
    "empty receipt",
  ])("backend-generated track identity: %s", async (scenario) => {
    // Backend 779e339484df040983c87f436b9fea407a0cbcdd, offline HTTP fixture.
    // Pass its unchanged id-only payload through the real MCP caller, not a txId shim.
    const originalId = completedTrack.id;
    const q = quote();
    q.txId = originalId;
    q.typedData.message.txId = originalId;
    q.recipient = completedTrack.recipient;
    q.typedData.message.recipient = q.recipient;
    await SwapKitOrderStore.clear();
    await SwapKitOrderStore.add({ ...order(), txId: originalId, settleTarget: q.recipient });
    const signature = await privateKeyToAccount(KEY).signTypedData(q.typedData as never);
    await SwapKitOrderStore.checkpointRecovery(originalId, {
      quote: q,
      signature,
      accepted: { ...acceptance(q), status: "ACCEPTED" },
    });
    const row = SwapKitOrderStore.list()[0];
    const payload: Record<string, unknown> = structuredClone(completedTrack);
    if (scenario === "matching aliases") payload.txId = originalId;
    if (scenario === "txId only") {
      payload.id = undefined; // JSON serialization omits this field on the wire.
      payload.txId = originalId;
    }
    if (scenario === "missing ids") payload.id = undefined;
    if (scenario === "wrong id") payload.id = "different-order";
    if (scenario === "wrong txId") {
      payload.id = undefined;
      payload.txId = "different-order";
    }
    if (scenario === "conflicting aliases") payload.txId = "different-order";
    if (scenario === "null id") payload.id = null;
    if (scenario === "numeric id") payload.id = 123;
    if (scenario === "empty id") payload.id = "";
    if (scenario === "padded id") payload.id = ` ${originalId}`;
    if (scenario === "malformed alias") payload.txId = {};
    if (scenario === "missing hash") {
      const legs = structuredClone(completedTrack.legs);
      legs[legs.length - 1].txids = [];
      payload.legs = legs;
    }
    mocks.fetch.mockImplementation(async (_url, init) => {
      const request = JSON.parse(init.body).params;
      expect(request).toEqual({
        name: "swap_track",
        arguments: { txId: originalId, refresh: false },
      });
      return new Response(
        JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }),
      );
    });
    const status = await trackSwapKitSwap(originalId, { refresh: false });
    const recipient = scenario === "wrong receiver" ? OTHER : q.recipient;
    mocks.receipt.mockResolvedValue({
      status: scenario === "reverted receipt" ? "reverted" : "success",
      logs:
        scenario === "empty receipt"
          ? []
          : [
              {
                address: BASE_EURC.address,
                topics: encodeEventTopics({
                  abi: erc20Abi,
                  eventName: "Transfer",
                  args: { from: OTHER as `0x${string}`, to: recipient as `0x${string}` },
                }),
                data: encodeAbiParameters([{ type: "uint256" }], [4100000n]),
              },
            ],
    });
    const valid = ["id only", "matching aliases", "txId only"].includes(scenario);
    expect(await recoveryPayoutProven(row, status)).toBe(valid);
    if (valid) expect(mocks.receipt).toHaveBeenCalledWith({ hash: HASH });
    if (!["wrong receiver", "reverted receipt", "empty receipt"].includes(scenario) && !valid)
      expect(mocks.receipt).not.toHaveBeenCalled();
  });

  it("parent expired unaccepted checkpoint offers fresh terms without another signature", async () => {
    const old = quote();
    const signature = await privateKeyToAccount(KEY).signTypedData(old.typedData as never);
    await SwapKitOrderStore.checkpointRecovery(TX, { quote: old, signature });
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(old.expiresAt) + 1000);
    try {
      offered = quote();
      offered.quoteId = "fixture-new-quote";
      offered.typedData.message.quoteId = offered.quoteId;
      mocks.fetch.mockImplementation(async (_url, init) => {
        const params = JSON.parse(init.body).params;
        calls.push(params);
        if (params.name === "swap_recovery_accept")
          return new Response(
            JSON.stringify({
              result: {
                isError: true,
                content: [
                  { type: "text", text: "Error: Recovery quote expired; request a fresh quote" },
                ],
              },
            }),
          );
        return new Response(
          JSON.stringify({
            result: { content: [{ type: "text", text: JSON.stringify(offered) }] },
          }),
        );
      });
      expect((await previewSwapKitRecovery(TX)).quoteId).toBe("fixture-new-quote");
      expect(calls.map((call) => call.name)).toEqual([
        "swap_recovery_accept",
        "swap_recovery_quote",
      ]);
      expect(mocks.key).not.toHaveBeenCalled();
      expect(SwapKitOrderStore.list()[0].recoveryConsent?.signature).toBe(signature);
      expect(SwapKitOrderStore.list()[0].recoveryNextQuote?.quoteId).toBe(offered.quoteId);
      const next = offered;
      mocks.fetch.mockImplementation(async (_url, init) => {
        const params = JSON.parse(init.body).params;
        calls.push(params);
        return new Response(
          JSON.stringify({
            result: { content: [{ type: "text", text: JSON.stringify(acceptance(next)) }] },
          }),
        );
      });
      const row = await continueSwapKitRecovery(next);
      expect(row.recoveryConsent?.accepted?.quoteId).toBe(next.quoteId);
      expect(row.recoveryConsentHistory?.[0]).toEqual({ quote: old, signature });
      expect(mocks.key).toHaveBeenCalledTimes(1);
      expect(
        calls.every((call) => ["swap_recovery_accept", "swap_recovery_quote"].includes(call.name)),
      ).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each(["transport", "storage", "owner", "late acceptance", "concurrent Continue"])(
    "expired reconciliation preserves safety on %s",
    async (edge) => {
      const old = quote();
      const signature = await privateKeyToAccount(KEY).signTypedData(old.typedData as never);
      const previous = { quote: old, signature };
      await SwapKitOrderStore.checkpointRecovery(TX, previous);
      vi.spyOn(Date, "now").mockReturnValue(Date.parse(old.expiresAt) + 1000);
      let accepts = 0;
      const response = (value: unknown, error = false) =>
        new Response(
          JSON.stringify({
            result: {
              isError: error,
              content: [{ type: "text", text: error ? value : JSON.stringify(value) }],
            },
          }),
        );
      try {
        offered = quote();
        offered.quoteId = "fixture-new-quote";
        offered.typedData.message.quoteId = offered.quoteId;
        mocks.fetch.mockImplementation(async (_url, init) => {
          const params = JSON.parse(init.body).params;
          calls.push(params);
          if (params.name === "swap_recovery_accept") {
            accepts++;
            if (edge === "transport") throw new Error("fetch failed");
            if (accepts > 1 && edge === "late acceptance") return response(acceptance(old));
            return response("Error: Recovery quote expired; request a fresh quote", true);
          }
          if (edge === "late acceptance")
            return response(
              "Error: Order changed during recovery quote; request a fresh quote",
              true,
            );
          if (edge === "storage") mocks.write.mockRejectedValueOnce(new Error("disk unavailable"));
          if (edge === "owner") mocks.owner.mockResolvedValue(OTHER);
          if (edge === "concurrent Continue")
            await expect(continueSwapKitRecovery(old)).rejects.toThrow("already running");
          return response(offered);
        });
        if (edge === "late acceptance") {
          expect((await previewSwapKitRecovery(TX)).quoteId).toBe(old.quoteId);
          expect(SwapKitOrderStore.list()[0].recoveryConsent?.accepted?.quoteId).toBe(old.quoteId);
          expect(SwapKitOrderStore.list()[0].recoveryNextQuote).toBeUndefined();
        } else if (edge === "concurrent Continue") {
          expect((await previewSwapKitRecovery(TX)).quoteId).toBe(offered.quoteId);
        } else {
          await expect(previewSwapKitRecovery(TX)).rejects.toThrow();
          expect(SwapKitOrderStore.list()[0].recoveryConsent).toEqual(previous);
          expect(SwapKitOrderStore.list()[0].recoveryNextQuote).toBeUndefined();
        }
        expect(mocks.key).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  it("preview and hydration never sign or accept a price change", async () => {
    await previewSwapKitRecovery(TX);
    await hydrateAndResumeSwapKitOrders();
    await settle();
    expect(mocks.key).not.toHaveBeenCalled();
    expect(calls.some((call) => call.name === "swap_recovery_accept")).toBe(false);
    expect(SwapKitOrderStore.list()[0].minEurc).toBe(5);
  });

  it.each(["card_topup", "discovered"] as const)(
    "accepts on the same %s row, preserving original bounds and checkpoints",
    async (kind) => {
      await SwapKitOrderStore.add(order(kind));
      const preview = await previewSwapKitRecovery(TX);
      const row = await continueSwapKitRecovery(preview);
      expect(row.kind).toBe(kind);
      expect(row.txId).toBe(TX);
      expect(row.minEurc).toBe(5);
      expect(row.expectedUsdc).toBe(6);
      expect(row.recovery?.actionId).toBe("keep-late-result");
      expect(await acceptedRecoveryQuote(row)).toEqual(preview);
      expect((persisted as SwapKitOrder[])[0].recoveryConsent?.accepted?.status).toBe("ACCEPTED");
      expect(calls.map((call) => call.name)).toEqual([
        "swap_recovery_quote",
        "swap_recovery_accept",
      ]);
      startSwapKitOrderTracking(row);
      await settle();
      const options = mocks.loop.mock.calls.at(-1)![1];
      await options.signTypedData({} as ParsedSwapTypedDataAction);
      expect(mocks.cow).toHaveBeenCalledWith(
        {},
        expect.objectContaining({
          maxSellAmount: 5000000n,
          minBuyAmount: 4100000n,
          receiver: OWNER,
        }),
        OWNER,
      );
      expect(SwapKitOrderStore.list()).toHaveLength(1);
    },
  );

  it("leaves an unconsented discovered row without a CoW signing handler", async () => {
    await SwapKitOrderStore.add(order("discovered"));
    startSwapKitOrderTracking(SwapKitOrderStore.list()[0]);
    await settle();
    expect(mocks.loop.mock.calls[0][1].signTypedData).toBeUndefined();
    expect(mocks.key).not.toHaveBeenCalled();
  });

  it.each([
    [
      "wrong order",
      (q: SwapKitRecoveryQuote) => {
        q.txId = "other";
      },
    ],
    [
      "wrong owner",
      (q: SwapKitRecoveryQuote) => {
        q.owner = OTHER;
      },
    ],
    [
      "wrong recipient",
      (q: SwapKitRecoveryQuote) => {
        q.recipient = OTHER;
      },
    ],
    [
      "mutated amount",
      (q: SwapKitRecoveryQuote) => {
        q.minimumReceiveUnits = "1";
      },
    ],
    [
      "mutated signed ceiling",
      (q: SwapKitRecoveryQuote) => {
        q.typedData.message.maximumSellUsdcUnits = "9000000";
      },
    ],
    [
      "extra message",
      (q: SwapKitRecoveryQuote) => {
        q.typedData.message.extra = "1";
      },
    ],
    [
      "wrong domain",
      (q: SwapKitRecoveryQuote) => {
        q.typedData.domain.name = "Other";
      },
    ],
    [
      "wrong chain",
      (q: SwapKitRecoveryQuote) => {
        q.typedData.message.receiveChainId = "1";
      },
    ],
    [
      "wrong token",
      (q: SwapKitRecoveryQuote) => {
        q.typedData.message.receiveToken = OTHER;
      },
    ],
    [
      "wrong schema",
      (q: SwapKitRecoveryQuote) => {
        q.typedData.types.SwapRecovery.reverse();
      },
    ],
    [
      "noncanonical units",
      (q: SwapKitRecoveryQuote) => {
        q.sourceAmountUnits = "01";
        q.typedData.message.sourceAmountUnits = "01";
      },
    ],
    [
      "expired",
      (q: SwapKitRecoveryQuote) => {
        q.expiresAt = "2020-01-01T00:00:00.000Z";
        q.typedData.message.expiresAt = "1577836800";
      },
    ],
  ] as const)("rejects %s before opening key storage", async (_name, mutate) => {
    const q = quote();
    mutate(q);
    await expect(
      signSwapKitRecoveryQuote(q, { txId: TX, owner: OWNER, recipient: OWNER }),
    ).rejects.toThrow();
    expect(mocks.key).not.toHaveBeenCalled();
  });

  it("rejects a different unlocked EOA", async () => {
    mocks.key.mockImplementation(async () => new Uint8Array(32).fill(2));
    await expect(continueSwapKitRecovery(await previewSwapKitRecovery(TX))).rejects.toThrow();
    expect(calls.some((call) => call.name === "swap_recovery_accept")).toBe(false);
  });

  it("rejects identity changes across awaits without accepting or arming bounds", async () => {
    const preview = await previewSwapKitRecovery(TX);
    mocks.key.mockImplementation(async () => {
      mocks.owner.mockResolvedValue(OTHER);
      return new Uint8Array(32).fill(1);
    });
    await expect(continueSwapKitRecovery(preview)).rejects.toThrow();
    expect(SwapKitOrderStore.list()[0].recoveryConsent).toBeUndefined();
    expect(calls.map((call) => call.name)).toEqual(["swap_recovery_quote"]);
  });

  it("replays exactly the persisted signature after response loss, even after expiry", async () => {
    const preview = await previewSwapKitRecovery(TX);
    const transport = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (...args) => {
      const response = await transport(...args);
      if (calls.at(-1)?.name === "swap_recovery_accept")
        throw new Error("response lost after server acceptance");
      return response;
    });
    await expect(continueSwapKitRecovery(preview)).rejects.toThrow("response lost");
    const saved = (persisted as SwapKitOrder[])[0].recoveryConsent;
    expect(saved?.signature).toMatch(/^0x[0-9a-f]+$/);
    expect(saved?.accepted).toBeUndefined();
    await expect(acceptedRecoveryQuote(SwapKitOrderStore.list()[0])).rejects.toThrow(
      "not yet accepted",
    );
    mocks.fetch.mockImplementation(transport);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(preview.expiresAt) + 1000);
    try {
      await continueSwapKitRecovery(await previewSwapKitRecovery(TX));
    } finally {
      vi.restoreAllMocks();
    }
    const submits = calls.filter((call) => call.name === "swap_recovery_accept");
    expect(submits).toHaveLength(2);
    expect(submits[0]).toEqual(submits[1]);
    expect(mocks.key).toHaveBeenCalledTimes(1);
  });

  it("does not submit when durable checkpoint writing fails", async () => {
    const preview = await previewSwapKitRecovery(TX);
    mocks.write.mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(continueSwapKitRecovery(preview)).rejects.toThrow("disk unavailable");
    expect(calls.map((call) => call.name)).toEqual(["swap_recovery_quote"]);
  });

  it("does not submit when a checkpoint write acknowledges without retaining consent", async () => {
    const preview = await previewSwapKitRecovery(TX);
    mocks.write.mockResolvedValueOnce(undefined);
    await expect(continueSwapKitRecovery(preview)).rejects.toThrow(
      "Recovery checkpoint write could not be verified",
    );
    expect(calls.map((call) => call.name)).toEqual(["swap_recovery_quote"]);
  });

  it("refuses mutated acceptance bounds", async () => {
    const preview = await previewSwapKitRecovery(TX);
    offered = { ...offered, minimumReceiveUnits: "1" };
    await expect(continueSwapKitRecovery(preview)).rejects.toThrow("does not match");
    expect(SwapKitOrderStore.list()[0].recoveryConsent?.accepted).toBeUndefined();
  });

  it("keeps the original row on terminal failure, with no legacy sweep or scaled floor", async () => {
    const row = await continueSwapKitRecovery(await previewSwapKitRecovery(TX));
    mocks.loop.mockResolvedValue({ txId: TX, status: "FAILED", terminal: true });
    startSwapKitOrderTracking(row);
    await settle();
    expect(SwapKitOrderStore.list()).toHaveLength(1);
    expect(mocks.recover).not.toHaveBeenCalled();
    expect(mocks.removePending).not.toHaveBeenCalled();
  });

  it("requires final EURC receipt proof before retiring either row kind", async () => {
    const row = await continueSwapKitRecovery(await previewSwapKitRecovery(TX));
    const status = {
      txId: TX,
      status: "COMPLETED",
      to: "EURC_BASE",
      terminal: true,
      legs: [{ terminal: true, txids: [HASH] }],
    };
    mocks.loop.mockResolvedValue(status);
    startSwapKitOrderTracking(row);
    await settle();
    expect(SwapKitOrderStore.list()).toHaveLength(1);
    expect(await recoveryPayoutProven(row, status)).toBe(false);
    mocks.receipt.mockResolvedValue({
      status: "success",
      logs: [
        {
          address: BASE_EURC.address,
          topics: encodeEventTopics({
            abi: erc20Abi,
            eventName: "Transfer",
            args: { from: OTHER as `0x${string}`, to: OWNER },
          }),
          data: encodeAbiParameters([{ type: "uint256" }], [4100000n]),
        },
      ],
    });
    expect(await recoveryPayoutProven(row, status)).toBe(true);
    startSwapKitOrderTracking(row);
    await settle();
    expect(SwapKitOrderStore.list()).toHaveLength(0);
    expect(mocks.removePending).toHaveBeenCalledWith(TX);
  });
});
