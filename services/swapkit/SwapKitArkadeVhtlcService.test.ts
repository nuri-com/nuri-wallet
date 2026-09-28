import { secp256k1 } from "@noble/curves/secp256k1";
import { VHTLC } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { describe, expect, it } from "vitest";
import { vhtlcScriptClass } from "./vhtlcScriptVersion";
import {
  isVhtlcNotDueYetError,
  isVhtlcRefundable,
  vhtlcSecondsUntilRefundable,
} from "./vhtlcRefundTiming";

/**
 * The timelock gate on the Arkade VHTLC refund path.
 *
 * Before a VHTLC's absolute refundLocktime the refundWithoutReceiver leaf is
 * unspendable by consensus, so the swap loop must treat "not due yet" as a
 * skip, not a failure — otherwise it logs an error every poll for hours (the
 * 2026-07-18 incident: two stranded swaps, ~8,600 error lines overnight).
 *
 * The adapter module itself cannot be imported here — it reaches secure
 * storage and the wallet — so the parts that must be provable in a test live
 * beside the SDK in their own modules: the timing gate in vhtlcRefundTiming,
 * the script-version choice in vhtlcScriptVersion. Against the real parameters
 * of both stranded swaps, scripts/vhtlc-refund-check.mjs runs the full
 * reconstruction.
 */
describe("vhtlcScriptClass", () => {
  // Deterministic stand-ins for the three participants. They have to be real
  // x-only keys — the taproot tree is built at construction, so an off-curve
  // byte string never reaches the address comparison this test is about.
  const xOnlyKey = (seed: string) =>
    secp256k1.getPublicKey(hex.decode(seed.repeat(32)), true).slice(1);
  const options = {
    sender: xOnlyKey("11"),
    receiver: xOnlyKey("22"),
    server: xOnlyKey("33"),
    preimageHash: hex.decode("44".repeat(20)),
    refundLocktime: 1784471181n,
    unilateralClaimDelay: { type: "blocks" as const, value: 100n },
    unilateralRefundDelay: { type: "blocks" as const, value: 102n },
    unilateralRefundWithoutReceiverDelay: { type: "blocks" as const, value: 103n },
  };
  const HRP = "ark";
  const addressOf = (Script: typeof VHTLC.Script | typeof VHTLC.ScriptV2) =>
    new Script(options).address(HRP, options.server).encode();

  it("builds the strict script for version 1 and the original for 0", () => {
    expect(vhtlcScriptClass(1)).toBe(VHTLC.ScriptV2);
    expect(vhtlcScriptClass(0)).toBe(VHTLC.Script);
  });

  it("treats a descriptor without the field as an original-script order", () => {
    expect(vhtlcScriptClass(undefined)).toBe(VHTLC.Script);
  });

  it("refuses a version it cannot build instead of guessing one", () => {
    expect(() => vhtlcScriptClass(2)).toThrow(/scriptVersion/);
    expect(() => vhtlcScriptClass("strict")).toThrow(/scriptVersion/);
  });

  // Why the version has to travel with the order at all: the same participants
  // produce two different addresses. Rebuilding a strict lockup with the
  // original script does not just claim wrongly — it fails the address check in
  // reconstructVhtlc, which is what leaves a funded lockup unopenable.
  it("gives the same participants a different address per version", () => {
    expect(addressOf(VHTLC.ScriptV2)).not.toBe(addressOf(VHTLC.Script));
  });

  it("reconstructs a strict descriptor's address, where the original script cannot", () => {
    const funded = addressOf(VHTLC.ScriptV2); // what the provider would report
    expect(addressOf(vhtlcScriptClass(1))).toBe(funded);
    expect(addressOf(vhtlcScriptClass(0))).not.toBe(funded);
  });

  it("offers both spend paths the wallet needs on the strict script", () => {
    const strict = new (vhtlcScriptClass(1))(options);
    expect(strict.claim()).toBeTruthy();
    expect(strict.refund()).toBeTruthy();
  });
});

describe("isVhtlcRefundable", () => {
  const locktime = 1784471181; // sk_9db090f4's real refund locktime

  it("is false one second before the locktime", () => {
    expect(isVhtlcRefundable({ refundLocktime: locktime }, locktime - 1)).toBe(false);
  });

  it("is true at and after the locktime", () => {
    expect(isVhtlcRefundable({ refundLocktime: locktime }, locktime)).toBe(true);
    expect(isVhtlcRefundable({ refundLocktime: locktime }, locktime + 1)).toBe(true);
  });

  it("is false for missing or nonsensical locktimes", () => {
    expect(isVhtlcRefundable({ refundLocktime: 0 }, locktime)).toBe(false);
    expect(isVhtlcRefundable({ refundLocktime: -1 }, locktime)).toBe(false);
    expect(isVhtlcRefundable({ refundLocktime: Number.NaN }, locktime)).toBe(false);
    expect(isVhtlcRefundable({ refundLocktime: undefined as unknown as number }, locktime)).toBe(
      false,
    );
  });
});

describe("isVhtlcNotDueYetError", () => {
  // The real rejection from the ark server on 2026-07-19: wall clock was past
  // the locktime, but the chain's block time still trailed it by ~43 minutes.
  const real = new Error("FORFEIT_CLOSURE_LOCKED (11): 1784471181 > 1784468590 (blocktime)");

  it("recognises the ark server's too-early rejection", () => {
    expect(isVhtlcNotDueYetError(real)).toBe(true);
  });

  it("does not swallow other failures", () => {
    expect(isVhtlcNotDueYetError(new Error("no spendable VTXO found"))).toBe(false);
    expect(isVhtlcNotDueYetError(new Error("VHTLC is already spent"))).toBe(false);
    expect(isVhtlcNotDueYetError(undefined)).toBe(false);
  });

  it("reports how much block time is still missing", () => {
    expect(vhtlcSecondsUntilRefundable(real)).toBe(1784471181 - 1784468590);
    expect(vhtlcSecondsUntilRefundable(new Error("no timestamps here"))).toBeNull();
  });
});
