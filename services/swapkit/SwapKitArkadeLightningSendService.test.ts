import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `@arkade-os/sdk` cannot be transformed by vitest; the mock keeps it out of the
// graph entirely. Only the address predicate is used from it here.
vi.mock("@arkade-os/sdk", () => ({
  isValidArkAddress: (address: string) => String(address || "").startsWith("ark1"),
}));
vi.mock("./SwapKitService", () => ({
  SWAPKIT_WALLET_CAPABILITIES: ["pay_lightning_invoice"],
  assertSupportedSwapActions: vi.fn(),
  executeSwapKitSwap: vi.fn(),
}));

const v2 = vi.hoisted(() => ({
  quote: vi.fn(),
  commit: vi.fn(),
  submit: vi.fn(),
  persist: vi.fn(),
  resolve: vi.fn(),
  abandon: vi.fn(),
}));
vi.mock("./SwapKitV2Service", () => ({
  quoteSwapKitV2: v2.quote,
  commitSwapKitV2: v2.commit,
  asSwapKitV2OrderId: (id: string) => id,
}));
vi.mock("./SwapKitV2ActionService", () => ({ executeAndSubmitV2Action: v2.submit }));
vi.mock("./SwapKitV2OrderStore", () => ({
  abandonV2CommitIntent: v2.abandon,
  persistV2CommitIntent: v2.persist,
  resolveV2CommitIntent: v2.resolve,
}));
vi.mock("./SwapKitV2RecoveryKey", () => ({ getSwapKitV2RecoveryKey: async () => "r".repeat(64) }));
vi.mock("../../lib/secureKeyStorage", () => ({ getEthereumAddress: async () => "0xowner" }));
import type { SwapKitCreateResponse } from "./SwapKitService";
import {
  assertNoUnhandledCreateActions,
  readArkadeIntentsCreate,
} from "./SwapKitArkadeIntentsCreate";
import {
  assertLightningSettleAmount,
  createArkadeIntentsLightningSend,
  isArkadeLightningAmountInRange,
} from "./SwapKitArkadeLightningSendService";

const INVOICE_SATS = 10_000;

function buildResponse(over: Record<string, unknown> = {}): SwapKitCreateResponse {
  return {
    txId: "order-1",
    rfqId: "rfq-1",
    refundLocktime: 1_800_000_000,
    settleAmountSats: INVOICE_SATS,
    fund: {
      sendToAddress: "ark1lockup",
      // 30 bps on top of the invoice — what the lockup must carry.
      amountSats: 10_030,
      amount: 0.0001003,
    },
    ...over,
  } as SwapKitCreateResponse;
}

describe("readArkadeIntentsCreate", () => {
  it("reads the exact funding figures off a well-formed route result", () => {
    const details = readArkadeIntentsCreate(buildResponse(), { minFundAmountSats: INVOICE_SATS });

    expect(details).toEqual({
      txId: "order-1",
      rfqId: "rfq-1",
      refundLocktime: 1_800_000_000,
      lockupAddress: "ark1lockup",
      fundAmountSats: 10_030,
    });
  });

  it.each([
    ["order id", { txId: "", orderId: "" }],
    ["rfqId", { rfqId: "" }],
    ["refund locktime", { refundLocktime: 0 }],
  ])("refuses a result with no %s", (_label, over) => {
    expect(() =>
      readArkadeIntentsCreate(buildResponse(over), { minFundAmountSats: INVOICE_SATS }),
    ).toThrow();
  });

  // Funding a non-Arkade address would send offchain funds down a rail the
  // corridor never quoted.
  it("refuses a lockup address that is not an Arkade address", () => {
    const response = buildResponse({
      fund: { sendToAddress: "bc1qlockup", amountSats: 10_030 },
    });

    expect(() => readArkadeIntentsCreate(response, { minFundAmountSats: INVOICE_SATS })).toThrow(
      /Arkade lockup/,
    );
  });

  // The fee is a spread: the lockup always carries more than the invoice, so a
  // smaller figure is a quote for some other payment.
  it("refuses a funding amount below the invoice", () => {
    const response = buildResponse({ fund: { sendToAddress: "ark1lockup", amountSats: 9_999 } });

    expect(() => readArkadeIntentsCreate(response, { minFundAmountSats: INVOICE_SATS })).toThrow(
      /below the invoice amount/,
    );
  });

  it("refuses a missing or zero funding amount rather than falling back to `amount`", () => {
    const response = buildResponse({ fund: { sendToAddress: "ark1lockup", amount: 0.0001003 } });

    expect(() => readArkadeIntentsCreate(response, { minFundAmountSats: INVOICE_SATS })).toThrow(
      /exact funding amount/,
    );
  });
});

