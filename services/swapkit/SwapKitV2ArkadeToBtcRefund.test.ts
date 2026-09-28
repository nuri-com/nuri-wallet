import { beforeEach, expect, it, vi } from "vitest";

// Arkade -> on-chain Bitcoin runs as BTC_LN -> BTC: the wallet pays a Lightning
// invoice from Arkade. A Lightning-funded order refunds on the Bitcoin chain, so
// the server requires a Bitcoin refund address; sending the Arkade (ark1…)
// address failed every quote with "refundAddress is not a valid Bitcoin address
// for BTC_LN". The refund is this wallet's own Arkade BOARDING address.
const m = vi.hoisted(() => ({ quote: vi.fn() }));

const BOARDING = "bc1p3h5tdlu0rgrwrjp3tqh39mq3upftk2h7w09qmvzeplup2yzx3r5qup9l2d";
vi.mock("../bitcoin/BitcoinAddressService", () => ({
  getBitcoinReceiveAddress: async (): Promise<string> => BOARDING,
}));
vi.mock("./SwapKitV2Service", () => ({
  SWAPKIT_V2_ACTION_KINDS: ["send_asset", "execute_evm_call", "pay_lightning_invoice"],
  quoteSwapKitV2: m.quote,
}));
vi.mock("./SwapKitV2Executors", () => ({ makeStandardV2Executors: () => ({}) }));
vi.mock("./SwapKitV2CommitFlow", () => ({ commitAndTrackV2Order: vi.fn() }));
vi.mock("../../lib/i18n", () => ({ t: (key: string) => key }));

import { quoteV2ArkadeToBtc } from "./SwapKitV2ArkadeToBtcService";

beforeEach(() => {
  m.quote.mockReset();
  m.quote.mockResolvedValue({ mode: "quote", options: [], unavailable: [] });
});

it("quotes with the wallet's Bitcoin (boarding) address as the refund, never an Arkade address", async () => {
  await quoteV2ArkadeToBtc({
    toAddress: "bc1q9fzv42n2zaf3mmeet4ahrrn54llgpnp5etq3r8",
    sats: 20_000,
    owner: "0x00993cA379abd3F6c79E439c54a1AB2e7c95234B",
  });
  expect(m.quote).toHaveBeenCalledWith(
    expect.objectContaining({ from: "BTC_LN", to: "BTC", refundAddress: BOARDING }),
  );
});
