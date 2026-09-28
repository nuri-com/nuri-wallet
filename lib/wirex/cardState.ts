import type { WirexCardSnapshot } from "../../services/wirex/WirexAccountService";

// The card screen's state decisions, kept out of the component so they can be
// tested without a renderer. Each one answers a question the screen asks about
// the snapshot; none of them touch UI.

// Card-ready = approved + card + readable wallet. Wirex issues the card first and
// the bank account moments later, so IBAN is a separate bank-readiness gate.
export function isWirexCardReady(snapshot: WirexCardSnapshot | null): boolean {
  return Boolean(
    snapshot?.isApproved &&
      snapshot.card?.id &&
      snapshot.balanceEur !== null &&
      snapshot.smartAccountAddress,
  );
}

export function isWirexBankReady(snapshot: WirexCardSnapshot | null): boolean {
  return Boolean(snapshot?.iban?.iban);
}

/**
 * Approved, funds readable, and every card closed. The account works — it just
 * has no card, and unlike every other not-ready state nothing is on its way:
 * only the user issuing a replacement changes it. The screen keeps the
 * placeholder face tappable here so the account does not dead-end on a disabled
 * "Verification in progress" after a successful close.
 *
 * `allCardsClosed` is what makes this safe to distinguish: a snapshot that
 * merely arrived without cards is a gap, and treating that as "closed" would
 * offer a replacement to someone whose card is fine.
 */
export function isAwaitingReplacementCard(snapshot: WirexCardSnapshot | null): boolean {
  return Boolean(
    snapshot?.isApproved &&
      snapshot.allCardsClosed &&
      snapshot.balanceEur !== null &&
      snapshot.smartAccountAddress,
  );
}

/**
 * The card id the details sheet may act on. The card face shows a placeholder
 * face when there is no card, and that face carries a synthetic id — everything
 * downstream reads a present id as "there is a card here", including the close
 * action. An empty card list therefore has to resolve to null.
 */
export function detailsSheetCardId(
  snapshot: WirexCardSnapshot | null,
  activeCardId: string | null | undefined,
): string | null {
  if (!snapshot?.cards.length) return null;
  return activeCardId ?? null;
}
