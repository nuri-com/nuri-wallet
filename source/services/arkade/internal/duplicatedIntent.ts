// A settle refused because the input is already spoken for.
//
// Arkade refuses a registration over an input another registration already
// holds:
//
//   INTERNAL_ERROR (0): failed to push intent: failed to push intent after max
//   number of retries: duplicated input, <txid>:<vout> already registered by
//   another intent
//
// In arkd v0.9.26 that hold lasts only while the other registration is queued
// or inside a running round. When a round starts, it takes every queued
// registration out of the queue but keeps their inputs held; the hold is
// released when the next round starts, or the input is spent if that round
// finished (`Pop` and `DeleteVtxos` in the intent store, `startRound`). So the
// other registration is an attempt still in flight, from this device or another
// one, and the input frees up within about a minute.
//
// The same moment explains the delete refusal below: the SDK's cleanup delete
// only searches the queue, and the registration holding the input has already
// left it for its round.

/** Inputs another registration is holding, as `txid:vout`. */
export type DuplicatedIntentInput = { txid: string; vout: number };

export type ArkadeDuplicatedIntentDetails = {
  inputs: DuplicatedIntentInput[];
};

const DUPLICATED_INPUT_RE = /duplicated input,\s*([0-9a-fA-F]{64}):(\d+)/g;

export function errorText(error: unknown): string {
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
 * `Wallet.settle` registers through the SDK's own recovery wrapper, which on a
 * `duplicated input` refusal builds a delete proof over its inputs and calls
 * `deleteIntent` without catching it. The registration holding those inputs has
 * already left the queue for its round, so the delete matches nothing and is
 * refused with `INVALID_INTENT_PROOF (23): no matching intents found for intent
 * proof`. That error replaces the register error on the way out.
 *
 * A register refused for any OTHER reason carries a different code and the SDK
 * rethrows it without attempting a delete, so the two shapes are the same state.
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
 * What to tell the user, for either shape of the refusal. The money is safe and
 * the hold clears by itself within about a minute.
 */
export function formatDuplicatedIntentError(error: unknown): string {
  if (!isDuplicatedIntentError(error) && !isOrphanedIntentRegistrationRefusal(error)) return "";
  return (
    "These funds are already in a claim that is still running, from an earlier " +
    "attempt or another device. They are safe. Try again in a minute."
  );
}
