// A settle refused because the input is already spoken for.
//
// `wallet.settle` registers an intent over its inputs, waits for the batch, and
// on failure deletes the intent again. When that delete does not land — the
// operator answers `INVALID_INTENT_PROOF: no matching intents found` — the
// registration survives the attempt that created it. Every later settle over
// the same input is then refused for as long as the orphan lives:
//
//   INTERNAL_ERROR (0): failed to push intent: failed to push intent after max
//   number of retries: duplicated input, <txid>:<vout> already registered by
//   another intent
//
// The SDK warns about exactly this in its own cleanup path ("intent may linger
// on server and cause 'duplicated input' on next settle").
//
// This is not a transient error and retrying cannot clear it: each attempt
// builds a fresh intent over the same input and is refused the same way. The
// wallet is stuck on those sats until the orphaned intent is removed or
// expires. Surfacing it as a generic failure invites exactly the retry loop
// that cannot work, so it is named here and reported as its own condition.

/** Inputs an orphaned intent is holding, as `txid:vout`. */
export type DuplicatedIntentInput = { txid: string; vout: number };

export type ArkadeDuplicatedIntentDetails = {
  inputs: DuplicatedIntentInput[];
};

const DUPLICATED_INPUT_RE = /duplicated input,\s*([0-9a-fA-F]{64}):(\d+)/g;

function errorText(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const causeText =
      cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
    return `${error.message} ${causeText}`.trim();
  }
  if (typeof error === "object") {
    const record = error as { message?: unknown };
    return String(record.message ?? "");
  }
  return String(error);
}

/**
 * Is this the operator refusing a settle because one of its inputs is still
 * registered under an earlier intent?
 */
export function isDuplicatedIntentError(error: unknown): boolean {
  const text = errorText(error);
  if (!text) return false;
  // Both halves are required. "duplicated input" alone could appear in an
  // unrelated validation message, and matching only the phrase would classify
  // a plain bad request as an unrecoverable lock.
  DUPLICATED_INPUT_RE.lastIndex = 0;
  return /duplicated input/i.test(text) && DUPLICATED_INPUT_RE.test(text);
}

const ORPHANED_REGISTRATION_DELETE_REFUSAL_RE = /no matching intents found for intent proof/i;

/**
 * The SAME condition as {@link isDuplicatedIntentError}, in the shape it usually
 * arrives in.
 *
 * The refusal above almost never reaches a caller intact. `Wallet.settle`
 * registers the intent through the SDK's own recovery wrapper, which on
 * `ArkError { code: 0, message: "... duplicated input ..." }` builds a delete
 * proof over its inputs and calls `deleteIntent` — without catching it. The ASP
 * holding those inputs is the *older* registration, not ours, so the delete
 * matches nothing and is refused with
 * `INVALID_INTENT_PROOF (23): no matching intents found for intent proof`. That
 * error replaces the register error on the way out (the later delete attempt
 * inside the settle is caught and only warned about), so a caller matching the
 * duplicated-input text alone sees only the delete refusal, records nothing, and
 * re-selects the same stuck coin forever.
 *
 * Reading only the text: this refusal can only come out of that branch. A
 * register refused for any OTHER reason carries a different code and the SDK
 * rethrows it without attempting a delete at all, so the two conditions are the
 * same state — an earlier registration still holds one of this attempt's inputs.
 */
export function isOrphanedIntentRegistrationRefusal(error: unknown): boolean {
  return ORPHANED_REGISTRATION_DELETE_REFUSAL_RE.test(errorText(error));
}

/**
 * The inputs named in the refusal, so a caller can say which sats are held and
 * a recovery path knows what to release. Empty when this is not that error.
 *
 * A refusal recognised only by {@link isOrphanedIntentRegistrationRefusal}
 * names nothing — the delete proof carries no metadata — so a caller in that
 * case has to supply the outpoints it just tried.
 */
export function duplicatedIntentInputs(error: unknown): DuplicatedIntentInput[] {
  const text = errorText(error);
  if (!text) return [];
  const found: DuplicatedIntentInput[] = [];
  const seen = new Set<string>();
  DUPLICATED_INPUT_RE.lastIndex = 0;
  let match = DUPLICATED_INPUT_RE.exec(text);
  while (match) {
    const txid = String(match[1]).toLowerCase();
    const vout = Number(match[2]);
    const key = `${txid}:${vout}`;
    if (Number.isFinite(vout) && !seen.has(key)) {
      seen.add(key);
      found.push({ txid, vout });
    }
    match = DUPLICATED_INPUT_RE.exec(text);
  }
  return found;
}

/**
 * What to tell the user. Names the condition rather than the sats: the money is
 * safe on-chain and needs no action, and "try again" is the one instruction
 * that is guaranteed not to work.
 */
export function formatDuplicatedIntentError(error: unknown): string {
  const inputs = duplicatedIntentInputs(error);
  if (inputs.length === 0) return "";
  return (
    "These funds are held by an earlier claim that did not finish. " +
    "They are safe and nothing was lost, but the claim has to clear on the " +
    "server before it can run again. Retrying now will not help."
  );
}
