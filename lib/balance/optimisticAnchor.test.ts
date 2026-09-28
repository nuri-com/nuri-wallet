import { describe, expect, it } from "vitest";
import {
  addOptimisticMove,
  anchorTarget,
  decideAnchoredBalance,
  dropOptimisticMove,
  type OptimisticAnchor,
} from "./optimisticAnchor";

const NOW = 1_000;
const HOLD = 60_000;

const debit = (anchor: OptimisticAnchor | null, displayed: number, amount: number) =>
  addOptimisticMove(anchor, displayed, amount, "debit", NOW, HOLD);
const credit = (anchor: OptimisticAnchor | null, displayed: number, amount: number) =>
  addOptimisticMove(anchor, displayed, amount, "credit", NOW, HOLD);

// €100 on the card, €50 sent to the wallet, then €10 sent back before the
// ledger caught up with either. The screen shows €60.
const overlappingPair = () => {
  const first = debit(null, 100, 50);
  // The screen already shows €50 when the second move is made.
  const second = credit(first.anchor, 50, 10);
  return {
    anchor: second.anchor as OptimisticAnchor,
    debitId: first.id as number,
    creditId: second.id as number,
  };
};

describe("addOptimisticMove", () => {
  it("anchors the first move against what is on screen", () => {
    const { anchor, id } = debit(null, 100, 50);
    expect(id).toBe(1);
    expect(anchor).toMatchObject({ baseline: 100, moves: [{ id: 1, delta: -50 }] });
  });

  it("never debits past zero", () => {
    expect(debit(null, 30, 50).anchor?.moves[0]?.delta).toBe(-30);
  });

  it("ignores amounts that move nothing", () => {
    expect(debit(null, 100, 0)).toEqual({ anchor: null, id: null });
    expect(credit(null, 100, Number.NaN)).toEqual({ anchor: null, id: null });
    expect(debit(null, 0, 50)).toEqual({ anchor: null, id: null });
  });

  it("keeps the original baseline and hands out distinct ids", () => {
    // The €10 credit is made while €50 is still settling, so the balance on
    // screen is already €50 — but the LEDGER still says €100, which is what the
    // anchor has to keep measuring against.
    const { anchor, debitId, creditId } = overlappingPair();
    expect(anchor.baseline).toBe(100);
    expect(debitId).not.toBe(creditId);
    expect(anchorTarget(anchor)).toBe(60);
  });
});

describe("dropOptimisticMove", () => {
  it("removes the move that failed, not the newest one", () => {
    // Debit A starts, credit B starts, then A fails. Dropping "the last move"
    // would revert B and leave A's €50 deducted for a transfer that never went.
    const { anchor, debitId } = overlappingPair();
    const reverted = dropOptimisticMove(anchor, debitId) as OptimisticAnchor;
    expect(reverted.moves).toHaveLength(1);
    expect(reverted.moves[0]?.delta).toBe(10);
    expect(anchorTarget(reverted)).toBe(110);
  });

  it("clears the anchor when nothing is left outstanding", () => {
    const { anchor, id } = debit(null, 100, 50);
    expect(dropOptimisticMove(anchor, id)).toBeNull();
  });

  it("leaves the anchor alone for an unknown or missing id", () => {
    const { anchor } = debit(null, 100, 50);
    expect(dropOptimisticMove(anchor, 999)).toBe(anchor);
    expect(dropOptimisticMove(anchor, null)).toBe(anchor);
    expect(dropOptimisticMove(null, 1)).toBeNull();
  });
});

describe("decideAnchoredBalance", () => {
  const single = debit(null, 100, 50).anchor as OptimisticAnchor;

  it("holds a stale pre-move read instead of treating it as settlement", () => {
    expect(decideAnchoredBalance(single, 100, NOW + 1)).toBe("hold");
    expect(decideAnchoredBalance(overlappingPair().anchor, 100, NOW + 1)).toBe("hold");
  });

  it("accepts any read that has moved, when the moves all point one way", () => {
    expect(decideAnchoredBalance(single, 50, NOW + 1)).toBe("accept");
    // Below the target: the withdrawal settled AND something else was spent.
    // Wirex has no change-comes-back mechanic, so this is real, not an artefact.
    expect(decideAnchoredBalance(single, 40, NOW + 1)).toBe("accept");
  });

  it("holds an opposing pair still on its way to the target", () => {
    // €100 baseline, −€50/+€10 outstanding, target €60. €90 is neither move
    // landing — nothing has settled, so the promised €60 stands.
    expect(decideAnchoredBalance(overlappingPair().anchor, 90, NOW + 1)).toBe("hold");
    expect(decideAnchoredBalance(overlappingPair().anchor, 61, NOW + 1)).toBe("hold");
  });

  it("accepts an opposing pair once the ledger reaches the net target", () => {
    expect(decideAnchoredBalance(overlappingPair().anchor, 60, NOW + 1)).toBe("accept");
    // Past the target because something else was spent as well — still the
    // ledger's truth, not an artefact.
    expect(decideAnchoredBalance(overlappingPair().anchor, 55, NOW + 1)).toBe("accept");
  });

  it("holds a read that has not caught up with an incoming move", () => {
    const incoming = credit(null, 100, 10).anchor as OptimisticAnchor;
    expect(decideAnchoredBalance(incoming, 100, NOW + 1)).toBe("hold");
    expect(decideAnchoredBalance(incoming, 99, NOW + 1)).toBe("hold");
    expect(decideAnchoredBalance(incoming, 110, NOW + 1)).toBe("accept");
  });

  it("holds an equal debit/credit pair on the stale baseline read", () => {
    // −€50 and +€50 outstanding target the baseline itself, so the pre-transfer
    // read matches exactly. Settling there publishes the baseline while both
    // transfers are still in flight.
    const paired = credit(debit(null, 100, 50).anchor, 50, 50).anchor as OptimisticAnchor;
    expect(anchorTarget(paired)).toBe(100);
    expect(decideAnchoredBalance(paired, 100, NOW + 1)).toBe("hold");
  });

  it("holds an equal pair when only one side has landed", () => {
    const paired = credit(debit(null, 100, 50).anchor, 50, 50).anchor as OptimisticAnchor;
    // The debit landed, the credit has not. Publishing €50 would show the money
    // gone from both sides at once.
    expect(decideAnchoredBalance(paired, 50, NOW + 1)).toBe("hold");
  });

  it("releases an equal pair once one side is reverted", () => {
    const first = debit(null, 100, 50);
    const second = credit(first.anchor, 50, 50);
    const left = dropOptimisticMove(second.anchor, second.id) as OptimisticAnchor;
    expect(anchorTarget(left)).toBe(50);
    expect(decideAnchoredBalance(left, 50, NOW + 1)).toBe("accept");
  });

  it("gives up once expired, whatever the read says", () => {
    expect(decideAnchoredBalance(single, 100, NOW + HOLD + 1)).toBe("accept");
    expect(decideAnchoredBalance(overlappingPair().anchor, 100, NOW + HOLD + 1)).toBe("accept");
  });
});
