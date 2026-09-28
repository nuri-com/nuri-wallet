import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = {
  arkadeSwapIntentCreate: vi.fn(),
};

vi.mock("../ArkadeApiService", () => ({
  arkadeSwapIntentCreate: (...args: unknown[]) => mocks.arkadeSwapIntentCreate(...args),
}));
vi.mock("./identity", () => ({
  getOrCreateArkadeIdentity: async () => ({
    getSwapIntentContext: async () => ({ credIdB64u: "cred", clientPk33: "02".repeat(33) }),
  }),
}));
vi.mock("./logging", () => ({ emitTrace: vi.fn(), logArkadeWalletSignTrace: vi.fn() }));
vi.mock("@arkade-os/sdk", () => ({
  ArkAddress: {
    decode: (address: string) => {
      if (!address.startsWith("ark1")) throw new Error("not an ark address");
      return { pkScript: new Uint8Array([1, 2, 3]) };
    },
  },
}));
vi.mock("@scure/btc-signer", () => ({
  OutScript: { encode: () => new Uint8Array([4, 5, 6]) },
  Address: () => ({ decode: () => ({}) }),
}));

import { createArkadeServerSwapIntent } from "./swapIntents";

const payload = () =>
  mocks.arkadeSwapIntentCreate.mock.calls.at(-1)?.[1] as Record<string, unknown>;

beforeEach(() => {
  mocks.arkadeSwapIntentCreate.mockReset();
  mocks.arkadeSwapIntentCreate.mockResolvedValue({ intent: { id: "intent-1" } });
});

describe("a Lightning refund is its own act", () => {
  // The approval that authorised the payment cannot authorise the return: the
  // server binds this intent to the RFQ, the lockup, the full amount and the
  // destination committed when the payment was made.
  it("binds the refund to its rfq, lockup, amount and destination", async () => {
    await createArkadeServerSwapIntent({
      kind: "lightning_refund",
      finalRecipient: "ark1mine",
      finalAmountSats: 20_060,
      fundingAddress: "ark1mine",
      fundingAmountSats: 20_060,
      provider: "arkade_intents",
      rfqId: "rfq-1",
      lockupAddress: "ark1lockup",
      op: "ln_pay_refund",
    });

    expect(payload()).toMatchObject({
      kind: "lightning_refund",
      final_recipient: "ark1mine",
      final_amount_sats: 20_060,
      funding_amount_sats: 20_060,
      rfq_id: "rfq-1",
      lockup_address: "ark1lockup",
      provider: "arkade_intents",
    });
  });

  // The payment intent carries no lockup and a different kind, so a server
  // enforcing #79 cannot read one as the other.
  it("does not look like a payment intent", async () => {
    await createArkadeServerSwapIntent({
      kind: "lightning_invoice",
      finalRecipient: "lnbc1...",
      finalAmountSats: 20_000,
      fundingAddress: "ark1lockup",
      fundingAmountSats: 20_060,
      provider: "arkade_intents",
      rfqId: "rfq-1",
      op: "ln_pay",
    });

    expect(payload().kind).toBe("lightning_invoice");
    expect(payload().lockup_address).toBeUndefined();
  });
});

describe("a stablecoin purchase states what is bought", () => {
  // On this corridor the sats are the internal Lightning hop. Sending them as
  // `final_amount_sats` renders an "ark send, N sats" approval for what is
  // actually a euro purchase.
  it("sends the output token, amount and chain, and no sats figure", async () => {
    await createArkadeServerSwapIntent({
      kind: "arkade_stablecoin",
      finalRecipient: "0x1111111111111111111111111111111111111111",
      outputAsset: "EURC",
      outputAmount: 10.556502,
      outputChain: "base",
      fundingAddress: "ark1lockup",
      fundingAmountSats: 20_060,
      provider: "arkade_intents",
      rfqId: "rfq-1",
      routeId: "arkade-intents-btc-ln-bitcoinvn-eurc-base",
      refundLocktime: 1_800_000_000,
      op: "ark_swap_intents",
    });

    expect(payload()).toMatchObject({
      kind: "arkade_stablecoin",
      final_recipient: "0x1111111111111111111111111111111111111111",
      output_asset: "EURC",
      output_amount: 10.556502,
      output_chain: "base",
      funding_amount_sats: 20_060,
      route_id: "arkade-intents-btc-ln-bitcoinvn-eurc-base",
    });
    expect(payload().final_amount_sats).toBeUndefined();
    expect(payload().invoice).toBeUndefined();
    expect(payload().payment_hash).toBeUndefined();
  });

  it("refuses a purchase that does not say what it delivers", async () => {
    await expect(
      createArkadeServerSwapIntent({
        kind: "arkade_stablecoin",
        finalRecipient: "0x1111111111111111111111111111111111111111",
        fundingAddress: "ark1lockup",
        fundingAmountSats: 20_060,
        op: "ark_swap_intents",
      }),
    ).rejects.toThrow(/output required/);
    expect(mocks.arkadeSwapIntentCreate).not.toHaveBeenCalled();
  });
});
