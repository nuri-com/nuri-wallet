import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("SwapKit v2 app entrypoint", () => {
  it("does not start the v1 tracker or mount its recovery host", () => {
    const app = readFileSync(new URL("../../App.tsx", import.meta.url).pathname, "utf8");
    expect(app).not.toContain('from "./services/swapkit/SwapKitPendingTracker"');
    expect(app).not.toContain("hydrateAndResumeSwapKitOrders");
    expect(app).not.toContain("SwapKitWalletOpenRecoveryHost");
  });
});

it("active Lightning, Pay and transaction UI paths do not invoke v1", () => {
  const paths = [
    "../arkade/ArkadeLightningSendService.ts",
    "../pay/PayTargetService.ts",
    "../../screens/bitcoin/modals/BitcoinTransactionsModal.tsx",
    "../../screens/wallet/modals/WalletTransactionsModal.tsx",
    "../../screens/wirex/WirexCardTransactionsModal.tsx",
  ];
  for (const path of paths) {
    const source = readFileSync(new URL(path, import.meta.url).pathname, "utf8");
    expect(source, path).not.toMatch(
      /from ["'][^"']*\/(?:SwapKitService|SwapKitPendingTracker|SwapKitArkadeIntentsActionService)["']/,
    );
  }
});

it("does not resurrect modules deleted with the v1 flow services", () => {
  // These were unreachable from any screen once the v2 migration landed and
  // were removed. Listing them here keeps a later refactor from quietly
  // reintroducing a v1 path under its old name.
  const removed = [
    "../swapkit/StableToBtcSwapService.ts",
    "../swapkit/SwapKitCardTopupService.ts",
    "../swapkit/SwapKitStableSwapService.ts",
    "../swapkit/SwapKitArkadeIntentsStableService.ts",
    "../arkade/ArkadeIntentsStableSwapService.ts",
    "../arkade/internal/intentsLockupFunding.ts",
  ];
  for (const path of removed) {
    expect(existsSync(new URL(path, import.meta.url).pathname), path).toBe(false);
  }
});