describe("assertLightningSettleAmount", () => {
  // A settle figure that disagrees with the decoded invoice means the route is
  // quoting a different payment than the user scanned.
  it("refuses a settle amount that does not match the invoice", () => {
    const response = buildResponse({ settleAmountSats: INVOICE_SATS - 1 });

    expect(() => assertLightningSettleAmount(response, INVOICE_SATS)).toThrow(/settle amount/);
  });

  it("accepts a matching settle amount", () => {
    expect(() => assertLightningSettleAmount(buildResponse(), INVOICE_SATS)).not.toThrow();
  });

  // The corridor is exact-out and the invoice is decoded locally, so a route
  // that states no settle figure is not a reason to refuse.
  it("accepts a result that states no settle amount at all", () => {
    const response = buildResponse({ settleAmountSats: undefined });

    expect(() => assertLightningSettleAmount(response, INVOICE_SATS)).not.toThrow();
  });
});

describe("isArkadeLightningAmountInRange", () => {
  it.each([
    [499, false],
    [500, true],
    [50_000, true],
    [50_001, false],
    [Number.NaN, false],
  ])("bounds %s as %s", (sats, expected) => {
    expect(isArkadeLightningAmountInRange(sats)).toBe(expected);
  });
});

// The invoice is real (Wallet of Satoshi, 1000 sats, 30-day expiry), so the
// decoding is the production one. The clock moves instead of the invoice: an
// expired fixture would decode differently on the day it was minted and on
// every day after.
const REAL_INVOICE =
  "lnbc10u1p4873xjpp53ufjx7tcchyxpe7sp6dp0a7qkgmuehczfds5ffnc7q08jngdflvqsp5yjf275z3c78ze50kvz6wxplar7fryhpn43vgmk7m409rsrknjmzqxq9z0rgqnp4qvyndeaqzman7h898jxm98dzkm0mlrsx36s93smrur7h0azyyuxc5rzjq25carzepgd4vqsyn44jrk85ezrpju92xyrk9apw4cdjh6yrwt5jgqqqqrt49lmtcqqqqqqqqqqq86qq9qrzjqt0lme2qkp6ew0sxxupxp6vtnz270pn55szmsxp5e2z3pugthx0n9apyqr6zgqqqq8hxk2qqae4jsqyugqcqzpudz22pshjgr5dus9wctvd3jhggr0vcs9xct5daeks6fqw4ek2u36yp582mn8wfuhx6twvajhyv3e8q9qyyssq7ylyh7n428l8amedr56ezk6jyn6rfls7zxlarz5780gqnrfn8h2xnt59h989hcwkjwcnh9flt76yqmasgmjnxxpkxmwfvw9rvhrcypsp3p505k";

// Inside the invoice's own window, and past it. Its expiry is 2026-09-13.
const BEFORE_EXPIRY = new Date("2026-08-20T00:00:00Z");
const AFTER_EXPIRY = new Date("2026-10-01T00:00:00Z");

