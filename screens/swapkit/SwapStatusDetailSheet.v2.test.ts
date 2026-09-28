import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("SwapKit status sheet", () => {
  it("uses only the v2 status transport", () => {
    const source = readFileSync(
      new URL("./SwapStatusDetailSheet.tsx", import.meta.url).pathname,
      "utf8",
    );
    expect(source).toContain('from "../../services/swapkit/SwapKitV2Service"');
    expect(source).toContain("getSwapKitV2Status");
    expect(source).not.toContain('from "../../services/swapkit/SwapKitService"');
    expect(source).not.toContain('from "../../services/swapkit/SwapKitPendingTracker"');
    expect(source).not.toContain('from "../../services/swapkit/SwapKitRecoveryService"');
  });
});

it("offers no Continue: the wallet runs every step itself, and uses the stored recovery capability", () => {
  const source = readFileSync(
    new URL("./SwapStatusDetailSheet.tsx", import.meta.url).pathname,
    "utf8",
  );
  expect(source).toContain("SwapKitV2OrderStore.get(orderId)?.recoveryKey");
  expect(source).not.toContain("recoveryContinue");
  expect(source).not.toContain("resumeSwapKitV2Order");
});

it("states the accepted quote from the wallet's own order row, not only the server view", () => {
  const source = readFileSync(
    new URL("./SwapStatusDetailSheet.tsx", import.meta.url).pathname,
    "utf8",
  );
  expect(source).toContain(
    "statusSheetAmountLine(orderId, status, (id) => SwapKitV2OrderStore.get(id))",
  );
  // The cached view goes up before the recovery key is derived.
  expect(source.indexOf("getSwapKitV2LastView(orderId);")).toBeLessThan(
    source.indexOf("await getSwapKitV2RecoveryKey()"),
  );
});
