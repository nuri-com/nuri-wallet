import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  refund: vi.fn(),
  getCacheValue: vi.fn(),
  setCacheValue: vi.fn(),
  errorWithId: vi.fn(),
  hydrateOrders: vi.fn(),
  listOrders: vi.fn(),
  addOrder: vi.fn(),
  getArkadeReceiveAddress: vi.fn(),
  sendArkade: vi.fn(),
  claim: vi.fn(),
}));

vi.mock("../../lib/OperationLogUtils", () => ({
  LOG_EMOJI: { bitcoin: "" },
  errorWithId: mocks.errorWithId,
  logWithId: vi.fn(),
}));
vi.mock("./SwapKitService", () => ({
  submitSwapKitWalletAction: mocks.submit,
}));
vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: mocks.getCacheValue,
  setCacheValue: mocks.setCacheValue,
}));
vi.mock("./SwapKitArkadeVhtlcService", () => ({
  refundSwapKitArkadeVhtlc: mocks.refund,
  claimSwapKitArkadeVhtlc: mocks.claim,
}));
vi.mock("./SwapKitOrderStore", () => ({
  SwapKitOrderStore: {
    hydrate: mocks.hydrateOrders,
    list: mocks.listOrders,
    add: mocks.addOrder,
  },
}));
vi.mock("../arkade/ArkadeAddressService", () => ({
  getArkadeReceiveAddress: mocks.getArkadeReceiveAddress,
}));
vi.mock("../arkade/ArkadeSendService", () => ({
  sendArkadeToArk: mocks.sendArkade,
}));

import { handleSwapKitArkadeAction } from "./SwapKitArkadeActionService";

const sendAction = {
  type: "arkade_vhtlc_v1",
  actionId: "send-action-1",
  provider: "arkade",
  request: { kind: "send", to: "ark1destination", amountSats: 1000 },
};

const claimAction = (destinationAddress: string) => ({
  type: "arkade_vhtlc_v1",
  actionId: "claim-action-1",
  provider: "satora",
  keyRef: { provider: "satora", keyIndex: 7, preimageHash: "abcd" },
  request: { kind: "claim_vhtlc", destinationAddress, vhtlc: { refundLocktime: 0 } },
});

