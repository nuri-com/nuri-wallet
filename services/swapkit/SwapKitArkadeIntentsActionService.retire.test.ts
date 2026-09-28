import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = {
  trackSwapKitSwap: vi.fn(),
  listArkadeLightningSends: vi.fn(),
  deleteArkadeLightningSend: vi.fn(async (..._args: unknown[]) => undefined),
  getArkadeLightningSendOwnerKey: vi.fn(async () => "owner-1"),
};

vi.mock("./SwapKitService", async () => {
  const TERMINAL = new Set(["COMPLETED", "FAILED", "REFUNDED", "EXPIRED"]);
  return {
    // The canonical predicate, copied in shape from SwapKitService: `terminal`
    // is optional on the response, so a status alone has to be enough.
    isTerminal: (tx: { terminal?: boolean; status?: string }) =>
      tx.terminal === true || TERMINAL.has(String(tx.status || "").toUpperCase()),
    trackSwapKitSwap: (txId: string, args?: unknown) => mocks.trackSwapKitSwap(txId, args),
    submitSwapKitWalletAction: vi.fn(async (..._args: unknown[]) => undefined),
  };
});
// Now that the service imports its app modules statically — so the PWA's single
// bundle can resolve them — the ones that reach the Arkade SDK have to be
// stubbed here too, or vitest tries to transform it.
// The intents action service now imports walletCache statically (no-dynamic-imports rule);
// cut the wallet-bootstrap graph here — these tests never construct a wallet.
vi.mock("../arkade/internal/walletCache", () => ({
  getOrCreateWallet: async () => {
    throw new Error("no wallet in unit tests");
  },
}));

vi.mock("../arkade/internal/browserApproval", () => ({
  withOutgoingBrowserApproval: vi.fn(),
}));
vi.mock("../arkade/internal/swapIntents", () => ({
  createArkadeServerSwapIntent: vi.fn(),
}));
vi.mock("../arkade/internal/lightningSendStore", () => ({
  listArkadeLightningSends: (owner: string) => mocks.listArkadeLightningSends(owner),
  deleteArkadeLightningSend: (owner: string, rfqId: string) =>
    mocks.deleteArkadeLightningSend(owner, rfqId),
  getArkadeLightningSendOwnerKey: () => mocks.getArkadeLightningSendOwnerKey(),
}));

import { checkArkadeIntentsLightningSends } from "./SwapKitArkadeIntentsActionService";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getArkadeLightningSendOwnerKey.mockResolvedValue("owner-1");
  mocks.listArkadeLightningSends.mockResolvedValue([{ rfqId: "rfq-1", txId: "order-1" }]);
});

describe("retiring a persisted Lightning send", () => {
  // `terminal` is optional on the track response. A status-only answer used to
  // leave the record behind, and it was then re-polled on every wallet-summary
  // wake for as long as the wallet existed.
  it.each([["COMPLETED"], ["REFUNDED"], ["FAILED"], ["EXPIRED"]])(
    "drops the record on a status-only %s",
    async (status) => {
      mocks.trackSwapKitSwap.mockResolvedValue({ status, actions: [] });

      await checkArkadeIntentsLightningSends("test");

      expect(mocks.deleteArkadeLightningSend).toHaveBeenCalledWith("owner-1", "rfq-1");
    },
  );

  it("drops the record on the explicit terminal flag", async () => {
    mocks.trackSwapKitSwap.mockResolvedValue({ terminal: true, status: "PROCESSING", actions: [] });

    await checkArkadeIntentsLightningSends("test");

    expect(mocks.deleteArkadeLightningSend).toHaveBeenCalledWith("owner-1", "rfq-1");
  });

  // The store fails closed when its durable funding outbox cannot be read.
  // Propagate that wake-up failure before tracking anything: a bare terminal
  // poll must never delete the only refund record while its txid is temporarily
  // unreadable.
  it("does no tracking or deletion when the funding store cannot be read", async () => {
    mocks.listArkadeLightningSends.mockRejectedValue(new Error("funding outbox unavailable"));

    await expect(checkArkadeIntentsLightningSends("test")).rejects.toThrow(
      /funding outbox unavailable/,
    );

    expect(mocks.trackSwapKitSwap).not.toHaveBeenCalled();
    expect(mocks.deleteArkadeLightningSend).not.toHaveBeenCalled();
  });

  // Still live: the record is the only handle the refund has, so it stays.
  it("keeps the record while the swap is still running", async () => {
    mocks.trackSwapKitSwap.mockResolvedValue({ status: "PROCESSING", actions: [] });

    await checkArkadeIntentsLightningSends("test");

    expect(mocks.deleteArkadeLightningSend).not.toHaveBeenCalled();
  });

  // #243 (Codex P1): the one-shot funding report at send time can be lost to a
  // transient failure after the sats have left the wallet. On every wake, the
  // poller must re-send the persisted funding hash as depositTxHash so the
  // server can arm the solver-timeout refund — never re-track bare when a hash
  // is on the record.
  it("re-reports the persisted funding hash on every poll until terminal", async () => {
    mocks.listArkadeLightningSends.mockResolvedValue([
      { rfqId: "rfq-1", txId: "order-1", fundingTxid: "fund-abc" },
    ]);
    mocks.trackSwapKitSwap.mockResolvedValue({ status: "PROCESSING", actions: [] });

    await checkArkadeIntentsLightningSends("test");

    expect(mocks.trackSwapKitSwap).toHaveBeenCalledWith("order-1", { depositTxHash: "fund-abc" });
    expect(mocks.deleteArkadeLightningSend).not.toHaveBeenCalled();
  });

  // A record with no funding hash yet (crash before the wallet ever sent) must
  // still track bare — reporting an empty hash is not evidence of funding.
  it("tracks bare when no funding hash is persisted", async () => {
    mocks.listArkadeLightningSends.mockResolvedValue([{ rfqId: "rfq-1", txId: "order-1" }]);
    mocks.trackSwapKitSwap.mockResolvedValue({ status: "PROCESSING", actions: [] });

    await checkArkadeIntentsLightningSends("test");

    expect(mocks.trackSwapKitSwap).toHaveBeenCalledWith("order-1", {});
  });
});
