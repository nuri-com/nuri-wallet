// An expired signing session is not a failed request: the same registration works
// in the next round, and it is the only failure that earns a second attempt.
import { describe, expect, it, vi } from "vitest";

import {
  BOARDING_SWEEP_JOIN_ATTEMPTS,
  isSessionExpiredFailure,
  retryExpiredSession,
} from "./sessionJoinRetry";

// Verbatim from a stuck boarding sweep: the round's nonce window closed first.
const NONCE_TIMEOUT =
  "SIGNING_SESSION_TIMED_OUT (28): musig2 signing session timed out (nonce collection), " +
  "collected 0/1 nonces";
// Verbatim: our nonces arrived for a round the ASP no longer had a session for.
const SESSION_NOT_FOUND =
  "INTERNAL_ERROR (0): failed to add nonces: signing session not found for round " +
  "3f5107b8-f377-4d83-84d1-70f888a75c03";
// Verbatim: an earlier registration still holds the inputs.
const DUPLICATED =
  "INTERNAL_ERROR (0): failed to push intent: failed to push intent after max number of " +
  "retries: duplicated input, 7471c48fa4c8d024523edf1b7e932e5f7033bfe5fe40e2e91aef530771c3692f:0 " +
  "already registered by another intent";
const DELETE_REFUSED = "INVALID_INTENT_PROOF (23): no matching intents found for intent proof";

describe("session expired", () => {
  it("recognises the two shapes the expired session arrives in", () => {
    expect(isSessionExpiredFailure(new Error(NONCE_TIMEOUT))).toBe(true);
    expect(isSessionExpiredFailure(new Error(SESSION_NOT_FOUND))).toBe(true);
    expect(isSessionExpiredFailure(NONCE_TIMEOUT)).toBe(true);
  });

  it("reads the reason through a wrapping cause", () => {
    const wrapped = new Error("onboard failed", { cause: new Error(NONCE_TIMEOUT) });

    expect(isSessionExpiredFailure(wrapped)).toBe(true);
  });

  // Held inputs are the one case a retry cannot clear, in either shape it arrives.
  it("never treats a held registration as an expired session", () => {
    expect(isSessionExpiredFailure(new Error(DUPLICATED))).toBe(false);
    expect(isSessionExpiredFailure(new Error(DELETE_REFUSED))).toBe(false);
  });

  // A round can also end for reasons that have nothing to do with our nonce
  // window. Retrying those added registrations without changing the outcome.
  it("leaves other round failures and unrelated errors alone", () => {
    expect(
      isSessionExpiredFailure(
        new Error("INTERNAL_ERROR (0): not_enough_intent_confirmations_received"),
      ),
    ).toBe(false);
    expect(isSessionExpiredFailure(new Error("batch_failed: forfeit tx rejected"))).toBe(false);
    expect(isSessionExpiredFailure(new Error("insufficient funds"))).toBe(false);
    expect(isSessionExpiredFailure(null)).toBe(false);
    expect(isSessionExpiredFailure(undefined)).toBe(false);
  });
});

describe("retryExpiredSession", () => {
  it("registers once more when the session expired, and runs", async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error(NONCE_TIMEOUT))
      .mockResolvedValueOnce("txid");
    const onRetry = vi.fn();

    await expect(retryExpiredSession(run, { delayMs: 0, onRetry })).resolves.toBe("txid");

    expect(run).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls.map(([attempt]) => attempt)).toEqual([1]);
  });

  it("cannot register more than once per unlock", async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error(NONCE_TIMEOUT))
      .mockRejectedValueOnce(new Error(SESSION_NOT_FOUND));

    await expect(retryExpiredSession(run, { delayMs: 0 })).rejects.toThrow(
      /signing session not found/,
    );

    expect(BOARDING_SWEEP_JOIN_ATTEMPTS).toBe(2);
    expect(run).toHaveBeenCalledTimes(2);
  });

  // Either other failure would have produced a registration attempt that could
  // not help, which is what made every tap look like it registered repeatedly.
  it("does not touch the round again for any other failure", async () => {
    for (const error of [
      new Error("INTERNAL_ERROR (0): not_enough_intent_confirmations_received"),
      new Error("batch_failed: forfeit tx rejected"),
      new Error(DUPLICATED),
      new Error(DELETE_REFUSED),
    ]) {
      const run = vi.fn<() => Promise<string>>().mockRejectedValue(error);
      const onRetry = vi.fn();

      await expect(retryExpiredSession(run, { delayMs: 0, onRetry })).rejects.toThrow();

      expect(run).toHaveBeenCalledTimes(1);
      expect(onRetry).not.toHaveBeenCalled();
    }
  });

  it("does not retry a call that succeeds", async () => {
    const run = vi.fn<() => Promise<string>>().mockResolvedValue("txid");

    await expect(retryExpiredSession(run, { delayMs: 0 })).resolves.toBe("txid");

    expect(run).toHaveBeenCalledTimes(1);
  });
});