// `fund.amountSats` is the exact integer the covenant must carry. Anything else
// is refused rather than made into an integer: a lockup funded short is one the
// solver will not fill, and the user waits out the refund timelock for nothing.
// This corridor runs exactly one thing — the funding send it performs itself.
// An action it does not run is work nobody will do, and funding the lockup
// anyway pays for a route that cannot complete. "Supported somewhere in the
// app" is not the same as "handled on this path".
describe("create-time actions", () => {
  it("accepts a create whose only action is the funding send", () => {
    expect(() => assertNoUnhandledCreateActions([{ type: "send_asset" }])).not.toThrow();
  });

  it("accepts a create with no actions at all", () => {
    expect(() => assertNoUnhandledCreateActions(undefined)).not.toThrow();
    expect(() => assertNoUnhandledCreateActions([])).not.toThrow();
  });

  it.each([
    ["a wallet-assisted EVM leg", "sign_and_broadcast_evm_tx"],
    ["a typed-data signature", "sign_typed_data"],
    ["another corridor's VHTLC", "arkade_vhtlc_v1"],
  ])("refuses %s", (_label, type) => {
    expect(() => assertNoUnhandledCreateActions([{ type }])).toThrow(/does not run/);
  });
});

describe("the exact funding amount", () => {
  it.each([
    ["a fractional amount", 1000.9],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 2],
    ["a non-numeric value", "one thousand"],
    ["nothing at all", undefined],
    ["zero", 0],
  ])("refuses %s", (_label, amountSats) => {
    expect(() =>
      readArkadeIntentsCreate(
        buildResponse({ fund: { sendToAddress: "ark1lockup", amountSats, amount: 0.00001 } }),
        { minFundAmountSats: 1000 },
      ),
    ).toThrow(/funding amount|below the invoice/);
  });

  // No computed ceiling: Arkade's from_amount is the exact, binding lockup
  // amount (docs: "the spread between from_amount and to_amount is the complete
  // cost"). The wallet takes it as given — the drain guard is the balance check
  // and the user approving this exact amount, not a recomputed fee bound.
  it("accepts Arkade's exact from_amount without recomputing a fee ceiling", () => {
    const details = readArkadeIntentsCreate(
      buildResponse({
        fund: { sendToAddress: "ark1lockup", amountSats: 20_500, amount: 0.000205 },
      }),
      { minFundAmountSats: 20_000 },
    );

    expect(details.fundAmountSats).toBe(20_500);
  });

  it("accepts the solver's real small-invoice quote (500 invoice -> 505 lockup)", () => {
    // The live solver quotes fromAmount 505 for a 500-sat invoice (a per-quote
    // minimum, above a naive 30-bps 502). A computed ceiling rejected this; the
    // exact from_amount is simply accepted.
    const details = readArkadeIntentsCreate(
      buildResponse({
        fund: { sendToAddress: "ark1lockup", amountSats: 505, amount: 0.00000505 },
      }),
      { minFundAmountSats: 500 },
    );

    expect(details.fundAmountSats).toBe(505);
  });

  it("still refuses a lockup below the invoice amount", () => {
    expect(() =>
      readArkadeIntentsCreate(
        buildResponse({
          fund: { sendToAddress: "ark1lockup", amountSats: 490, amount: 0.0000049 },
        }),
        { minFundAmountSats: 500 },
      ),
    ).toThrow(/below the invoice amount/);
  });

  it("takes an exact integer unchanged", () => {
    const details = readArkadeIntentsCreate(
      buildResponse({
        fund: { sendToAddress: "ark1lockup", amountSats: 10_030, amount: 0.0001003 },
      }),
      { minFundAmountSats: INVOICE_SATS },
    );

    expect(details.fundAmountSats).toBe(10_030);
  });
});

// Against the PRODUCTION decoder, no stub: the invoice carries an explicit `x`
// tag of 2 592 000 seconds, so its deadline is its own timestamp plus thirty
// days. Reading the decoder's top-level getter instead of the tag would put it
// decades out on the build that returns an absolute time, and the expiry gate
// would never fire for any invoice.
describe("the invoice's real expiry", () => {
  it("is the timestamp plus its own expiry tag", async () => {
    const { decodeBolt11Facts } = await import("../../lib/bitcoin/lightning");
    const facts = decodeBolt11Facts(REAL_INVOICE);

    expect(facts.amountSats).toBe(1000);
    // 2026-09-13T16:39:46Z — thirty days after the invoice was minted, not one
    // hour after it and not a decade.
    expect(facts.expiresAt).toBe(1_789_317_586);
  });
});

