import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BOARDING_SWEEP_BLOCKED_TTL_MS,
  boardingOutpointRefKey,
  clearBoardingOutpointsBlocked,
  isBoardingOutpointBlocked,
  markBoardingOutpointsBlocked,
  getBlockedBoardingRotationState,
  selectNextBlockedBoardingCandidate,
  partitionBlockedBoardingCandidates,
  recordBlockedBoardingAttempt,
  recordBlockedBoardingTurn,
  resetBoardingSweepBlockedCache,
} from "./boardingSweepBlocked";

vi.mock("./logging", () => ({ emitTrace: vi.fn() }));

const LOW = "aa".repeat(32);
const HIGH = "bb".repeat(32);

const coin = (txid: string) => ({ txid, vout: 0, key: () => `${txid}:0` });

beforeEach(() => {
  resetBoardingSweepBlockedCache();
});

describe("boardingSweepBlocked", () => {
  it("rejects keys that are not a real outpoint", () => {
    expect(boardingOutpointRefKey({ txid: LOW, vout: 0 })).toBe(`${LOW}:0`);
    expect(boardingOutpointRefKey({ txid: LOW.toUpperCase(), vout: 0 })).toBe(`${LOW}:0`);
    expect(boardingOutpointRefKey({ txid: "nope", vout: 0 })).toBeNull();
    expect(boardingOutpointRefKey({ txid: LOW, vout: -1 })).toBeNull();
    expect(boardingOutpointRefKey({ txid: LOW, vout: 1.5 })).toBeNull();
  });

  it("skips a blocked outpoint while another candidate is available", () => {
    markBoardingOutpointsBlocked([{ txid: LOW, vout: 0 }], "duplicated input");
    const { candidates, skipped } = partitionBlockedBoardingCandidates(
      [coin(LOW), coin(HIGH)],
      (c) => c.key(),
    );
    expect(skipped).toEqual([`${LOW}:0`]);
    expect(candidates.map((c) => c.txid)).toEqual([HIGH]);
  });

  it("still attempts a blocked outpoint when it is the ONLY candidate", () => {
    // Otherwise a user whose single boarding UTXO is stuck, and whose
    // registration has since cleared, would never get an attempt again.
    markBoardingOutpointsBlocked([{ txid: LOW, vout: 0 }], "duplicated input");
    const { candidates } = partitionBlockedBoardingCandidates([coin(LOW)], (c) => c.key());
    expect(candidates.map((c) => c.txid)).toEqual([LOW]);
  });

  it("stops skipping an outpoint once the TTL has passed", () => {
    const t0 = 1_000_000;
    markBoardingOutpointsBlocked([{ txid: LOW, vout: 0 }], "duplicated input", t0);
    expect(isBoardingOutpointBlocked(`${LOW}:0`, t0 + BOARDING_SWEEP_BLOCKED_TTL_MS - 1)).toBe(
      true,
    );
    expect(isBoardingOutpointBlocked(`${LOW}:0`, t0 + BOARDING_SWEEP_BLOCKED_TTL_MS)).toBe(false);
    // The expired entry is dropped, so a later partition sees both candidates.
    const { candidates } = partitionBlockedBoardingCandidates(
      [coin(LOW), coin(HIGH)],
      (c) => c.key(),
      t0 + BOARDING_SWEEP_BLOCKED_TTL_MS,
    );
    expect(candidates).toHaveLength(2);
  });

  it("clears the block for an outpoint that finally swept", () => {
    markBoardingOutpointsBlocked([{ txid: LOW, vout: 0 }], "duplicated input");
    clearBoardingOutpointsBlocked([`${LOW}:0`]);
    expect(isBoardingOutpointBlocked(`${LOW}:0`)).toBe(false);
  });

  // Review finding: the all-blocked fallback used to hand back every blocked
  // coin unchanged, and the sweep takes the lowest outpoint of whatever it gets,
  // so with two stuck coins the higher one was never attempted and a
  // registration the ASP released above it stayed invisible.
  const THIRD = "cc".repeat(32);

  const targetOf = (coins: Array<ReturnType<typeof coin>>) =>
    selectNextBlockedBoardingCandidate(coins, (c) => c.key())?.txid;

  it("targets the blocked coin with the fewest turns, lowest outpoint on a tie", () => {
    const coins = [coin(LOW), coin(HIGH), coin(THIRD)];
    // Only blocked coins carry rotation state.
    for (const txid of [LOW, HIGH, THIRD]) {
      markBoardingOutpointsBlocked([{ txid, vout: 0 }], "duplicated input");
    }

    // Nothing attempted yet: the lowest outpoint, which is what the selection
    // would have taken on its own.
    expect(targetOf(coins)).toBe(LOW);

    recordBlockedBoardingTurn(`${LOW}:0`);
    expect(targetOf(coins)).toBe(HIGH);

    // Two attempts in: the third coin has never been tried, and dropping only
    // the just-attempted one would have left it unreachable forever.
    recordBlockedBoardingTurn(`${HIGH}:0`);
    expect(targetOf(coins)).toBe(THIRD);

    // All three attempted once: back to the lowest, a true round-robin.
    recordBlockedBoardingTurn(`${THIRD}:0`);
    expect(targetOf(coins)).toBe(LOW);

    recordBlockedBoardingTurn(`${LOW}:0`);
    expect(targetOf(coins)).toBe(HIGH);
  });

  it("returns the coin the sweep can actually select, not a reordered list", () => {
    // The selection sorts whatever it is given by outpoint and takes the first,
    // so a list ordered "just attempted last" would be silently re-sorted.
    for (const txid of [LOW, HIGH, THIRD]) {
      markBoardingOutpointsBlocked([{ txid, vout: 0 }], "duplicated input");
    }
    recordBlockedBoardingTurn(`${LOW}:0`);
    recordBlockedBoardingTurn(`${HIGH}:0`);
    expect(targetOf([coin(LOW), coin(HIGH), coin(THIRD)])).toBe(THIRD);
  });

  // Review finding: a turn that dies in preflight (summary load, fee info,
  // approval) used to be counted as an attempt, so the count no longer meant
  // "we reached the ASP" and the rotation was driven by failures that carry no
  // information about the registration.
  it("counts a turn that never reached the ASP as a turn, not an attempt", () => {
    markBoardingOutpointsBlocked([{ txid: LOW, vout: 0 }], "duplicated input");

    recordBlockedBoardingTurn(`${LOW}:0`);
    expect(getBlockedBoardingRotationState()[`${LOW}:0`]).toEqual({ turns: 1, attempts: 0 });

    // The settle call is what records an ASP attempt.
    recordBlockedBoardingAttempt(`${LOW}:0`);
    expect(getBlockedBoardingRotationState()[`${LOW}:0`]).toEqual({ turns: 1, attempts: 1 });
  });

  it("rotates on turns, so a preflight failure cannot pin the rotation", () => {
    for (const txid of [LOW, HIGH, THIRD]) {
      markBoardingOutpointsBlocked([{ txid, vout: 0 }], "duplicated input");
    }
    const coins = [coin(LOW), coin(HIGH), coin(THIRD)];

    // Three attempts, none of which reached the ASP.
    expect(targetOf(coins)).toBe(LOW);
    recordBlockedBoardingTurn(`${LOW}:0`);
    expect(targetOf(coins)).toBe(HIGH);
    recordBlockedBoardingTurn(`${HIGH}:0`);
    expect(targetOf(coins)).toBe(THIRD);
    recordBlockedBoardingTurn(`${THIRD}:0`);

    // Every coin has had a turn and none is marked as ASP-attempted.
    const state = getBlockedBoardingRotationState();
    expect(Object.values(state).map((entry) => entry.attempts)).toEqual([0, 0, 0]);
    expect(targetOf(coins)).toBe(LOW);
  });

  // Review finding: a newly blocked coin started at zero turns, so it held the
  // front of the rotation until it caught up with the coins already waiting.
  it("a newly blocked coin joins the back of the rotation, not the front", () => {
    markBoardingOutpointsBlocked([{ txid: LOW, vout: 0 }], "duplicated input");
    markBoardingOutpointsBlocked([{ txid: HIGH, vout: 0 }], "duplicated input");
    recordBlockedBoardingTurn(`${LOW}:0`);
    recordBlockedBoardingTurn(`${LOW}:0`);
    recordBlockedBoardingTurn(`${HIGH}:0`);
    recordBlockedBoardingTurn(`${HIGH}:0`);

    // THIRD sorts above both, so a fair queue picks LOW; a zero-seeded newcomer
    // would have been picked twice in a row instead.
    markBoardingOutpointsBlocked([{ txid: THIRD, vout: 0 }], "duplicated input");
    expect(getBlockedBoardingRotationState()[`${THIRD}:0`].turns).toBe(2);
    expect(targetOf([coin(LOW), coin(HIGH), coin(THIRD)])).toBe(LOW);
  });

  // Review finding: a newcomer ties with the coins already waiting, and the tie
  // was broken by outpoint, so a coin refused a moment ago sorted ahead of them
  // and was retried on the very next pass.
  it("a newcomer that sorts first is still not retried immediately", () => {
    markBoardingOutpointsBlocked([{ txid: HIGH, vout: 0 }], "duplicated input");
    recordBlockedBoardingTurn(`${HIGH}:0`);
    recordBlockedBoardingTurn(`${HIGH}:0`);

    // LOW is refused now, and its outpoint sorts below HIGH's.
    markBoardingOutpointsBlocked([{ txid: LOW, vout: 0 }], "duplicated input");
    expect(getBlockedBoardingRotationState()[`${LOW}:0`].turns).toBe(2);
    expect(targetOf([coin(LOW), coin(HIGH)])).toBe(HIGH);
  });

  it("breaks ties by the oldest selection, not by outpoint", () => {
    markBoardingOutpointsBlocked([{ txid: HIGH, vout: 0 }], "duplicated input");
    markBoardingOutpointsBlocked([{ txid: LOW, vout: 0 }], "duplicated input");
    recordBlockedBoardingTurn(`${HIGH}:0`);
    recordBlockedBoardingTurn(`${LOW}:0`);
    // Equal turns: HIGH was selected first, so HIGH is the one due.
    expect(targetOf([coin(LOW), coin(HIGH)])).toBe(HIGH);

    // Alternates from there rather than letting the lower outpoint repeat.
    recordBlockedBoardingTurn(`${HIGH}:0`);
    expect(targetOf([coin(LOW), coin(HIGH)])).toBe(LOW);
    recordBlockedBoardingTurn(`${LOW}:0`);
    expect(targetOf([coin(LOW), coin(HIGH)])).toBe(HIGH);
  });

  it("ignores turn and attempt records for outpoints that are not blocked", () => {
    recordBlockedBoardingTurn(`${LOW}:0`);
    recordBlockedBoardingAttempt(`${LOW}:0`);
    expect(getBlockedBoardingRotationState()).toEqual({});
  });

  it("keeps a single blocked coin reachable", () => {
    markBoardingOutpointsBlocked([{ txid: LOW, vout: 0 }], "duplicated input");
    recordBlockedBoardingTurn(`${LOW}:0`);
    expect(targetOf([coin(LOW)])).toBe(LOW);
  });

  it("all-blocked candidates are a single coin, and it rotates", () => {
    for (const txid of [LOW, HIGH, THIRD]) {
      markBoardingOutpointsBlocked([{ txid, vout: 0 }], "duplicated input");
    }
    const coins = [coin(LOW), coin(HIGH), coin(THIRD)];
    const first = partitionBlockedBoardingCandidates(coins, (c) => c.key());
    expect(first.candidates.map((c) => c.txid)).toEqual([LOW]);

    recordBlockedBoardingTurn(`${LOW}:0`);
    const second = partitionBlockedBoardingCandidates(coins, (c) => c.key());
    expect(second.candidates.map((c) => c.txid)).toEqual([HIGH]);

    recordBlockedBoardingTurn(`${HIGH}:0`);
    const third = partitionBlockedBoardingCandidates(coins, (c) => c.key());
    expect(third.candidates.map((c) => c.txid)).toEqual([THIRD]);
  });

  it("forgets the rotation count once that coin sweeps", () => {
    markBoardingOutpointsBlocked([{ txid: LOW, vout: 0 }], "duplicated input");
    markBoardingOutpointsBlocked([{ txid: HIGH, vout: 0 }], "duplicated input");
    recordBlockedBoardingTurn(`${LOW}:0`);
    recordBlockedBoardingTurn(`${HIGH}:0`);

    clearBoardingOutpointsBlocked([`${LOW}:0`]);
    // Its count went with the block, and on re-blocking it counts as just
    // selected, so the coin that was already waiting is the one due next.
    markBoardingOutpointsBlocked([{ txid: LOW, vout: 0 }], "duplicated input");
    expect(getBlockedBoardingRotationState()[`${LOW}:0`].turns).toBe(1);
    expect(targetOf([coin(LOW), coin(HIGH)])).toBe(HIGH);
  });

  it("records each outpoint once and ignores malformed refs", () => {
    const recorded = markBoardingOutpointsBlocked(
      [
        { txid: LOW, vout: 0 },
        { txid: LOW, vout: 0 },
        { txid: "not-a-txid", vout: 0 },
      ],
      "duplicated input",
    );
    expect(recorded).toEqual([`${LOW}:0`]);
  });
});
