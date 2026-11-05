// When a pending-3DS read may open the approval view (#1273).
//
// A challenge is a card payment the user is standing in front of, so the list
// is read on a foreground interval as well as on open, foreground and
// `card:refresh`. The interval must not undo a dismiss: if it re-opened the view
// on every tick, closing it would last only until the next read. So:
//
// - an explicit read (open, foreground, card:refresh) shows any pending
//   challenge, even one the user closed, as before;
// - an interval read opens the view only for a challenge it has not seen yet,
//   and otherwise leaves the current visibility alone.
//
// An empty list always hides the view; the hook does that on its own.

/** Foreground read interval for pending 3DS challenges. */
export const THREE_DS_PENDING_POLL_MS = 10_000;

export type ThreeDsReadKind = "explicit" | "interval";

export function threeDsVisibleAfterRead(input: {
  kind: ThreeDsReadKind;
  pendingIds: readonly string[];
  seenIds: ReadonlySet<string>;
  visible: boolean;
}): boolean {
  const { kind, pendingIds, seenIds, visible } = input;
  if (pendingIds.length === 0) return false;
  if (kind === "explicit") return true;
  return visible || pendingIds.some((id) => !seenIds.has(id));
}