const refundAction = (refundLocktime: number) => ({
  type: "arkade_vhtlc_v1",
  actionId: "refund-action-1",
  provider: "satora",
  keyRef: { provider: "satora", keyIndex: 7 },
  request: {
    kind: "refund_vhtlc",
    destinationAddress: "ark1destination",
    vhtlc: { refundLocktime },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCacheValue.mockResolvedValue(null);
  mocks.hydrateOrders.mockResolvedValue(undefined);
  mocks.listOrders.mockReturnValue([
    { txId: "sk_refund", arkadeRefundAddress: "ark1destination" },
    { txId: "sk_send", sats: 1000, arkadeRefundAddress: "ark1destination" },
  ]);
  mocks.getArkadeReceiveAddress.mockResolvedValue("ark1destination");
  mocks.sendArkade.mockResolvedValue("ark-send-txid");
  mocks.claim.mockResolvedValue("ark-claim-txid");
  mocks.setCacheValue.mockResolvedValue(undefined);
  mocks.submit.mockResolvedValue(undefined);
});

describe("Arkade VHTLC claim destination binding", () => {
  it("rejects a claim destination that differs from the order's local address", async () => {
    // Local receive address resolves to ark1destination; the server asks to
    // claim to a substituted same-network address instead.
    await expect(
      handleSwapKitArkadeAction(claimAction("ark1attacker"), { txId: "sk_claim" }),
    ).rejects.toThrow(/does not match this order's local address/);

    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("claims to the wallet's own local address when the destination matches", async () => {
    await handleSwapKitArkadeAction(claimAction("ark1destination"), { txId: "sk_claim" });

    expect(mocks.claim).toHaveBeenCalledWith(
      expect.objectContaining({ destinationAddress: "ark1destination" }),
    );
    expect(mocks.submit).toHaveBeenCalled();
  });
});

describe("Arkade VHTLC journal state", () => {
  it("does not replay a submitted-but-unfinalized txid as a completed action", async () => {
    // Review finding on #1450: journaling the arkTxid at submit made an
    // interrupted claim look done, so the replay returned success and the pending
    // tx was never finalized.
    mocks.getCacheValue.mockResolvedValue({
      "claim-action-1": { txid: "ark-pending-txid", finalized: false },
    });

    await handleSwapKitArkadeAction(claimAction("ark1destination"), { txId: "sk_claim" });

    expect(mocks.claim).toHaveBeenCalledTimes(1);
    expect(mocks.submit).toHaveBeenCalled();
  });

  it("replays a finalized txid without touching the wallet", async () => {
    mocks.getCacheValue.mockResolvedValue({
      "claim-action-1": { txid: "ark-done-txid", finalized: true },
    });

    await handleSwapKitArkadeAction(claimAction("ark1destination"), { txId: "sk_claim" });

    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.submit).toHaveBeenCalledWith(expect.objectContaining({ txHash: "ark-done-txid" }));
  });

  it("still replays a legacy bare-string entry", async () => {
    mocks.getCacheValue.mockResolvedValue({ "claim-action-1": "ark-legacy-txid" });

    await handleSwapKitArkadeAction(claimAction("ark1destination"), { txId: "sk_claim" });

    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: "ark-legacy-txid" }),
    );
  });

  it("marks the action pending at submit and complete only after the whole claim returns", async () => {
    const events: string[] = [];
    mocks.setCacheValue.mockImplementation(async (_key: string, value: unknown) => {
      events.push(JSON.stringify(value));
    });
    mocks.claim.mockImplementation(
      async (args: { onSubmittedArkTxid?: (txid: string) => Promise<void> }) => {
        await args.onSubmittedArkTxid?.("ark-claim-txid");
        events.push("claim-returned");
        return "ark-claim-txid";
      },
    );

    await handleSwapKitArkadeAction(claimAction("ark1destination"), { txId: "sk_claim" });

    // Pending first, and nothing marks the action complete until the claim for
    // EVERY VTXO came back: a per-VTXO completion write would strand the rest.
    expect(events[0]).toBe(
      JSON.stringify({ "claim-action-1": { txid: "ark-claim-txid", finalized: false } }),
    );
    expect(events).toContain("claim-returned");
    expect(events.at(-1)).toBe(JSON.stringify({ "claim-action-1": "ark-claim-txid" }));
  });

  it("hands a journaled pending txid to the claim so a finalized-but-unjournaled tx is not lost", async () => {
    mocks.getCacheValue.mockResolvedValue({
      "claim-action-1": { txid: "ark-pending-txid", finalized: false },
    });

    await handleSwapKitArkadeAction(claimAction("ark1destination"), { txId: "sk_claim" });

    expect(mocks.claim).toHaveBeenCalledWith(
      expect.objectContaining({ previouslySubmittedArkTxid: "ark-pending-txid" }),
    );
  });
});

describe("Arkade VHTLC send funded boundary", () => {
  it("fires onFunded once the send is journaled, before submit — even if submit fails", async () => {
    const events: string[] = [];
    mocks.setCacheValue.mockImplementation(async () => {
      events.push("journal");
    });
    mocks.submit.mockImplementation(async () => {
      events.push("submit");
      throw new Error("swap_wallet_submit failed");
    });
    const onFunded = vi.fn(() => {
      events.push("funded");
    });

    await expect(
      handleSwapKitArkadeAction(sendAction, { txId: "sk_send" }, onFunded),
    ).rejects.toThrow("swap_wallet_submit failed");

    expect(onFunded).toHaveBeenCalledTimes(1);
    // The boundary is marked after journaling and BEFORE the submit that failed.
    expect(events).toEqual(["journal", "funded", "submit"]);
  });

  it("awaits an async onFunded before continuing to submit (persistence ordering)", async () => {
    // A caller persists its pending row inside onFunded. The handler must not
    // continue to submit — and let the loop reach terminal + run cleanup —
    // while that write is still in flight.
    let resolveFunded!: () => void;
    const submitted = vi.fn();
    mocks.submit.mockImplementation(async () => {
      submitted();
    });
    const onFunded = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFunded = resolve;
        }),
    );

    const pending = handleSwapKitArkadeAction(sendAction, { txId: "sk_send" }, onFunded);
    await new Promise((r) => setTimeout(r, 0));

    expect(onFunded).toHaveBeenCalledTimes(1);
    expect(submitted).not.toHaveBeenCalled(); // blocked until the funded persist resolves

    resolveFunded();
    await pending;
    expect(submitted).toHaveBeenCalledTimes(1);
  });

  it("does not fire onFunded when the send itself fails before broadcast", async () => {
    mocks.sendArkade.mockRejectedValueOnce(new Error("ark send failed"));
    const onFunded = vi.fn();

    await expect(
      handleSwapKitArkadeAction(sendAction, { txId: "sk_send" }, onFunded),
    ).rejects.toThrow("ark send failed");

    expect(onFunded).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("refuses to fund a bounds-less order (a discovered row re-listed by the server)", async () => {
    // Owner discovery re-imports an abandoned order as a bounds-less
    // `discovered` row; no locally bound order exists for this txId.
    const onFunded = vi.fn();

    await expect(
      handleSwapKitArkadeAction(sendAction, { txId: "sk_discovered" }, onFunded),
    ).rejects.toThrow(/no locally bound order/);

    expect(mocks.sendArkade).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(onFunded).not.toHaveBeenCalled();
  });
});

