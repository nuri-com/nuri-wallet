import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEthereumAddress: vi.fn(),
  quoteV2DirectEvmSwaps: vi.fn(),
  executeV2DirectEvmSwap: vi.fn(),
  noteDeliberateUsdc: vi.fn(),
  quoteV2StableToBtc: vi.fn(),
  executeV2StableToBtc: vi.fn(),
  quoteV2BtcToStable: vi.fn(),
  executeV2BtcToStable: vi.fn(),
  btcRailRefundAddress: vi.fn(),
  resolveCardSettleTarget: vi.fn(),
  getArkadeBoardingAddress: vi.fn(),
  getArkadeReceiveAddress: vi.fn(),
  getSwapKitV2Limits: vi.fn(),
}));

vi.mock("./SwapKitV2Service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./SwapKitV2Service")>()),
  getSwapKitV2Limits: mocks.getSwapKitV2Limits,
}));

vi.mock("../../lib/secureKeyStorage", () => ({
  getEthereumAddress: mocks.getEthereumAddress,
}));
vi.mock("./SwapKitV2DirectEvmService", () => ({
  quoteV2DirectEvmSwaps: mocks.quoteV2DirectEvmSwaps,
  executeV2DirectEvmSwap: mocks.executeV2DirectEvmSwap,
}));
vi.mock("./SwapKitDirectSwapStore", () => ({
  noteDeliberateUsdc: mocks.noteDeliberateUsdc,
}));
vi.mock("./SwapKitV2StableToBtcService", () => ({
  quoteV2StableToBtc: mocks.quoteV2StableToBtc,
  executeV2StableToBtc: mocks.executeV2StableToBtc,
}));
vi.mock("./SwapKitV2BtcToStableService", () => ({
  quoteV2BtcToStable: mocks.quoteV2BtcToStable,
  executeV2BtcToStable: mocks.executeV2BtcToStable,
  btcRailRefundAddress: mocks.btcRailRefundAddress,
  resolveCardSettleTarget: mocks.resolveCardSettleTarget,
}));
vi.mock("../arkade/internal/walletCache", () => ({
  getOrCreateWallet: async () => ({
    getBoardingAddress: mocks.getArkadeBoardingAddress,
    getAddress: mocks.getArkadeReceiveAddress,
  }),
}));

import { executeSwap, quoteSwap, swapAmountBounds } from "./SwapContract";

const EOA = "0x1111111111111111111111111111111111111111";
const CARD_ACCOUNT = "0x2222222222222222222222222222222222222222";
// A bitcoin destination is always stated — the contract has no default, because
// the two bitcoin rails share one asset id and guessing pays the wrong wallet.
const OWN_BTC = "bc1qownbitcoinrail000000000000000000000000000";

const directQuote = {
  optionId: "lifi:lifi-direct",
  from: "EURC_BASE",
  to: "USDC_BASE",
  sendAmount: 10,
  receiveAmount: 11.4,
  rate: 1.14,
  provider: "lifi",
  settleTarget: EOA,
  owner: EOA,
  quotedAt: Date.now(),
  expiresAt: Date.now() + 120_000,
};

// A v2 quote option, as quoteV2StableToBtc returns it. The server prices only
// options this wallet's capabilities can finish — no display-only tier.
const v2Option = (overrides: Record<string, unknown> = {}) => ({
  optionId: "satora:satora:EURC_BASE->BTC",
  from: "EURC_BASE",
  to: "BTC",
  depositAmount: 20,
  settleAmount: 0.0003,
  requiredCapabilities: ["htlc_material", "execute_evm_call", "sign_typed_data"],
  limits: null as unknown,
  provider: "satora",
  ...overrides,
});

