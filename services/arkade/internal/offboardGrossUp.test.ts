import type { FeeInfo } from "@arkade-os/sdk";
import { describe, expect, it } from "vitest";

import { grossUpOffboardSats } from "./offboardGrossUp";

// A real mainnet P2WPKH address — the gross-up has to encode its script to ask
// the estimator what the output costs.
const ADDRESS = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

describe("grossUpOffboardSats", () => {
  it("adds the offboard's output fee so the receiver gets the full amount", () => {
    // `Ramps.offboard` does `amount -= outputFee` before building the
    // destination output, so a caller that means "5000 must ARRIVE" has to
    // spend 5000 + fee. 2 sats/vbyte over the output's own weight.
    // The server states its fee as a CEL program returning a double.
    const feeInfo = { intentFee: { onchainOutput: "31.0 * 2.0" } } as unknown as FeeInfo;

    const total = grossUpOffboardSats(5000, ADDRESS, feeInfo);

    expect(total).toBeGreaterThan(5000);
    expect(total).toBe(5062);
  });

  it("returns the amount unchanged when the server charges no output fee", () => {
    const feeInfo = { intentFee: {} } as unknown as FeeInfo;
    expect(grossUpOffboardSats(5000, ADDRESS, feeInfo)).toBe(5000);
  });
});
