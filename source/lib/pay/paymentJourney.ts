// Whether the user is in the middle of paying someone (#1978).
//
// The home's send screens (scanner, recipient step, amount screens) report
// here while they are open. App reads it to hold back the coin-renewal screen:
// renewal is shown on the "Access wallet" lock screen (#1855), so popping it
// over a scanned payment looks like the wallet asking for access again, and
// its passkey ceremony would overlap the payment's own approval. Renewal is
// not urgent to the second (it is offered 16 d 5 h before expiry), so it waits
// until the payment screens close. Nothing here skips any authentication: the
// renewal still needs its own tap and passkey once it is shown.

type Listener = () => void;

const sources = new Set<string>();
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** Mark one payment screen open or closed. Idempotent per source. */
export function setPaymentJourneySource(source: string, open: boolean): void {
  const had = sources.has(source);
  if (open === had) return;
  if (open) sources.add(source);
  else sources.delete(source);
  notify();
}

export function isPaymentJourneyActive(): boolean {
  return sources.size > 0;
}

export function subscribePaymentJourney(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

type UnlockItem = { kind: string };

/**
 * Whether the receive-unlock screen may open by itself now. Only a
 * renewal-only offer waits for the payment to finish; a Lightning claim or a
 * boarding sweep is money arriving and still opens at once.
 */
export function mayAutoOpenUnlock(
  items: readonly UnlockItem[],
  paymentJourneyActive: boolean,
): boolean {
  if (!paymentJourneyActive) return true;
  return !(items.length > 0 && items.every((item) => item.kind === "vtxo_renewal"));
}

/** Test-only: forget every open source. */
export function resetPaymentJourneyForTests(): void {
  sources.clear();
  listeners.clear();
}