// A v2 btc→stable quote option, as quoteV2BtcToStable returns it (per rail).
const v2BtcOption = (overrides: Record<string, unknown> = {}) => ({
  optionId: "satora:satora:BTC->EURC_BASE",
  from: "BTC" as "BTC" | "BTC_ARKADE",
  to: "EURC_BASE",
  sats: 30_000,
  settleAmount: 17.2,
  requiredCapabilities: ["send_asset", "execute_evm_call", "sign_typed_data"],
  etaSeconds: undefined as number | undefined,
  limits: null as unknown,
  provider: "satora",
  expectedUsdc: 18.9,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEthereumAddress.mockResolvedValue(EOA);
  // Same contract as the real resolution: the wallet settles to the EOA, the
  // card to the card account, and only in the card's own stables.
  mocks.resolveCardSettleTarget.mockImplementation(
    async (destination: "card" | "wallet", owner: string, toStable: string) => {
      if (destination === "wallet") return owner;
      if (toStable !== "EURC_BASE" && toStable !== "USDC_BASE") {
        throw new Error(`The card cannot be topped up in ${toStable}.`);
      }
      return CARD_ACCOUNT;
    },
  );
  mocks.quoteV2DirectEvmSwaps.mockResolvedValue([directQuote]);
  mocks.executeV2DirectEvmSwap.mockResolvedValue({
    orderId: "ord_direct1",
    swappedAmount: 10,
    quotedReceive: 11.4,
  });
  mocks.noteDeliberateUsdc.mockResolvedValue(undefined);
  mocks.quoteV2StableToBtc.mockResolvedValue({ options: [v2Option()], unavailable: [] });
  mocks.executeV2StableToBtc.mockResolvedValue({ orderId: "ord_stb1" });
  // Default btc→stable: each rail this owner can fund answers with one option.
  // The engine fans out per rail (never conflating BTC and BTC_ARKADE), so the
  // mock echoes the requested rail back on its option.
  mocks.quoteV2BtcToStable.mockImplementation(
    async (args: { rail: "BTC" | "BTC_ARKADE"; toStable: string }) => ({
      options: [
        v2BtcOption({
          optionId: `satora:satora:${args.rail}->${args.toStable}`,
          from: args.rail,
          to: args.toStable,
        }),
      ],
      unavailable: [],
    }),
  );
  mocks.executeV2BtcToStable.mockResolvedValue({ orderId: "ord_bts1" });
  mocks.btcRailRefundAddress.mockImplementation(async (rail: string) =>
    rail === "BTC_ARKADE" ? "ark1refund" : "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
  );
  mocks.getArkadeBoardingAddress.mockResolvedValue("bc1qboardingaddress00000000000000000000000000");
  mocks.getArkadeReceiveAddress.mockResolvedValue("ark1qownarkadeaddress0000000000000000000000000");
});

describe("what a route row says it runs through", () => {
  it("exposes every same-chain stable route as its own selectable quote", async () => {
    mocks.quoteV2DirectEvmSwaps.mockResolvedValue([
      directQuote,
      {
        ...directQuote,
        provider: "cow",
        optionId: "cow:cow-eurc-base-usdc-base",
        receiveAmount: 11.3,
        rate: 1.13,
        etaSeconds: 90,
      },
    ]);

    const quotes = await quoteSwap({ from: "EURC_BASE", to: "USDC_BASE", amount: 10 });

    expect(quotes.map((quote) => quote.id)).toEqual([
      "direct-evm:lifi:lifi-direct",
      "direct-evm:cow:cow-eurc-base-usdc-base",
    ]);
    expect(quotes.map((quote) => quote.providers)).toEqual([["lifi"], ["cow"]]);
    expect(quotes.map((quote) => quote.etaSeconds)).toEqual([undefined, 90]);
  });

  // FUNDS SAFETY: an option the server could not price must never be offered.
  // Coercing a missing/zero settlement to 0 marked it executable and committed
  // `minimumSettleAmount: "0"` — the user approving a real spend with no floor
  // on what comes back.
  it.each([
    ["missing", undefined],
    ["null", null],
    ["zero", 0],
    ["negative", -0.0003],
    ["unparseable", "not-a-number"],
  ])("refuses a stable→BTC option whose settlement is %s", async (_label, settleAmount) => {
    mocks.quoteV2StableToBtc.mockResolvedValue({
      options: [v2Option({ settleAmount })],
      unavailable: [],
    });

    const quotes = await quoteSwap({
      from: "EURC_BASE",
      to: "BTC",
      amount: 12,
      settleTarget: OWN_BTC,
    });

    expect(quotes).toHaveLength(0);
  });

  // The deposit is a server term too: the requested amount must never stand in
  // for a deposit the option was not priced at.
  it.each([
    ["missing", undefined],
    ["null", null],
    ["zero", 0],
    ["negative", -5],
    ["unparseable", "not-a-number"],
  ])("refuses a stable→BTC option whose deposit is %s", async (_label, depositAmount) => {
    mocks.quoteV2StableToBtc.mockResolvedValue({
      options: [v2Option({ depositAmount })],
      unavailable: [],
    });

    const quotes = await quoteSwap({
      from: "EURC_BASE",
      to: "BTC",
      amount: 12,
      settleTarget: OWN_BTC,
    });

    expect(quotes).toHaveLength(0);
  });

  it("still offers a stable→BTC option that carries a real settlement", async () => {
    mocks.quoteV2StableToBtc.mockResolvedValue({
      options: [v2Option({ settleAmount: 0.0003 })],
      unavailable: [],
    });

    const [quote] = await quoteSwap({
      from: "EURC_BASE",
      to: "BTC",
      amount: 12,
      settleTarget: OWN_BTC,
    });

    expect(quote.receiveAmount).toBe(30_000);
    expect(quote.detail).toMatchObject({ quotedSettleAmount: 0.0003 });
  });

  it("carries every provider, not just the first", async () => {
    mocks.quoteV2StableToBtc.mockResolvedValue({
      options: [v2Option({ optionId: "cow:cow-usdc-base-satora-arkade", provider: "cow" })],
      unavailable: [],
    });

    const [quote] = await quoteSwap({
      from: "EURC_BASE",
      to: "BTC",
      amount: 12,
      settleTarget: OWN_BTC,
    });

    // v2 optionIds are provider-prefixed; the display provider is that prefix.
    expect(quote.providers).toEqual(["cow"]);
    expect(quote.provider).toBe("cow");
  });

  it("gives a single-provider route a one-entry list", async () => {
    const [quote] = await quoteSwap({ from: "EURC_BASE", to: "USDC_BASE", amount: 10 });

    expect(quote.providers).toEqual(["lifi"]);
  });
});

