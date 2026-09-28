import { describe, expect, it } from "vitest";
import {
  assertWirexVirtualCardNames,
  buildWirex3dsResponseMessage,
  buildWirexCardActionMessage,
  buildWirexIssueVirtualCardMessage,
  buildWirexSepaTransferMessage,
} from "./cardActionMessage";

// These strings are verified byte-for-byte by the MCP (src/tools.mjs
// cardActionMessage) — a drift here breaks every signed card mutation.
describe("buildWirexCardActionMessage", () => {
  it("builds freeze/unfreeze/activate messages", () => {
    expect(buildWirexCardActionMessage({ action: "freeze", cardId: "abc-1", ts: 1751500000 })).toBe(
      "Nuri Wirex: freeze card abc-1 at 1751500000",
    );
    expect(
      buildWirexCardActionMessage({ action: "unfreeze", cardId: "abc-1", ts: 1751500000 }),
    ).toBe("Nuri Wirex: unfreeze card abc-1 at 1751500000");
  });

  // Close is the ONE action whose wording differs — the user signs the word
  // PERMANENTLY plus the last4 they were shown. "close card <id>" (or a missing
  // `ending <last4>`) would never verify server-side.
  it("uses the PERMANENTLY wording and the shown last4 for close", () => {
    expect(
      buildWirexCardActionMessage({
        action: "close",
        cardId: "abc-1",
        last4: "4242",
        ts: 1751500000,
      }),
    ).toBe("Nuri Wirex: PERMANENTLY close card abc-1 ending 4242 at 1751500000");
  });

  it("appends the limit for set-limit (incl. -1 = no limit)", () => {
    expect(
      buildWirexCardActionMessage({ action: "set-limit", cardId: "c", ts: 7, limit: 500 }),
    ).toBe("Nuri Wirex: set-limit card c to 500 at 7");
    expect(
      buildWirexCardActionMessage({ action: "set-limit", cardId: "c", ts: 7, limit: -1 }),
    ).toBe("Nuri Wirex: set-limit card c to -1 at 7");
  });
});

// Money-out signature message — a drift here breaks every signed SEPA transfer
// (funds can't move without this signature recovering to the owner on the server).
describe("buildWirexSepaTransferMessage", () => {
  it("binds amount + destination IBAN + timestamp", () => {
    expect(
      buildWirexSepaTransferMessage({
        amount: 10.5,
        iban: "DE89370400440532013000",
        ts: 1751500000,
      }),
    ).toBe("Nuri Wirex: sepa transfer 10.5 to DE89370400440532013000 at 1751500000");
  });
});

// Issue-virtual-card message — a drift here makes card issuance fail, and an
// omitted name MUST sign as the empty string (the server rebuilds it that way).
describe("buildWirexIssueVirtualCardMessage", () => {
  it("signs both names, empty when omitted", () => {
    expect(buildWirexIssueVirtualCardMessage({ ts: 1751500000 })).toBe(
      "Nuri Wirex: issue virtual card; card_name=; name_on_card=; at 1751500000",
    );
    expect(
      buildWirexIssueVirtualCardMessage({
        cardName: "Travel",
        nameOnCard: "ADA LOVELACE",
        ts: 1751500000,
      }),
    ).toBe(
      "Nuri Wirex: issue virtual card; card_name=Travel; name_on_card=ADA LOVELACE; at 1751500000",
    );
  });
});

// Local pre-signature validation. The delimiter rule keeps two different name
// pairs from producing identical signed bytes; the checks run before the passkey
// prompt so a name the server rejects never costs the user a tap.
describe("assertWirexVirtualCardNames", () => {
  it("accepts omitted, blank and in-range names", () => {
    expect(() => assertWirexVirtualCardNames({})).not.toThrow();
    expect(() => assertWirexVirtualCardNames({ cardName: "", nameOnCard: "" })).not.toThrow();
    expect(() =>
      assertWirexVirtualCardNames({ cardName: "Travel", nameOnCard: "ADA LOVELACE" }),
    ).not.toThrow();
    // Exact bounds: 1–50 and 2–26.
    expect(() =>
      assertWirexVirtualCardNames({ cardName: "x".repeat(50), nameOnCard: "ab" }),
    ).not.toThrow();
    expect(() => assertWirexVirtualCardNames({ nameOnCard: "y".repeat(26) })).not.toThrow();
  });

  it.each([";", "\n", "\r"])("rejects %j in either name", (bad) => {
    expect(() => assertWirexVirtualCardNames({ cardName: `Tra${bad}vel` })).toThrow(
      "card_name_must_not_contain_semicolon_or_newline",
    );
    expect(() => assertWirexVirtualCardNames({ nameOnCard: `ADA${bad}` })).toThrow(
      "name_on_card_must_not_contain_semicolon_or_newline",
    );
  });

  it("rejects out-of-range lengths", () => {
    expect(() => assertWirexVirtualCardNames({ cardName: "x".repeat(51) })).toThrow(
      "card_name_must_be_1_to_50_chars",
    );
    expect(() => assertWirexVirtualCardNames({ nameOnCard: "A" })).toThrow(
      "name_on_card_must_be_2_to_26_chars",
    );
    expect(() => assertWirexVirtualCardNames({ nameOnCard: "y".repeat(27) })).toThrow(
      "name_on_card_must_be_2_to_26_chars",
    );
  });
});

// In-app 3DS response message — a drift here makes every in-app 3DS approval
// fail silently (the server can't recover the signer to the owner).
describe("buildWirex3dsResponseMessage", () => {
  it("builds approve and decline messages", () => {
    expect(
      buildWirex3dsResponseMessage({ approve: true, transactionId: "tx-123", ts: 1751500000 }),
    ).toBe("Nuri Wirex: 3ds approve tx-123 at 1751500000");
    expect(
      buildWirex3dsResponseMessage({ approve: false, transactionId: "tx-123", ts: 1751500000 }),
    ).toBe("Nuri Wirex: 3ds decline tx-123 at 1751500000");
  });
});
