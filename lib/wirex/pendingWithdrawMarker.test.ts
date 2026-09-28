import { describe, expect, it } from "vitest";
import {
  isPendingWithdrawMarkerExpired,
  parsePendingWithdrawMarker,
  stampUndatedMarker,
} from "./pendingWithdrawMarker";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000_000_000;

describe("parsePendingWithdrawMarker", () => {
  it("reads a dated marker", () => {
    expect(parsePendingWithdrawMarker(JSON.stringify({ sessionId: "s1", at: 42 }))).toEqual({
      sessionId: "s1",
      at: 42,
    });
  });

  it("reports a legacy marker as undated rather than rejecting it", () => {
    expect(parsePendingWithdrawMarker(JSON.stringify({ sessionId: "s1" }))).toEqual({
      sessionId: "s1",
      at: 0,
    });
  });

  it("rejects anything without a session", () => {
    expect(parsePendingWithdrawMarker("not json")).toBeNull();
    expect(parsePendingWithdrawMarker(JSON.stringify({ at: 42 }))).toBeNull();
  });
});

describe("stampUndatedMarker", () => {
  it("dates a legacy marker so it can age out", () => {
    expect(stampUndatedMarker({ sessionId: "s1", at: 0 }, NOW)).toEqual({
      sessionId: "s1",
      at: NOW,
    });
  });

  it("leaves an already-dated marker alone", () => {
    expect(stampUndatedMarker({ sessionId: "s1", at: 42 }, NOW)).toBeNull();
  });
});

describe("isPendingWithdrawMarkerExpired", () => {
  it("never expires an undated marker — it is about to be stamped", () => {
    // The regression: a transient poll timeout used to delete this lock, so a
    // second withdrawal could start while the first was still ambiguous.
    expect(isPendingWithdrawMarkerExpired({ sessionId: "s1", at: 0 }, NOW, DAY)).toBe(false);
  });

  it("expires a marker past the max age", () => {
    expect(isPendingWithdrawMarkerExpired({ sessionId: "s1", at: NOW - DAY - 1 }, NOW, DAY)).toBe(
      true,
    );
  });

  it("keeps a marker inside the max age", () => {
    expect(isPendingWithdrawMarkerExpired({ sessionId: "s1", at: NOW - DAY + 1 }, NOW, DAY)).toBe(
      false,
    );
  });
});
