// The bank transfer's to-whom step: which saved contact the user picked last.
// A saved account without a BIC is looked up before the amount step, and the
// user can tap another contact while that runs. Each tap claims the step
// before anything awaits, so only the newest tap may open the amount step or
// the prefilled form; an older lookup that answers later changes nothing.
// Closing or leaving the step claims it too. Pure, so the sequence is testable
// with deferred lookups.
import type { BankTransferRecipient } from "./bankRecipient";

export type BankPickOutcome =
  /** Straight to the amount with this recipient (BIC known). */
  | { kind: "amount"; recipient: BankTransferRecipient }
  /** The recipient form, filled in, so the BIC can be typed. */
  | { kind: "form"; prefill: BankTransferRecipient }
  /** A newer tap, a close or the new-recipient row took over: do nothing. */
  | { kind: "stale" };

export type BicLookup = (iban: string) => Promise<string | null>;

export function createBankPickSequence() {
  let generation = 0;
  return {
    /** The step closed or moved on: every pending pick is stale. */
    invalidate(): void {
      generation += 1;
    },
    /**
     * Resolves a tap on a saved recipient. Claims the step synchronously, so a
     * later tap always wins over this one, whichever lookup answers first.
     */
    async pick(saved: BankTransferRecipient, lookupBic: BicLookup): Promise<BankPickOutcome> {
      generation += 1;
      const mine = generation;
      let bic = saved.bic;
      if (!bic) {
        try {
          bic = (await lookupBic(saved.iban)) ?? "";
        } catch {
          // The lookup is an assist: the form takes the BIC by hand.
          bic = "";
        }
      }
      if (mine !== generation) return { kind: "stale" };
      // Settled: nothing older may act after this.
      generation += 1;
      return bic
        ? { kind: "amount", recipient: { ...saved, bic } }
        : { kind: "form", prefill: saved };
    },
  };
}