describe("stable → Bitcoin always routes on-chain (no satora arkade corridor)", () => {
  const BOARDING = "bc1qboardingaddress00000000000000000000000000";

  it("requests on-chain BTC to the stated destination and never prices BTC_ARKADE", async () => {
    // "Bitcoin Lightning" hands the wallet's own boarding address as the
    // destination. The engine must request the plain on-chain BTC route to it
    // (which the server fills via LiFi) — never the satora BTC_ARKADE corridor.
    mocks.quoteV2StableToBtc.mockResolvedValue({
      options: [v2Option({ optionId: "lifi:eurc-base-btc", provider: "lifi" })],
      unavailable: [],
    });

    const quotes = await quoteSwap({
      from: "EURC_BASE",
      to: "BTC",
      amount: 20,
      settleTarget: BOARDING,
    });

    expect(mocks.quoteV2StableToBtc).toHaveBeenCalledOnce();
    expect(mocks.quoteV2StableToBtc).toHaveBeenCalledWith(
      expect.objectContaining({ to: "BTC", settleTarget: BOARDING }),
    );
    expect(mocks.quoteV2StableToBtc).not.toHaveBeenCalledWith(
      expect.objectContaining({ to: "BTC_ARKADE" }),
    );
    expect(quotes.every((quote) => quote.to === "BTC")).toBe(true);
  });

  it("executes the on-chain BTC route with the stated destination", async () => {
    mocks.quoteV2StableToBtc.mockResolvedValue({ options: [v2Option()], unavailable: [] });

    const quotes = await quoteSwap({
      from: "USDC_BASE",
      to: "BTC",
      amount: 20,
      settleTarget: BOARDING,
    });
    await executeSwap(quotes[0], {});

    expect(mocks.executeV2StableToBtc).toHaveBeenCalledWith(
      expect.objectContaining({ to: "BTC", settleTarget: BOARDING }),
    );
    // The commit's minimumSettleAmount (quotedReceive) MUST be the settled
    // asset's decimal unit (0.0003 BTC), never the sats DISPLAY value (30000) —
    // binding 30000 "BTC" would make the order unexecutable. (Taner/Codex P1 #3)
    expect(mocks.executeV2StableToBtc).toHaveBeenCalledWith(
      expect.objectContaining({ quotedReceive: 0.0003 }),
    );
  });

  it("leaves a scanned stranger's address with the one destination it named", async () => {
    const quotes = await quoteSwap({
      from: "EURC_BASE",
      to: "BTC",
      amount: 20,
      settleTarget: OWN_BTC,
    });

    expect(mocks.quoteV2StableToBtc).toHaveBeenCalledTimes(1);
    expect(quotes.every((quote) => quote.to === "BTC")).toBe(true);
  });
});

