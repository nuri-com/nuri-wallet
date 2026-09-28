import { describe, expect, it } from "vitest";

// A producer names assets and addresses; the board names screens. These are the
// translations, checked against the real cases each commit path produces.
import { assetRail, destinationRail } from "./assetRails";

const OWN = {
  arkade: "ark1own",
  onchain: "bc1own",
  evm: "0x00993cA379abd3F6c79E439c54a1AB2e7c95234B",
  card: "0xCARDacc0untAAAA",
};

describe("which screen an asset belongs to", () => {
  it("maps every asset the engine speaks", () => {
    expect(assetRail("BTC")).toBe("onchain");
    expect(assetRail("BTC_ARKADE")).toBe("arkade");
    expect(assetRail("BTC_LN")).toBe("arkade");
    expect(assetRail("EURC_BASE")).toBe("wallet");
    expect(assetRail("EURE_GNOSIS")).toBe("wallet");
    expect(assetRail("USDC_BASE")).toBe("dollar");
    expect(assetRail("WHAT")).toBe(null);
  });
});

describe("which screen a destination lands on", () => {
  it("an explicit arkade asset is always our arkade balance", () => {
    expect(destinationRail("BTC_ARKADE", null, OWN)).toBe("arkade");
    expect(destinationRail("BTC_LN", null, OWN)).toBe("arkade");
  });

  it("plain BTC is decided by the address it settles to", () => {
    expect(destinationRail("BTC", "ark1own", OWN)).toBe("arkade");
    expect(destinationRail("BTC", "bc1own", OWN)).toBe("onchain");
    // Someone else's address: money leaving, no destination screen.
    expect(destinationRail("BTC", "bc1qstranger", OWN)).toBe(null);
  });

  it("a stable settling to the CARD credits the pocket, not the wallet", () => {
    // The bug this prevents: euro is three screens, so routing by currency put
    // a card top-up on the euro wallet or nowhere.
    expect(destinationRail("EURC_BASE", OWN.card, OWN, "EUR")).toBe("visa");
    expect(destinationRail("USDC_BASE", OWN.card, OWN, "USD")).toBe("visaUsd");
    // Pocket unstated: the stable's own currency decides.
    expect(destinationRail("USDC_BASE", OWN.card, OWN)).toBe("visaUsd");
    expect(destinationRail("EURC_BASE", OWN.card, OWN)).toBe("visa");
  });

  it("a stable settling to our own EOA credits the wallet of its currency", () => {
    expect(destinationRail("EURC_BASE", OWN.evm, OWN)).toBe("wallet");
    expect(destinationRail("USDC_BASE", OWN.evm, OWN)).toBe("dollar");
    // Case differences in an EVM address are not a different address.
    expect(destinationRail("EURC_BASE", OWN.evm.toLowerCase(), OWN)).toBe("wallet");
  });

  it("a stable sent to a stranger credits nothing", () => {
    expect(destinationRail("EURC_BASE", "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", OWN)).toBe(
      null,
    );
  });

  it("no settle target at all falls back to the asset's own rail", () => {
    expect(destinationRail("EURC_BASE", null, OWN)).toBe("wallet");
    expect(destinationRail("USDC_BASE", undefined, OWN)).toBe("dollar");
  });
});
