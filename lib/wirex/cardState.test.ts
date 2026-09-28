import { describe, expect, it } from "vitest";

import { detailsSheetCardId, isAwaitingReplacementCard, isWirexCardReady } from "./cardState";
import type { WirexCardSnapshot } from "../../services/wirex/WirexAccountService";

const APPROVED: WirexCardSnapshot = {
  loading: false,
  error: null,
  isApproved: true,
  isRejected: false,
  verificationStatus: "Approved",
  card: { id: "card-1", status: "Active", last4: "1234" },
  cards: [{ id: "card-1", last4: "1234", isFrozen: false }],
  iban: null,
  balanceEur: 12.34,
  balancesByFiat: { EUR: 12.34 },
  smartAccountAddress: "0x2222222222222222222222222222222222222222",
  wallet: "0x1111111111111111111111111111111111111111",
  isFrozen: false,
  allCardsClosed: false,
  holderName: "Test User",
};

// What load() publishes once the only card is closed: /status still lists it, the
// filter drops it, and allCardsClosed records that this is a statement.
const LAST_CARD_CLOSED: WirexCardSnapshot = {
  ...APPROVED,
  card: null,
  cards: [],
  isFrozen: null,
  allCardsClosed: true,
};

describe("wirex card readiness", () => {
  it("offers a replacement once the last card is closed", () => {
    expect(isAwaitingReplacementCard(LAST_CARD_CLOSED)).toBe(true);
    // The screen's card content stays off: there is no card to reveal.
    expect(isWirexCardReady(LAST_CARD_CLOSED)).toBe(false);
  });

  it("does not offer a replacement while a card exists", () => {
    expect(isAwaitingReplacementCard(APPROVED)).toBe(false);
    expect(isWirexCardReady(APPROVED)).toBe(true);
  });

  it("does not offer a replacement for a read that merely arrived without cards", () => {
    // A gap, not a statement — offering a replacement here would sell a second
    // card to someone whose card is fine.
    const noCardsYet: WirexCardSnapshot = { ...LAST_CARD_CLOSED, allCardsClosed: false };
    expect(isAwaitingReplacementCard(noCardsYet)).toBe(false);
  });

  it("waits for a readable balance and smart account before offering one", () => {
    // Issuing needs the account to be actually usable; an unreadable balance
    // means the read did not get that far.
    expect(isAwaitingReplacementCard({ ...LAST_CARD_CLOSED, balanceEur: null })).toBe(false);
    expect(isAwaitingReplacementCard({ ...LAST_CARD_CLOSED, smartAccountAddress: null })).toBe(
      false,
    );
  });

  it("does not offer a replacement to an account that was never approved", () => {
    expect(isAwaitingReplacementCard({ ...LAST_CARD_CLOSED, isApproved: false })).toBe(false);
    expect(isAwaitingReplacementCard(null)).toBe(false);
  });
});

describe("details sheet card id", () => {
  it("is null while the carousel shows its placeholder face", () => {
    // The placeholder carries a synthetic id. Passed through, the sheet would
    // offer freeze and PERMANENT close for a card that does not exist.
    expect(detailsSheetCardId(LAST_CARD_CLOSED, "wirex-card")).toBeNull();
  });

  it("is the tapped card's id when the account has cards", () => {
    expect(detailsSheetCardId(APPROVED, "card-1")).toBe("card-1");
    expect(detailsSheetCardId(APPROVED, undefined)).toBeNull();
  });
});
