import { beforeEach, describe, expect, it, vi } from "vitest";

// Taner #3 (ed888cb9) — the MuSig2 send_asset funder recorded STARTED from the
// synchronous, un-awaited `onStatus("broadcasting")`, so the broadcast could
// reach the wire before the marker was durable. `onBeforeBroadcast` is awaited
// by the service BEFORE it broadcasts, and a throw there aborts the send.
const order: string[] = [];
const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
}));

vi.mock("../../lib/bitcoin/buildBitcoinSendPsbt", () => ({
  buildBitcoinSendPsbt: vi.fn().mockResolvedValue({ psbtB64: "", sats: 1000, fee: 100n }),
  estimateBitcoinSendFeeSats: vi.fn(),
}));
vi.mock("../../lib/bytes", () => ({
  base64ToBytes: () => new Uint8Array(),
  bytesToHex: () => "00",
}));
vi.mock("@scure/btc-signer", () => ({ Transaction: { fromPSBT: () => ({}) } }));
vi.mock("../arkade/internal/browserApproval", () => ({
  withOutgoingBrowserApproval: (_req: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("../arkade/internal/identity", () => ({
  getOrCreateArkadeIdentity: async () => ({
    sign: async () => ({ finalize: () => {}, extract: () => new Uint8Array() }),
  }),
}));
vi.mock("../arkade/internal/swapIntents", () => ({
  createArkadeServerSwapIntent: async () => "si_1",
}));
vi.mock("../arkade/internal/utils", () => ({ truncateForLog: (s: string) => s }));
vi.mock("./BlockchainService", () => ({
  blockchainService: { broadcastTransaction: mocks.broadcast },
}));
vi.mock("./WalletService", () => ({
  walletService: { getMusig2SendSource: () => ({ address: "bc1q" }) },
}));

import { sendBitcoinOnchainFromMusig2 } from "./OnchainSendService";

beforeEach(() => {
  order.length = 0;
  mocks.broadcast.mockReset().mockImplementation(async () => {
    order.push("broadcast");
    return "ab".repeat(32);
  });
});

describe("MuSig2 send broadcast boundary", () => {
  it("awaits onBeforeBroadcast to completion before broadcasting", async () => {
    await sendBitcoinOnchainFromMusig2({
      toAddress: "bc1qdeposit",
      amountSats: 1000,
      onBeforeBroadcast: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("marked");
      },
    });
    expect(order).toEqual(["marked", "broadcast"]);
  });

  it("does not broadcast when the marker write fails", async () => {
    await expect(
      sendBitcoinOnchainFromMusig2({
        toAddress: "bc1qdeposit",
        amountSats: 1000,
        onBeforeBroadcast: async () => {
          throw new Error("storage unavailable");
        },
      }),
    ).rejects.toThrow(/storage unavailable/);
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });
});
