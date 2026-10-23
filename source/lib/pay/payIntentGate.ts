/**
 * Fences a payment link's asynchronous directory lookup to the newest request.
 *
 * Each link starts its own lookup, and they can finish out of order: a slow
 * answer for a link that was already superseded (a second link delivered while
 * the first was still resolving) or for a flow the payer already dismissed must
 * never open a screen. Only a completion whose token is still current may.
 *
 * Kept out of React state on purpose: the answer arrives in a promise
 * continuation, where state read through a closure is one render old.
 */
export class PayIntentGate {
  private generation = 0;

  /** Claim the next intent. Every older completion is stale from here on. */
  begin(): number {
    this.generation += 1;
    return this.generation;
  }

  /** True while `token` is still the newest request. */
  isCurrent(token: number): boolean {
    return token === this.generation;
  }

  /** A dismissed flow, or a screen that unmounted: nothing in flight may open. */
  invalidate(): void {
    this.generation += 1;
  }
}

/**
 * The app-wide resets that close every screen without unmounting the home: a
 * biometric lock, a factory reset, a deep link taking over. A payment link whose
 * lookup is still in flight belongs to the screen that was just closed, so its
 * answer must open nothing.
 */
export const PAY_INTENT_RESET_EVENTS = ["ui:resetMainScreens"] as const;

/**
 * Wires those resets to `gate.invalidate()`. `subscribe` is the app's own
 * subscriber (`EventBus.on`), injected so the wiring itself is testable.
 */
export function fencePayIntentResets(
  gate: PayIntentGate,
  subscribe: (event: string, listener: () => void) => () => void,
): () => void {
  const offs = PAY_INTENT_RESET_EVENTS.map((event) => subscribe(event, () => gate.invalidate()));
  return () => {
    for (const off of offs) off();
  };
}
