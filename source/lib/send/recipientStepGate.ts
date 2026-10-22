// lib/send/recipientStepGate.ts
// The recipient step completes exactly once per opening. A name lookup still
// running when the user picks a contact (or the step closes) is retired at that
// moment, so its late answer can never replace the recipient the user chose.
import { createRecipientLookupGate } from "../pay/recipientLookupGate";

export type RecipientStepGate = {
  /** Start a lookup for `input`; returns its ticket. */
  beginLookup(input: string): number;
  /** True only while the step is open and this lookup is still the one for `input`. */
  lookupIsCurrent(ticket: number, input: string): boolean;
  /** The field changed: drop any lookup in flight. */
  edit(): void;
  /** Complete the step. True the first time only; retires every lookup. */
  complete(): boolean;
  /** A new opening of the step. */
  reset(): void;
};

export function createRecipientStepGate(): RecipientStepGate {
  const lookups = createRecipientLookupGate();
  let done = false;
  return {
    beginLookup: (input) => lookups.begin(input),
    lookupIsCurrent: (ticket, input) => !done && lookups.isCurrent(ticket, input),
    edit: () => lookups.invalidate(),
    complete() {
      lookups.invalidate();
      if (done) return false;
      done = true;
      return true;
    },
    reset() {
      lookups.invalidate();
      done = false;
    },
  };
}