describe("one contract, every direction", () => {
  it("drives EUR→USD through the same two calls as EUR→BTC", async () => {
    const [stable] = await quoteSwap({ from: "EURC_BASE", to: "USDC_BASE", amount: 10 });
    const [bitcoin] = await quoteSwap({
      from: "EURC_BASE",
      to: "BTC",
      amount: 20,
      settleTarget: OWN_BTC,
    });

    // Same shape, whatever is behind it: what you send, what you get, the rate.
    for (const quote of [stable, bitcoin]) {
      expect(quote).toMatchObject({
        sendAmount: expect.any(Number),
        receiveAmount: expect.any(Number),
        rate: expect.any(Number),
      });
    }
    expect(stable).toMatchObject({ receiveAmount: 11.4, receiveSymbol: "USDC" });
    // Bitcoin is counted in sats on both sides of the contract.
    expect(bitcoin).toMatchObject({ receiveAmount: 30_000, receiveSymbol: "sats" });
  });

  it("pays a BTC→EUR move from the wallet the caller named", async () => {
    const [quote] = await quoteSwap({
      from: "BTC",
      to: "EURC_BASE",
      amount: 30_000,
      sendSource: "onchain",
    });

    // The on-chain source funds ONLY the BTC rail (it cannot fund an Arkade
    // VHTLC), so the engine quotes exactly that one corridor.
    expect(mocks.quoteV2BtcToStable).toHaveBeenCalledWith(
      expect.objectContaining({ rail: "BTC", toStable: "EURC_BASE", sats: 30_000 }),
    );
    expect(mocks.quoteV2BtcToStable).not.toHaveBeenCalledWith(
      expect.objectContaining({ rail: "BTC_ARKADE" }),
    );
    await executeSwap(quote, {});
    expect(mocks.executeV2BtcToStable).toHaveBeenCalledWith(
      expect.objectContaining({ rail: "BTC", sendSource: "onchain", destination: "wallet" }),
    );
  });

  // The server commits a quote only for the exact request it priced. An
  // Arkade -> EUR option states a deposit (11,106) below the amount the user
  // typed (11,111); committing the option's deposit instead of the request
  // made every accept come back "quoted for a different request" and sent the
  // sheet back to finding quotes.
  it("commits the amount the quote was requested for, not the option's deposit", async () => {
    mocks.quoteV2BtcToStable.mockResolvedValueOnce({
      options: [
        {
          ...v2BtcOption({
            optionId: "arkade-intents-bitcoinvn:arkade-intents-bitcoinvn:EURC_BASE",
            from: "BTC_ARKADE",
            to: "EURC_BASE",
          }),
          sats: 11_106,
        },
      ],
      unavailable: [],
    });
    const [quote] = await quoteSwap({ from: "BTC", to: "EURC_BASE", amount: 11_111 });
    await executeSwap(quote, {});
    expect(mocks.executeV2BtcToStable).toHaveBeenCalledWith(
      expect.objectContaining({ sats: 11_106, requestedSats: 11_111 }),
    );
  });

  it("quotes the on-chain source through the offboard rails", async () => {
    const [quote] = await quoteSwap({
      from: "BTC",
      to: "EURC_BASE",
      amount: 30_000,
      sendSource: "onchain",
    });

    expect(quote).toMatchObject({
      sendAmount: 30_000,
      sendSymbol: "sats",
      receiveAmount: 17.2,
      receiveSymbol: "EURC",
    });
    // The on-chain wallet cannot fund an Arkade lockup, so a named on-chain
    // source quotes that rail and nothing else.
    expect(mocks.quoteV2BtcToStable).toHaveBeenCalledWith(
      expect.objectContaining({ rail: "BTC", toStable: "EURC_BASE" }),
    );
    expect(mocks.quoteV2BtcToStable).not.toHaveBeenCalledWith(
      expect.objectContaining({ rail: "BTC_ARKADE" }),
    );
  });

  it("quotes only the Arkade route for an unnamed (arkade) source", async () => {
    await quoteSwap({ from: "BTC", to: "EURC_BASE", amount: 30_000 });

    // Arkade pays its own route. Moving the sats on-chain first to use an
    // on-chain route is never offered.
    expect(mocks.quoteV2BtcToStable).toHaveBeenCalledTimes(1);
    expect(mocks.quoteV2BtcToStable).toHaveBeenCalledWith(
      expect.objectContaining({ rail: "BTC_ARKADE", toStable: "EURC_BASE" }),
    );
    expect(mocks.quoteV2BtcToStable).not.toHaveBeenCalledWith(
      expect.objectContaining({ rail: "BTC" }),
    );
  });

  it("quotes and settles a BTC→USD move in dollars, not euros", async () => {
    const [quote] = await quoteSwap({
      from: "BTC",
      to: "USDC_BASE",
      amount: 30_000,
      sendSource: "onchain",
    });

    expect(quote).toMatchObject({ sendSymbol: "sats", receiveSymbol: "USDC" });
    expect(mocks.quoteV2BtcToStable).toHaveBeenCalledWith(
      expect.objectContaining({ toStable: "USDC_BASE" }),
    );

    await executeSwap(quote, {});

    // The token the quote was taken in travels to execute: settling euros for a
    // dollar quote would deliver a balance the user never asked for.
    expect(mocks.executeV2BtcToStable).toHaveBeenCalledWith(
      expect.objectContaining({ toStable: "USDC_BASE" }),
    );
  });

  // #1458: the card is a destination of the SAME v2 engine. Identical offers;
  // the only difference is the EVM address that receives, and the card
  // receives its own stable only.
  describe("bitcoin to the card", () => {
    it("offers exactly what the wallet move offers, priced and settled on the card account", async () => {
      const toWallet = await quoteSwap({ from: "BTC", to: "EURC_BASE", amount: 30_000 });
      mocks.quoteV2BtcToStable.mockClear();
      const toCard = await quoteSwap({
        from: "BTC",
        to: "EURC_BASE",
        amount: 30_000,
        destination: "card",
      });

      const strip = (quote: (typeof toWallet)[number]) => ({
        id: quote.id,
        receiveAmount: quote.receiveAmount,
        sendAmount: quote.sendAmount,
        executable: quote.executable,
      });
      expect(toCard.map(strip)).toEqual(toWallet.map(strip));
      // The server prices the move for the card account, so the options it
      // returns are the ones that pay THAT address.
      for (const [args] of mocks.quoteV2BtcToStable.mock.calls) {
        expect(args).toMatchObject({ settleTarget: CARD_ACCOUNT, owner: EOA });
      }
      expect(toCard[0]).toMatchObject({ destination: "card" });

      await executeSwap(toCard[0], {});
      expect(mocks.executeV2BtcToStable).toHaveBeenCalledWith(
        expect.objectContaining({ settleTarget: CARD_ACCOUNT, destination: "card" }),
      );
    });

    it("keeps settling a wallet move on this wallet", async () => {
      const [quote] = await quoteSwap({ from: "BTC", to: "EURC_BASE", amount: 30_000 });
      expect(quote).not.toHaveProperty("destination");
      await executeSwap(quote, {});
      expect(mocks.executeV2BtcToStable).toHaveBeenCalledWith(
        expect.objectContaining({ settleTarget: EOA, destination: "wallet" }),
      );
    });

    it("returns the order id the card books its credit against, and announces it early", async () => {
      const [quote] = await quoteSwap({
        from: "BTC",
        to: "EURC_BASE",
        amount: 30_000,
        sendSource: "onchain",
        destination: "card",
      });
      const onOrderId = vi.fn();
      const execution = await executeSwap(quote, { onOrderId });
      expect(execution.orderId).toBe("ord_bts1");
      expect(mocks.executeV2BtcToStable).toHaveBeenCalledWith(
        expect.objectContaining({ onOrderId }),
      );
    });

    it("prices the dollar pocket in USDC", async () => {
      await quoteSwap({ from: "BTC", to: "USDC_BASE", amount: 30_000, destination: "card" });
      expect(mocks.resolveCardSettleTarget).toHaveBeenCalledWith("card", EOA, "USDC_BASE");
    });

    it("shows no route when the card account cannot receive, before anything is priced", async () => {
      mocks.resolveCardSettleTarget.mockRejectedValueOnce(
        new Error("Card account is not ready yet."),
      );
      await expect(
        quoteSwap({ from: "BTC", to: "EURC_BASE", amount: 30_000, destination: "card" }),
      ).rejects.toThrow("Card account is not ready yet.");
      expect(mocks.quoteV2BtcToStable).not.toHaveBeenCalled();
    });

    it("prices nothing when the sheet names a different card account than the one resolved", async () => {
      await expect(
        quoteSwap({
          from: "BTC",
          to: "EURC_BASE",
          amount: 30_000,
          destination: "card",
          settleTarget: "0x3333333333333333333333333333333333333333",
        }),
      ).rejects.toThrow(/Card account changed/);
      expect(mocks.quoteV2BtcToStable).not.toHaveBeenCalled();
    });
  });

  // From Arkade there is exactly one route. When it has no price, the answer
  // is "no route", never the on-chain detour.
  it("offers no on-chain route from the Arkade balance, even when the Arkade route has none", async () => {
    mocks.quoteV2BtcToStable.mockImplementation(
      async (args: { rail: "BTC" | "BTC_ARKADE"; toStable: string }) =>
        args.rail === "BTC_ARKADE"
          ? { options: [], unavailable: [{ provider: "satora", reason: "no_route" }] }
          : {
              options: [v2BtcOption({ optionId: "satora:satora:BTC->EURC_BASE", from: "BTC" })],
              unavailable: [],
            },
    );

    const quotes = await quoteSwap({ from: "BTC", to: "EURC_BASE", amount: 30_000 });

    expect(quotes).toHaveLength(0);
  });

  // Every server-priced option is offered — no client-side leg filter. A route
  // with no hub-USDC leg is still run on the on-chain wallet.
  it("offers an on-chain option even when it carries no hub-USDC leg", async () => {
    mocks.quoteV2BtcToStable.mockResolvedValue({
      options: [
        v2BtcOption({ optionId: "bitcoinvn:BTC->EURC_BASE", from: "BTC", expectedUsdc: null }),
      ],
      unavailable: [],
    });

    const quotes = await quoteSwap({
      from: "BTC",
      to: "EURC_BASE",
      amount: 30_000,
      sendSource: "onchain",
    });

    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({ receiveAmount: 17.2 });
  });

  // The route card names the hubs of `path`. A route that pays the target
  // directly (no USDC_BASE leg in the server's option) must not claim a USDC hub.
  it("names a USDC hub only when the option carries a USDC leg", async () => {
    mocks.quoteV2BtcToStable.mockImplementation(
      async (args: { rail: "BTC" | "BTC_ARKADE"; toStable: string }) => ({
        options: [
          v2BtcOption({
            optionId: `arkade-intents-bitcoinvn:${args.rail}->${args.toStable}`,
            from: args.rail,
            expectedUsdc: args.rail === "BTC" ? 18.9 : null,
          }),
        ],
        unavailable: [],
      }),
    );

    const [arkade] = await quoteSwap({ from: "BTC", to: "EURC_BASE", amount: 30_000 });
    const [onchain] = await quoteSwap({
      from: "BTC",
      to: "EURC_BASE",
      amount: 30_000,
      sendSource: "onchain",
    });

    expect(arkade.path).toEqual(["BTC_ARKADE", "EURC_BASE"]);
    expect(onchain.path).toEqual(["BTC", "USDC_BASE", "EURC_BASE"]);
  });

  it("hands the accepted hub-USDC cap and rail to execute", async () => {
    const [quote] = await quoteSwap({ from: "BTC", to: "EURC_BASE", amount: 30_000 });
    const execution = await executeSwap(quote, {});

    expect(mocks.executeV2BtcToStable).toHaveBeenCalledWith(
      expect.objectContaining({
        rail: "BTC_ARKADE",
        sats: 30_000,
        optionId: "satora:satora:BTC_ARKADE->EURC_BASE",
        quotedReceiveStable: 17.2,
        expectedUsdc: 18.9,
        settleTarget: EOA,
      }),
    );
    expect(execution).toMatchObject({ orderId: "ord_bts1", sentAmount: 30_000 });
  });

  // The on-chain wallet cannot fund an Arkade lockup, so its rail is never
  // quoted for an on-chain source.
  it("never quotes the Arkade rail for the on-chain source", async () => {
    await quoteSwap({ from: "BTC", to: "EURC_BASE", amount: 30_000, sendSource: "onchain" });

    expect(mocks.quoteV2BtcToStable).toHaveBeenCalledTimes(1);
    expect(mocks.quoteV2BtcToStable).toHaveBeenCalledWith(expect.objectContaining({ rail: "BTC" }));
  });

  it("creates nothing while quoting", async () => {
    await quoteSwap({ from: "EURC_BASE", to: "USDC_BASE", amount: 10 });
    await quoteSwap({ from: "EURC_BASE", to: "BTC", amount: 20, settleTarget: OWN_BTC });
    await quoteSwap({ from: "BTC", to: "EURC_BASE", amount: 30_000 });

    expect(mocks.executeV2DirectEvmSwap).not.toHaveBeenCalled();
    expect(mocks.executeV2StableToBtc).not.toHaveBeenCalled();
    expect(mocks.executeV2BtcToStable).not.toHaveBeenCalled();
  });

  it("hands the accepted quote straight back to the engine that priced it", async () => {
    const [quote] = await quoteSwap({ from: "EURC_BASE", to: "USDC_BASE", amount: 10 });

    await expect(executeSwap(quote)).resolves.toMatchObject({
      orderId: "ord_direct1",
      sentAmount: 10,
      quotedReceive: 11.4,
    });
    expect(mocks.executeV2DirectEvmSwap).toHaveBeenCalledWith(
      expect.objectContaining({ quote: directQuote }),
    );
  });

  it("runs a Bitcoin swap under the euro spend its quote stated", async () => {
    const [quote] = await quoteSwap({
      from: "EURC_BASE",
      to: "BTC",
      amount: 20,
      settleTarget: OWN_BTC,
    });

    await executeSwap(quote);

    expect(mocks.executeV2StableToBtc).toHaveBeenCalledWith(
      expect.objectContaining({
        optionId: "satora:satora:EURC_BASE->BTC",
        quotedDeposit: 20,
        amount: 20,
      }),
    );
  });

  it("passes a scanned destination through as the settle target", async () => {
    const scanned = "bc1qexampledestination";
    const [quote] = await quoteSwap({
      from: "EURC_BASE",
      to: "BTC",
      amount: 20,
      settleTarget: scanned,
    });

    await executeSwap(quote);

    expect(mocks.executeV2StableToBtc).toHaveBeenCalledWith(
      expect.objectContaining({ to: "BTC", settleTarget: scanned }),
    );
  });

  it("states that a bitcoin destination is required, and refuses to price without one", async () => {
    const [bitcoin] = await quoteSwap({
      from: "EURC_BASE",
      to: "BTC",
      amount: 20,
      settleTarget: OWN_BTC,
    });
    expect(bitcoin.requirements).toEqual([{ field: "settleTarget", required: true, asset: "BTC" }]);

    // No default: the two bitcoin rails are one asset here, so an unnamed
    // destination could only be picked by paying one of them at random.
    await expect(quoteSwap({ from: "EURC_BASE", to: "BTC", amount: 20 })).rejects.toThrow(
      /destination/i,
    );
  });

  // v2: the server never returns an option this wallet cannot finish — the
  // display-only tier is gone; capability-gated routes arrive as structured
  // unavailable and are simply not offered.
  it("offers nothing when v2 reports the pair unavailable", async () => {
    mocks.quoteV2StableToBtc.mockResolvedValue({
      options: [],
      unavailable: [{ provider: "satora", reason: "missing_capability:psbt" }],
    });
    const quotes = await quoteSwap({
      from: "EURC_BASE",
      to: "BTC",
      amount: 20,
      settleTarget: OWN_BTC,
    });

    expect(quotes).toEqual([]);
    expect(mocks.executeV2StableToBtc).not.toHaveBeenCalled();
  });

  // ── Lightning -> on-chain Bitcoin ──────────────────────────────────────────
  //
  // The rail that replaces the Ark offboard for leaving the Arkade balance. The
  // offboard needs settled vtxos, so freshly received coins cannot leave; this
  // one pays a BOLT11 and has no such rule.

  it("refuses an expired quote instead of silently repricing it", async () => {
    const [quote] = await quoteSwap({ from: "EURC_BASE", to: "USDC_BASE", amount: 10 });

    await expect(executeSwap({ ...quote, expiresAt: Date.now() - 1 })).rejects.toThrow(/expired/);
    expect(mocks.executeV2DirectEvmSwap).not.toHaveBeenCalled();
  });

  it("refuses a pair no engine covers, and a non-positive amount", async () => {
    await expect(quoteSwap({ from: "EURC_BASE", to: "SOL_SOLANA", amount: 10 })).rejects.toThrow(
      /No swap route/,
    );
    await expect(quoteSwap({ from: "EURC_BASE", to: "USDC_BASE", amount: 0 })).rejects.toThrow(
      /positive amount/,
    );
  });

  it("returns an empty list rather than an error when there is nothing to swap", async () => {
    mocks.quoteV2DirectEvmSwaps.mockResolvedValue([]);
    await expect(
      quoteSwap({ from: "EURC_BASE", to: "USDC_BASE", amount: 0.0000001 }),
    ).resolves.toEqual([]);
  });

  it("ranks routes best rate first", async () => {
    mocks.quoteV2StableToBtc.mockResolvedValue({
      options: [
        v2Option({ optionId: "satora:slow", settleAmount: 0.0002 }),
        v2Option({ optionId: "satora:best", settleAmount: 0.0004 }),
      ],
      unavailable: [],
    });

    const quotes = await quoteSwap({
      from: "EURC_BASE",
      to: "BTC",
      amount: 20,
      settleTarget: OWN_BTC,
    });

    expect(quotes.map((quote) => quote.id)).toEqual([
      "stable-to-btc:satora:best",
      "stable-to-btc:satora:slow",
    ]);
  });
});

