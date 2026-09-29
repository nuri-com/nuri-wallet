// Optimistic balance moves that have not reached the ledger yet. Shared by the
// card balance (WirexAccountService) and the wallet balance:
// the two screens hold different numbers but have exactly the same problem, and
// each transfer moves BOTH of them.
//
// A card→wallet debit and a wallet→card credit can overlap: the second is made
// while the first is still settling. Replacing the first hold with the second
// let a stale read satisfy the newer move and release the older one — €100,
// minus €50, plus €10 shows €60, and the next stale read of €100 is >= €60, so
// the balance snapped back to €100.
//
// Each move therefore carries an id and is removed by that id: async calls do
// not fail in the order they were made, and dropping "the newest" would revert
// the wrong transfer. What the moves SHARE is the anchor: the ledger balance
// the first of them started from, which is what every read is judged against.
//
// The balance is one number, so a read cannot say WHICH of several moves it
// reflects. Two rules follow from that:
//   - A read still sitting on the baseline proves nothing. It is the balance
//     from before the moves; releasing on it snaps back to where it started.
//   - A read that has moved is the ledger talking — the Wirex balance has no
//     change-comes-back mechanic, so a figure past the target is a real spend,
//     not an artefact, and is published as-is. UNLESS moves are outstanding in
//     both directions: then a read part-way through (the debit landed, the
//     credit has not) is indistinguishable from a settled one, so the ledger
//     has to actually reach the net target before the anchor lets go.
//
// Kept import-free so it is unit-testable without pulling either of those
// (native-dependency-heavy) modules into the test environment.

export type OptimisticMove = {
  id: number;
  /** Signed: negative leaves the account, positive arrives. */
  delta: number;
};

export type OptimisticAnchor = {
  /** Ledger balance when the first outstanding move was made. */
  baseline: number;
  moves: OptimisticMove[];
  expiresAt: number;
  /** Next id to hand out; ids stay unique across an anchor's lifetime. */
  nextId: number;
};

/** Net effect of everything still outstanding. */
export function anchorNet(anchor: OptimisticAnchor): number {
  return anchor.moves.reduce((sum, move) => sum + move.delta, 0);
}

/** What the user should be shown while the anchor stands. */
export function anchorTarget(anchor: OptimisticAnchor): number {
  return Math.max(0, anchor.baseline + anchorNet(anchor));
}

/**
 * Fold a new move into the anchor and hand back its id. The first move fixes
 * the baseline against the ledger; later ones only add their delta, so the
 * anchor keeps measuring against the balance the moves actually started from.
 */
export function addOptimisticMove(
  anchor: OptimisticAnchor | null,
  displayedBalance: number,
  amount: number,
  direction: "debit" | "credit",
  now: number,
  holdMs: number,
): { anchor: OptimisticAnchor | null; id: number | null } {
  if (!Number.isFinite(amount) || amount <= 0) return { anchor, id: null };
  // A debit can never take what is on screen below zero.
  const delta = direction === "debit" ? -Math.min(amount, displayedBalance) : amount;
  if (delta === 0) return { anchor, id: null };
  const expiresAt = Math.max(anchor?.expiresAt ?? 0, now + holdMs);
  const id = anchor?.nextId ?? 1;
  if (!anchor) {
    return {
      anchor: { baseline: displayedBalance, moves: [{ id, delta }], expiresAt, nextId: id + 1 },
      id,
    };
  }
  return {
    anchor: { ...anchor, moves: [...anchor.moves, { id, delta }], expiresAt, nextId: id + 1 },
    id,
  };
}

/**
 * Drop one move by id — the only reason is that THAT transfer actually failed,
 * and the failure is reported by the call that made it. Every other outstanding
 * move stays exactly as it was.
 */
export function dropOptimisticMove(
  anchor: OptimisticAnchor | null,
  id: number | null,
): OptimisticAnchor | null {
  if (!anchor || id == null) return anchor;
  const moves = anchor.moves.filter((move) => move.id !== id);
  if (moves.length === anchor.moves.length) return anchor;
  return moves.length === 0 ? null : { ...anchor, moves };
}

export type AnchorDecision =
  /** Publish the live read and drop the anchor. */
  | "accept"
  /** Keep showing the anchored figure; this read proves nothing. */
  | "hold";

export function decideAnchoredBalance(
  anchor: OptimisticAnchor,
  liveBalance: number,
  now: number,
): AnchorDecision {
  if (now > anchor.expiresAt) return "accept";
  const net = anchorNet(anchor);
  // A zero net does NOT mean both moves landed: an outstanding −€50/+€50 pair
  // targets the baseline itself, so the next stale pre-transfer read matches it
  // exactly. Settling on that would publish the baseline while both transfers
  // are still in flight, and the first one to land would then show alone. Only
  // a revert or expiry releases an anchor that nets out.
  if (net === 0) return "hold";
  const hasDebit = anchor.moves.some((move) => move.delta < 0);
  const hasCredit = anchor.moves.some((move) => move.delta > 0);
  if (hasDebit && hasCredit) {
    // Opposing moves: a read between the baseline and the target is still on
    // its way — one move has landed and the other has not — so only a read that
    // has reached the target, or gone past it away from the baseline, settles
    // the pair. Anything short of that keeps the promised figure.
    const target = anchor.baseline + net;
    return (net < 0 ? liveBalance <= target : liveBalance >= target) ? "accept" : "hold";
  }
  if (net < 0) return liveBalance >= anchor.baseline ? "hold" : "accept";
  return liveBalance <= anchor.baseline ? "hold" : "accept";
}
