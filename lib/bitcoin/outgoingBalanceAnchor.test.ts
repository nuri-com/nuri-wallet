import { describe, expect, it } from "vitest";
import { decideAnchoredBalance, type OutgoingBalanceAnchor } from "./outgoingBalanceAnchor";

// 100k on screen, 10k sent → the user is shown 90k.
const anchor: OutgoingBalanceAnchor = {
  expected: 90_000,
  preSendTotal: 100_000,
  expiresAt: 2_000,
};

describe("decideAnchoredBalance", () => {
  it("holds a stale pre-send read instead of treating it as settlement", () => {
    // A refresh already in flight when the send was armed answers 100k. It is
    // >= expected, but it is the balance from BEFORE the send — publishing it
    // would undo the deduction and snap the balance back.
    expect(decideAnchoredBalance(anchor, 100_000, 1_000)).toBe("hold");
  });

  // Above the pre-send total is the one read that cannot be the pre-send state:
  // the wallet holds more than it did, which only an incoming payment explains.
  // Holding it here hid received sats for the whole 30-minute window.
  it("accepts a read above the pre-send total", () => {
    expect(decideAnchoredBalance(anchor, 120_000, 1_000)).toBe("accept");
  });

  it("holds the mid-send undershoot while the change is not back", () => {
    // The whole spent VTXO is gone and its change has not returned.
    expect(decideAnchoredBalance(anchor, 5_000, 1_000)).toBe("hold");
  });

  it("accepts the settled read once the change has landed", () => {
    expect(decideAnchoredBalance(anchor, 90_000, 1_000)).toBe("accept");
  });

  it("accepts a settled read that came back slightly under after fees", () => {
    expect(decideAnchoredBalance(anchor, 89_900, 1_000)).toBe("hold");
    expect(decideAnchoredBalance({ ...anchor, expected: 89_000 }, 89_900, 1_000)).toBe("accept");
  });

  it("gives up once expired, whatever the read says", () => {
    expect(decideAnchoredBalance(anchor, 100_000, 2_001)).toBe("accept");
    expect(decideAnchoredBalance(anchor, 5_000, 2_001)).toBe("accept");
  });
});

// A payment landing mid-send is money the anchor never saw. Suppressing it as
// "stale" hid received sats for the whole 30-minute hold — and kept them out of
// the send screen's spendable figure with them.
// A payment landing while a send is in flight is money the anchor never knew
// about, and the read carrying it is authoritative about the new total. Holding
// it hid received sats for the whole 30-minute window; deducting the send from
// it again hid them just as long whenever the read already had the send applied
// — the ordinary case once the change has landed.
describe("an incoming payment while a send is in flight", () => {
  const midSend: OutgoingBalanceAnchor = {
    expected: 90_000,
    preSendTotal: 100_000,
    expiresAt: 10_000,
  };

  // 100k, send 10k, settle to 90k, receive 30k: 120 000 is the whole truth and
  // is published as it stands, not as 110 000.
  it("accepts a read above the pre-send total", () => {
    expect(decideAnchoredBalance(midSend, 120_000, 0)).toBe("accept");
  });

  it("still holds the pre-send total itself", () => {
    expect(decideAnchoredBalance(midSend, 100_000, 0)).toBe("hold");
  });

  // The read the store used to disagree with this helper about: positive, but
  // below the promise, so the change is not back yet.
  it("holds a positive mid-send undershoot", () => {
    expect(decideAnchoredBalance(midSend, 5_000, 0)).toBe("hold");
  });
});
