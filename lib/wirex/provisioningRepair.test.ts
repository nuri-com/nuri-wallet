import { describe, expect, it } from "vitest";

import {
  capabilityStatus,
  decideProvisioningRepair,
  readAccountIdentity,
} from "./provisioningRepair";

const CARD_ACTIVE = { type: "VisaVirtualCard", status: "Active" };
const SEPA_ACTIVE = { type: "SepaAccount", status: "Active" };
const SEPA_UNAVAILABLE = {
  type: "SepaAccount",
  status: "NotAvailable",
  status_reason: "Country is not supported",
};

const BASE = { hasUsableCard: false, hasIban: false, allCardsClosed: false };

describe("provisioning repair decision", () => {
  it("judges each rail on its own — a card never suppresses the IBAN repair", () => {
    const decision = decideProvisioningRepair({
      ...BASE,
      capabilities: [CARD_ACTIVE, SEPA_ACTIVE],
      hasUsableCard: true,
    });
    expect(decision).toEqual({ cardDue: false, ibanDue: true, due: true });
  });

  it("repairs the card while the IBAN is present", () => {
    const decision = decideProvisioningRepair({
      ...BASE,
      capabilities: [CARD_ACTIVE, SEPA_ACTIVE],
      hasIban: true,
    });
    expect(decision).toEqual({ cardDue: true, ibanDue: false, due: true });
  });

  it("leaves a rail alone until its capability is Active", () => {
    // The live case: approved long ago, card issued, SEPA blocked by country.
    // Nothing is due until Wirex enables the country.
    const decision = decideProvisioningRepair({
      ...BASE,
      capabilities: [CARD_ACTIVE, SEPA_UNAVAILABLE],
      hasUsableCard: true,
    });
    expect(decision).toEqual({ cardDue: false, ibanDue: false, due: false });
  });

  it("does not re-mint a card the user deliberately closed", () => {
    const decision = decideProvisioningRepair({
      ...BASE,
      capabilities: [CARD_ACTIVE],
      allCardsClosed: true,
    });
    expect(decision.cardDue).toBe(false);
  });

  it("falls back to the dedicated card field when the list omits the rail", () => {
    const decision = decideProvisioningRepair({
      ...BASE,
      capabilities: [],
      visaVirtualCard: { status: "Active" },
    });
    expect(decision.cardDue).toBe(true);
  });

  it("prefers the listed rail over the dedicated field", () => {
    const decision = decideProvisioningRepair({
      ...BASE,
      capabilities: [{ type: "VisaVirtualCard", status: "NotAvailable" }],
      visaVirtualCard: { status: "Active" },
    });
    expect(decision.cardDue).toBe(false);
  });

  it("treats an absent capability as not due, not as inactive", () => {
    expect(capabilityStatus([CARD_ACTIVE], "SepaAccount")).toBeNull();
    expect(decideProvisioningRepair({ ...BASE, capabilities: [] }).due).toBe(false);
    expect(decideProvisioningRepair({ ...BASE, capabilities: null }).due).toBe(false);
  });
});

describe("account identity", () => {
  it("reads the email and residence country off the nested user object", () => {
    expect(
      readAccountIdentity({
        user: {
          profile: { email: " user@example.com " },
          residence_address: { country: "SM" },
        },
      }),
    ).toEqual({ email: "user@example.com", country: "SM" });
  });

  it("reads them off a bare user object too", () => {
    expect(
      readAccountIdentity({
        profile: { email: "user@example.com" },
        residence_address: { country: "DE" },
      }),
    ).toEqual({ email: "user@example.com", country: "DE" });
  });

  it("returns null rather than a default when either is missing", () => {
    expect(readAccountIdentity({ user: { profile: {} } })).toEqual({ email: null, country: null });
    expect(readAccountIdentity(null)).toEqual({ email: null, country: null });
  });
});
