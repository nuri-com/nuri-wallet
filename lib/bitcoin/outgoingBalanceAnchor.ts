// What to do with a live Arkade balance read while an outgoing send is in
// flight. An Arkade send spends whole VTXOs and gets the change back as a new
// one, so between the two the wallet reports only the untouched VTXOs and the
// headline collapses by far more than was sent. The anchor holds the figure the
// user was promised — showing minus sent — until a read has actually caught up.
//
// Three reads can arrive while the anchor stands, and only one of them is
// evidence of settlement:
//   - BELOW the anchor      → mid-send, the change is not back yet.
//   - AT the pre-send total → a refresh that started before the send, or one
//     the server answered from the pre-send state. It looks like a settled
//     read only because nothing has moved yet; releasing on it publishes the
//     old balance and undoes the deduction, which is the snap-back this exists
//     to prevent.
//   - between the two       → the change has landed. Settled.
//
// Kept in its own import-free module so it is unit-testable without pulling the
// (native-dependency-heavy) balance store into the test environment.

export type OutgoingBalanceAnchor = {
  /** The total the balance should read once the send settles. */
  expected: number;
  /** What was showing when the send was armed. */
  preSendTotal: number;
  /** Past this the anchor gives up regardless — a send cannot hold forever. */
  expiresAt: number;
};

export type AnchorDecision =
  /** Publish the live read and drop the anchor. */
  | "accept"
  /** Keep showing the anchored figure; this read proves nothing. */
  | "hold";

/**
 * The ONE rule, so the store cannot hold a second opinion about the same read.
 *
 * A zero read is `hold` like any other undershoot; the store additionally
 * debounces zeros for a reason of its own, which is that a zero is worth
 * confirming even with no send in flight.
 */
export function decideAnchoredBalance(
  anchor: OutgoingBalanceAnchor,
  liveTotal: number,
  now: number,
): AnchorDecision {
  if (now > anchor.expiresAt) return "accept";
  // Mid-send: the spent VTXO is gone and its change has not returned. Publishing
  // it would empty the balance in front of the user, and a later stale pre-send
  // read would then put the spent sats back on screen.
  if (liveTotal < anchor.expected) return "hold";
  // ABOVE the pre-send total, the wallet holds more than it did when the send
  // was armed — only an incoming payment explains that, and it is authoritative
  // about money the anchor never knew about. Suppressing it hid received sats
  // for the whole hold; deducting the send from it again hid them just as long
  // when the read already had the send applied. The read is published as it
  // stands and the anchor is done: the send it described is no longer the whole
  // truth about this wallet.
  if (liveTotal > anchor.preSendTotal) return "accept";
  // AT the pre-send total exactly: a refresh answered from the pre-send state.
  // Releasing on it undoes the deduction and snaps the balance back.
  if (liveTotal === anchor.preSendTotal) return "hold";
  return "accept";
}