describe("swapAmountBounds (pre-quote, swap_limits)", () => {
  const limits = (from: string, to: string, min: string | null, max: string | null) => ({
    from,
    to,
    min,
    max,
    routes: [] as never[],
  });

  it("reads the one rail an arkade move would quote, and quotes nothing", async () => {
    mocks.getSwapKitV2Limits.mockImplementation(async ({ from, to }) =>
      from === "BTC_ARKADE"
        ? limits(from, to, "0.00005925", "0.0005")
        : limits(from, to, "0.00005921", "0.01508612"),
    );
    const bounds = await swapAmountBounds({ from: "BTC", to: "EURC_BASE", sendSource: "arkade" });
    expect(mocks.getSwapKitV2Limits.mock.calls.map(([pair]) => pair)).toEqual([
      { from: "BTC_ARKADE", to: "EURC_BASE" },
    ]);
    expect(bounds).toEqual({ min: 5_925, max: 50_000 });
    expect(mocks.quoteV2BtcToStable).not.toHaveBeenCalled();
  });

  it("reads only the on-chain rail for an on-chain move", async () => {
    mocks.getSwapKitV2Limits.mockResolvedValue(limits("BTC", "USDC_BASE", "0.0001", "0.01"));
    await swapAmountBounds({ from: "BTC", to: "USDC_BASE", sendSource: "onchain" });
    expect(mocks.getSwapKitV2Limits.mock.calls.map(([pair]) => pair)).toEqual([
      { from: "BTC", to: "USDC_BASE" },
    ]);
  });

  it("states no bound when the server has no swap_limits tool (old server)", async () => {
    mocks.getSwapKitV2Limits.mockRejectedValue(new Error("Tool swap_limits not found"));
    await expect(swapAmountBounds({ from: "EURC_BASE", to: "USDC_BASE" })).resolves.toEqual({
      min: null,
      max: null,
    });
  });

  it("states no bound for a pair no engine prices", async () => {
    await expect(swapAmountBounds({ from: "EURC_BASE", to: "EURC_BASE_X" })).resolves.toEqual({
      min: null,
      max: null,
    });
    expect(mocks.getSwapKitV2Limits).not.toHaveBeenCalled();
  });
});
