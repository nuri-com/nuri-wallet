/**
 * Guards a recipient lookup against answering for an input the user has since
 * replaced. Each lookup takes a ticket; editing, pasting, closing or reopening
 * invalidates every outstanding ticket. A result is applied only when its ticket
 * is still the latest AND the input it was asked for is still what is on screen
 * — otherwise a slow answer for A would confirm A's address while B is typed.
 */
export type RecipientLookupGate = {
  /** Start a lookup for `input`; returns the ticket to check on completion. */
  begin(input: string): number;
  /** Drop every outstanding lookup (input changed, sheet closed or reopened). */
  invalidate(): void;
  /** True only if `ticket` is the latest lookup and was asked for `currentInput`. */
  isCurrent(ticket: number, currentInput: string): boolean;
};

export function createRecipientLookupGate(): RecipientLookupGate {
  let generation = 0;
  let submitted: string | null = null;
  return {
    begin(input) {
      generation += 1;
      submitted = input.trim();
      return generation;
    },
    invalidate() {
      generation += 1;
      submitted = null;
    },
    isCurrent(ticket, currentInput) {
      return ticket === generation && submitted !== null && submitted === currentInput.trim();
    },
  };
}
