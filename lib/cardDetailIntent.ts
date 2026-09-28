// A queued card-detail request from a support deep link (`show-iban` /
// `show-card-number`). A one-shot EventBus emit is fire-and-forget and is lost on
// a cold start or before Wirex data has loaded (no mounted listener / not-ready
// data). So the intent is parked here and drained by the unified home once it is
// mounted AND the matching data is ready.
export type CardDetailTab = "card" | "bank";

let pending: CardDetailTab | null = null;

export function setPendingCardDetail(tab: CardDetailTab): void {
  pending = tab;
}

export function peekPendingCardDetail(): CardDetailTab | null {
  return pending;
}

export function clearPendingCardDetail(): void {
  pending = null;
}