describe("Arkade VHTLC refund readiness", () => {
  it("signals not-ready before wall-clock locktime instead of returning success", async () => {
    const future = Math.floor(Date.now() / 1000) + 600;

    await expect(
      handleSwapKitArkadeAction(refundAction(future), { txId: "sk_refund" }),
    ).rejects.toThrow("Arkade VHTLC refund locktime not reached");
    expect(mocks.refund).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.errorWithId).not.toHaveBeenCalled();
  });

  it("propagates the Ark server's chain-time rejection into the loop backoff", async () => {
    const locked = new Error("FORFEIT_CLOSURE_LOCKED (11): 1784471181 > 1784468590 (blocktime)");
    mocks.refund.mockRejectedValueOnce(locked);

    await expect(
      handleSwapKitArkadeAction(refundAction(Math.floor(Date.now() / 1000) - 1), {
        txId: "sk_refund",
      }),
    ).rejects.toBe(locked);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.errorWithId).not.toHaveBeenCalled();
  });

  it("rejects a refund destination that differs from the order's local address", async () => {
    const action = refundAction(Math.floor(Date.now() / 1000) - 1);
    action.request.destinationAddress = "ark1attacker";

    await expect(handleSwapKitArkadeAction(action, { txId: "sk_refund" })).rejects.toThrow(
      "refund destination does not match",
    );
    expect(mocks.refund).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("derives and persists the local address for a legacy order before refunding", async () => {
    mocks.listOrders.mockReturnValueOnce([{ txId: "sk_refund" }]);
    mocks.refund.mockResolvedValueOnce("ark-refund-txid");

    await handleSwapKitArkadeAction(refundAction(Math.floor(Date.now() / 1000) - 1), {
      txId: "sk_refund",
    });

    expect(mocks.addOrder).toHaveBeenCalledWith({
      txId: "sk_refund",
      arkadeRefundAddress: "ark1destination",
    });
    expect(mocks.refund).toHaveBeenCalledWith(
      expect.objectContaining({ destinationAddress: "ark1destination" }),
    );
  });
});

describe("Arkade journal — concurrent orders", () => {
  it("does not lose a concurrent order's txid (serialized load/modify/write)", async () => {
    // Shared journal backed by a holder; getCacheValue returns a COPY and
    // setCacheValue REPLACES the whole value, exactly like the real store. The
    // tick before each op lets two concurrent writes interleave if unserialized.
    let journal: Record<string, string> = {};
    mocks.getCacheValue.mockImplementation(async () => {
      await Promise.resolve();
      return { ...journal };
    });
    mocks.setCacheValue.mockImplementation(async (_key: string, value: unknown) => {
      await Promise.resolve();
      journal = { ...(value as Record<string, string>) };
    });
    mocks.sendArkade.mockResolvedValueOnce("txid-A").mockResolvedValueOnce("txid-B");
    mocks.listOrders.mockReturnValue([
      { txId: "sk_A", sats: 1000, arkadeRefundAddress: "ark1destination" },
      { txId: "sk_B", sats: 1000, arkadeRefundAddress: "ark1destination" },
    ]);

    const orderA = { ...sendAction, actionId: "send-A" };
    const orderB = { ...sendAction, actionId: "send-B" };
    await Promise.all([
      handleSwapKitArkadeAction(orderA, { txId: "sk_A" }),
      handleSwapKitArkadeAction(orderB, { txId: "sk_B" }),
    ]);

    // Both orders' txids survive — neither write clobbered the other.
    expect(Object.keys(journal).sort()).toEqual(["send-A", "send-B"]);
    expect(journal["send-A"]).toBeTruthy();
    expect(journal["send-B"]).toBeTruthy();
  });
});
