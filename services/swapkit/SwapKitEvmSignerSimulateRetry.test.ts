import { describe, expect, it, vi } from "vitest";

// EUR -> USD failed within a second of its approval landing: the swap call was
// simulated against a node that had not applied the approval yet, reverted,
// and the move was refused and cancelled. The simulation now waits for the
// chain to catch up; a call that is genuinely bad still fails.
vi.mock("../../lib/secureKeyStorage", () => ({ getPrivateKey: vi.fn() }));
vi.mock("../../lib/rpc/baseRpc", () => ({ getBaseViemTransport: vi.fn() }));
vi.mock("../../lib/rpc/chainRpc", () => ({ getChainRpcUrl: vi.fn() }));

import { simulateUntilStateCatchesUp } from "./SwapKitEvmSigner";

const NO_WAIT = [0, 0, 0, 0];

describe("the pre-sign simulation waits for the previous step to show", () => {
  it("passes once the approval is visible, after reverting on a lagging node", async () => {
    let calls = 0;
    const simulate = vi.fn(async () => {
      calls += 1;
      if (calls < 3)
        throw new Error("execution reverted: ERC20: transfer amount exceeds allowance");
      return 210_000n;
    });
    await expect(simulateUntilStateCatchesUp(simulate, NO_WAIT)).resolves.toBe(210_000n);
    expect(simulate).toHaveBeenCalledTimes(3);
  });

  it("still refuses a call that keeps reverting", async () => {
    const simulate = vi.fn(async () => {
      throw new Error("execution reverted");
    });
    await expect(simulateUntilStateCatchesUp(simulate, NO_WAIT)).rejects.toThrow(
      "execution reverted",
    );
    expect(simulate).toHaveBeenCalledTimes(NO_WAIT.length + 1);
  });

  it("does not retry a call that passes first time", async () => {
    const simulate = vi.fn(async () => 1n);
    await simulateUntilStateCatchesUp(simulate, NO_WAIT);
    expect(simulate).toHaveBeenCalledTimes(1);
  });
});