describe("createArkadeIntentsLightningSend", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // An expired invoice cannot be settled by anyone, and this rail funds a
  // lockup before the solver ever tries — paying one buys a refund to wait out.
  it("refuses an expired invoice before anything is quoted", async () => {
    vi.setSystemTime(AFTER_EXPIRY);

    await expect(
      createArkadeIntentsLightningSend({
        invoice: REAL_INVOICE,
        senderPublicKey: "ab".repeat(32),
        refundAddress: "ark1mine",
      }),
    ).rejects.toThrow(/expired/);

    const { executeSwapKitSwap } = await import("./SwapKitService");
    expect(executeSwapKitSwap).not.toHaveBeenCalled();
  });

  it("carries an unexpired invoice through to the route", async () => {
    vi.setSystemTime(BEFORE_EXPIRY);
    v2.quote.mockResolvedValue({
      options: [
        {
          optionId: "arkade",
          depositAmount: "0.00001003",
          settleAmount: "0.00001",
          requiredCapabilities: [
            "arkade_refund_material",
            "arkade_intents_fund",
            "arkade_intents_refund",
          ],
        },
      ],
    });
    v2.commit.mockResolvedValue({
      orderId: "ord_ln",
      status: "AWAITING_ACTION",
      actions: [
        {
          kind: "arkade_refund_material",
          state: "ready",
          actionId: "material",
          request: { scope: "ord_ln" },
        },
      ],
    });
    v2.submit.mockResolvedValue({
      orderId: "ord_ln",
      status: "AWAITING_ACTION",
      publicRecovery: {
        rfqId: "rfq",
        refundLocktime: 1_900_000_000,
        lockupAddress: "ark1lockup",
        destinationAddress: "ark1mine",
        senderPublicKey: "ab".repeat(32),
        amountSats: 1003,
      },
      actions: [
        {
          kind: "arkade_intents_fund",
          state: "ready",
          request: { to: "ark1lockup", amountSats: 1003, asset: "BTC_ARKADE" },
        },
      ],
    });
    const result = await createArkadeIntentsLightningSend({
      invoice: REAL_INVOICE,
      senderPublicKey: "ab".repeat(32),
      refundAddress: "ark1mine",
    });
    expect(result.fundAmountSats).toBe(1003);
    expect(v2.quote).toHaveBeenCalledWith(
      expect.objectContaining({ amount: "0.00001000", side: "settle", settleTarget: REAL_INVOICE }),
    );
    expect(v2.persist.mock.invocationCallOrder[0]).toBeLessThan(
      v2.commit.mock.invocationCallOrder[0],
    );
    expect(v2.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        acceptedDepositAmount: "0.00001003",
        minimumSettleAmount: "0.00001000",
        recoveryKey: "r".repeat(64),
      }),
    );
  });

  // Nothing is signed before the commit reply names the order, so a lost
  // reply is a plain failure: the intent goes, and paying again is safe.
  it("drops the commit intent when the commit reply does not come back", async () => {
    for (const fn of Object.values(v2)) fn.mockReset();
    vi.setSystemTime(BEFORE_EXPIRY);
    v2.quote.mockResolvedValue({
      options: [
        {
          optionId: "arkade",
          depositAmount: "0.00001003",
          settleAmount: "0.00001",
          requiredCapabilities: [
            "arkade_refund_material",
            "arkade_intents_fund",
            "arkade_intents_refund",
          ],
        },
      ],
    });
    const lost = new Error("Network request failed");
    v2.commit.mockRejectedValue(lost);
    v2.abandon.mockResolvedValue(undefined);

    await expect(
      createArkadeIntentsLightningSend({
        invoice: REAL_INVOICE,
        senderPublicKey: "ab".repeat(32),
        refundAddress: "ark1mine",
      }),
    ).rejects.toBe(lost);

    expect(v2.abandon).toHaveBeenCalledWith(v2.persist.mock.calls.at(-1)?.[0].idempotencyKey);
    expect(v2.submit).not.toHaveBeenCalled();
  });
});
