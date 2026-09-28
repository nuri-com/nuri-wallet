import { describe, expect, it, vi } from "vitest";

// Taner, #1361 review 5318314017 item 2: quoteV2ArkadeToBtc prices the route
// for the Arkade VHTLC signer, but the commit fell back to the EVM EOA default,
// so the order was created under a signer class this route never uses. The
// engine derives every action's deadline from that class, so quote and commit
// must name the same one.
const m = vi.hoisted(() => ({ quote: vi.fn(), commit: vi.fn() }));

vi.mock("./SwapKitV2Service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./SwapKitV2Service")>()),
  quoteSwapKitV2: m.quote,
}));
vi.mock("./SwapKitV2CommitFlow", () => ({ commitAndTrackV2Order: m.commit }));
vi.mock("./SwapKitV2Executors", () => ({ makeStandardV2Executors: () => ({}) }));
vi.mock("../bitcoin/ownDestinations", () => ({
  ownBitcoinDestinations: async (): Promise<{ arkade: null; onchain: null }> => ({
    arkade: null,
    onchain: null,
  }),
}));
vi.mock("../bitcoin/BitcoinAddressService", () => ({
  getBitcoinReceiveAddress: async (): Promise<string> => "ark1own",
}));
vi.mock("../../lib/i18n", () => ({ t: (key: string): string => key }));

import { executeV2ArkadeToBtc, quoteV2ArkadeToBtc } from "./SwapKitV2ArkadeToBtcService";

// Real shapes: the service validates both before it quotes or commits.
const OWNER = "0x3ECF50d1b51cab3b506D47FF29F45845c0E68f89";
const DEST = "bc1q9fzv42n2zaf3mmeet4ahrrn54llgpnp5etq3r8";

describe("the Arkade signer class survives the commit", () => {
  it("quote and commit name the SAME signer class", async () => {
    m.quote.mockReset();
    m.commit.mockReset();
    m.quote.mockResolvedValue({ options: [], unavailable: [] });
    m.commit.mockResolvedValue({ orderId: "ord_1" });

    await quoteV2ArkadeToBtc({
      toAddress: DEST,
      sats: 20_000,
      owner: OWNER,
    });
    const quoted = m.quote.mock.calls[0]?.[0] as { signerClass?: Record<string, string> };

    await executeV2ArkadeToBtc({
      toAddress: DEST,
      sats: 20_000,
      optionId: "opt",
      quotedReceive: 0.00019,
      owner: OWNER,
    });
    const committed = m.commit.mock.calls[0]?.[0] as { signerClass?: Record<string, string> };

    expect(quoted.signerClass).toEqual({ arkade: "arkade-vhtlc" });
    expect(committed.signerClass).toEqual(quoted.signerClass);
    // Specifically NOT the EVM EOA default it used to fall back to.
    expect(committed.signerClass).not.toEqual({ evm: "eoa" });
  });
});
