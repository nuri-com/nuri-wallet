// The settle refusal that no amount of retrying can clear.
import { describe, expect, it } from "vitest";

import {
  duplicatedIntentInputs,
  formatDuplicatedIntentError,
  isDuplicatedIntentError,
  isOrphanedIntentRegistrationRefusal,
} from "./duplicatedIntent";

// The operator's real message, verbatim from a stuck boarding sweep.
const REAL_ERROR =
  "INTERNAL_ERROR (0): failed to push intent: failed to push intent after max " +
  "number of retries: duplicated input, " +
  "1740e5f8f9f4a323fb153e59eac7e2f8b57832b52e67fd7e372b0531cb6b6239:0 " +
  "already registered by another intent";

describe("duplicated intent", () => {
  it("recognises the operator's refusal", () => {
    expect(isDuplicatedIntentError(new Error(REAL_ERROR))).toBe(true);
    expect(isDuplicatedIntentError(REAL_ERROR)).toBe(true);
  });

  it("finds it through a wrapping cause", () => {
    expect(
      isDuplicatedIntentError(new Error("settle failed", { cause: new Error(REAL_ERROR) })),
    ).toBe(true);
  });

  it("names the held input", () => {
    expect(duplicatedIntentInputs(REAL_ERROR)).toEqual([
      { txid: "1740e5f8f9f4a323fb153e59eac7e2f8b57832b52e67fd7e372b0531cb6b6239", vout: 0 },
    ]);
  });

  // The shape the refusal usually arrives in: the SDK's recovery delete coming
  // back refused replaces the register error, so this text is what a caller sees.
  it("recognises the same condition through the SDK's refused cleanup delete", () => {
    const refusal = new Error(
      "INVALID_INTENT_PROOF (23): no matching intents found for intent proof",
    );
    expect(isDuplicatedIntentError(refusal)).toBe(false);
    expect(isOrphanedIntentRegistrationRefusal(refusal)).toBe(true);
    // It names no inputs, which is why a caller has to pass its own.
    expect(duplicatedIntentInputs(refusal)).toEqual([]);
  });

  it("does not read a refused cleanup as that condition on its own wording alone", () => {
    // A delete refused for any other reason is not this state.
    expect(isOrphanedIntentRegistrationRefusal(new Error("request timed out"))).toBe(false);
    expect(isOrphanedIntentRegistrationRefusal(null)).toBe(false);
  });

  it("does not claim an unrelated failure", () => {
    // The phrase alone is not the condition: without a concrete outpoint there
    // is nothing held and nothing to wait for, so treating it as the permanent
    // lock would tell the user not to retry a failure that retrying fixes.
    expect(isDuplicatedIntentError(new Error("duplicated input"))).toBe(false);
    expect(isDuplicatedIntentError(new Error("insufficient funds"))).toBe(false);
    expect(isDuplicatedIntentError(null)).toBe(false);
    expect(formatDuplicatedIntentError(new Error("insufficient funds"))).toBe("");
  });

  it("does not tell the user to try again", () => {
    // Retrying builds a fresh intent over the same input and is refused the
    // same way, so "try again" is the one instruction guaranteed to fail.
    const message = formatDuplicatedIntentError(REAL_ERROR);
    expect(message).toMatch(/safe/i);
    expect(message).toMatch(/will not help/i);
  });

  it("collects every held input when several are named", () => {
    const many =
      "duplicated input, " +
      "1740e5f8f9f4a323fb153e59eac7e2f8b57832b52e67fd7e372b0531cb6b6239:0 " +
      "already registered by another intent; duplicated input, " +
      "7e8c1c15079dbaf9fa9d1740e5f8f9f4a323fb153e59eac7e2f8b57832b52e67:3 " +
      "already registered by another intent";
    expect(duplicatedIntentInputs(many)).toHaveLength(2);
    // Stateful regex: a second call must not resume mid-string and miss the
    // first match.
    expect(duplicatedIntentInputs(many)).toHaveLength(2);
  });
});
