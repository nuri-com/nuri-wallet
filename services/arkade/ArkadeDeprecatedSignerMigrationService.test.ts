import { describe, expect, it } from "vitest";
import {
  type DeprecatedSignerEntry,
  isPastCutoff,
  parseDeprecatedSigners,
} from "./internal/deprecatedSignerCutoff";

// #852: after a deprecated arkade signer's advertised cutoff passes, arkd
// rejects cooperative spends (INVALID_VTXO_SCRIPT). The cutoff gate below is the
// single decision that keeps an EXPIRED signer out of the cooperative sweep
// (sendSelectedVtxosToSelf) while a pre-cutoff / no-cutoff (DUE_NOW) signer still
// migrates. These are the exact fixtures the live node advertises at
// https://arkade.computer/v1/info.

// Real x-only (64-hex) signer + cutoff from the live /info payload.
const EXPIRED_PUBKEY = "022b74c2011af089c849383ee527c72325de52df6a788428b68d49e9174053aaba";
const EXPIRED_CUTOFF_SEC = 1783159200; // 2026-07-04T10:00:00Z
// A second, valid compressed (66-hex, 03-prefix) signer for mixed-signer cases.
const OTHER_PUBKEY = "038202bebddeb1f7442803897a85eaf3ce9254d07df0172fc3725ab5f0d097779c";

describe("parseDeprecatedSigners (#852)", () => {
  it("parses the live /info shape into pubkey + numeric cutoff", () => {
    const out = parseDeprecatedSigners({
      deprecatedSigners: [{ pubkey: EXPIRED_PUBKEY, cutoffDate: String(EXPIRED_CUTOFF_SEC) }],
    });
    expect(out).toEqual([{ pubkeyHex: EXPIRED_PUBKEY, cutoffSec: EXPIRED_CUTOFF_SEC }]);
  });

  it("treats an absent cutoff as no deadline (DUE_NOW → still migratable)", () => {
    const out = parseDeprecatedSigners({ deprecatedSigners: [{ pubkey: EXPIRED_PUBKEY }] });
    expect(out).toEqual([{ pubkeyHex: EXPIRED_PUBKEY, cutoffSec: null }]);
  });

  it("maps a 0 cutoff to null (arkd/SDK classify 0 as DUE_NOW, not expired)", () => {
    const out = parseDeprecatedSigners({
      deprecatedSigners: [{ pubkey: EXPIRED_PUBKEY, cutoffDate: "0" }],
    });
    expect(out[0]?.cutoffSec).toBeNull();
  });

  it("normalizes a 0x-prefixed, upper-case pubkey", () => {
    const out = parseDeprecatedSigners({
      deprecatedSigners: [{ pubkey: `0x${EXPIRED_PUBKEY.toUpperCase()}`, cutoffDate: "1" }],
    });
    expect(out).toEqual([{ pubkeyHex: EXPIRED_PUBKEY, cutoffSec: 1 }]);
  });

  it("skips malformed pubkeys without aborting the rest", () => {
    const out = parseDeprecatedSigners({
      deprecatedSigners: [
        { pubkey: "not-a-key" },
        { pubkey: "" },
        { pubkey: EXPIRED_PUBKEY, cutoffDate: String(EXPIRED_CUTOFF_SEC) },
      ],
    });
    expect(out).toEqual([{ pubkeyHex: EXPIRED_PUBKEY, cutoffSec: EXPIRED_CUTOFF_SEC }]);
  });

  it("dedupes repeated signers, keeping the first", () => {
    const out = parseDeprecatedSigners({
      deprecatedSigners: [
        { pubkey: EXPIRED_PUBKEY, cutoffDate: "100" },
        { pubkey: EXPIRED_PUBKEY, cutoffDate: "200" },
      ],
    });
    expect(out).toEqual([{ pubkeyHex: EXPIRED_PUBKEY, cutoffSec: 100 }]);
  });

  it("maps a non-numeric cutoff to null rather than NaN", () => {
    const out = parseDeprecatedSigners({
      deprecatedSigners: [{ pubkey: EXPIRED_PUBKEY, cutoffDate: "soon" }],
    });
    expect(out[0]?.cutoffSec).toBeNull();
  });

  it("returns [] for a missing or non-array field", () => {
    expect(parseDeprecatedSigners({})).toEqual([]);
    expect(parseDeprecatedSigners({ deprecatedSigners: "nope" })).toEqual([]);
  });
});

describe("isPastCutoff (#852)", () => {
  const withCutoff = (cutoffSec: number | null): DeprecatedSignerEntry => ({
    pubkeyHex: EXPIRED_PUBKEY,
    cutoffSec,
  });

  it("is never past cutoff when no deadline is advertised (DUE_NOW)", () => {
    expect(isPastCutoff(withCutoff(null), EXPIRED_CUTOFF_SEC + 1_000_000)).toBe(false);
  });

  it("is not past cutoff one second before the deadline (still migratable)", () => {
    expect(isPastCutoff(withCutoff(EXPIRED_CUTOFF_SEC), EXPIRED_CUTOFF_SEC - 1)).toBe(false);
  });

  it("is past cutoff exactly at the deadline (boundary is inclusive → EXPIRED)", () => {
    expect(isPastCutoff(withCutoff(EXPIRED_CUTOFF_SEC), EXPIRED_CUTOFF_SEC)).toBe(true);
  });

  it("is past cutoff after the deadline", () => {
    expect(isPastCutoff(withCutoff(EXPIRED_CUTOFF_SEC), EXPIRED_CUTOFF_SEC + 1)).toBe(true);
  });
});

// The cooperative sweep loop runs `if (isPastCutoff(entry)) continue;` before
// sendSelectedVtxosToSelf, and the auto-recover gate sums only signers where
// isPastCutoff is false. This is the same predicate both call sites use, so
// asserting the partition proves an EXPIRED signer can never reach the
// cooperative self-send while a pre-cutoff / no-cutoff signer still can.
describe("cutoff gate partitions signers for the cooperative sweep (#852)", () => {
  it("routes only non-expired signers to the cooperative path in a mixed set", () => {
    const now = EXPIRED_CUTOFF_SEC + 3600; // one hour past the expired signer's cutoff
    const entries = parseDeprecatedSigners({
      deprecatedSigners: [
        { pubkey: EXPIRED_PUBKEY, cutoffDate: String(EXPIRED_CUTOFF_SEC) }, // expired
        { pubkey: OTHER_PUBKEY, cutoffDate: String(now + 86_400) }, // pre-cutoff (tomorrow)
      ],
    });

    const migratable = entries.filter((e) => !isPastCutoff(e, now)).map((e) => e.pubkeyHex);
    const skipped = entries.filter((e) => isPastCutoff(e, now)).map((e) => e.pubkeyHex);

    expect(skipped).toEqual([EXPIRED_PUBKEY]);
    expect(migratable).toEqual([OTHER_PUBKEY]);
  });

  it("keeps a no-cutoff (DUE_NOW) signer on the cooperative path", () => {
    const now = EXPIRED_CUTOFF_SEC + 3600;
    const entries = parseDeprecatedSigners({
      deprecatedSigners: [{ pubkey: OTHER_PUBKEY }], // no cutoffDate → DUE_NOW
    });
    expect(entries.every((e) => !isPastCutoff(e, now))).toBe(true);
  });
});
