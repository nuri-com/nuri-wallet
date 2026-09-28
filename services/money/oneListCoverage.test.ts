import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Every action that moves money writes an entry to the in-flight list, and
// every screen that shows pending rows reads only that list. A new action or
// screen that bypasses it fails here.
const read = (path: string) => readFileSync(path, "utf8");

const WRITERS: Array<[string, RegExp]> = [
  ["services/swapkit/SwapKitV2CommitFlow.ts", /startSwapInFlight\(/],
  ["services/swapkit/SwapKitV2SweepService.ts", /startSwapInFlight\(/],
  ["services/bitcoin/PendingBitcoinSendsStore.ts", /startSendInFlight\(/],
  ["services/wallet/CardTransferService.ts", /startCardTopUpInFlight\(/],
  ["screens/wallet/modals/WalletSendStablecoinModal.tsx", /startSendInFlight\(/],
  ["screens/wirex/hooks/useWirexSendFlow.ts", /startCardWithdrawInFlight\(/],
  ["screens/wirex/modals/SepaAmountConfirmationModal.tsx", /startSepaInFlight\(/],
  ["services/mercuryo/MercuryoPendingTracker.ts", /startIncomingInFlight\(/],
];

const READERS = [
  "screens/home/UnifiedHomeScreen.tsx",
  "screens/bitcoin/modals/BitcoinTransactionsModal.tsx",
  "screens/wirex/WirexCardTransactionsModal.tsx",
];

const OLD_LISTS = [
  "PendingPurchasesStore.list",
  "PendingWalletTransfersStore.list",
  "PendingBitcoinSendsStore.list",
  "subscribeV2Moves",
];

describe("one list for every pending row", () => {
  it.each(WRITERS)("%s writes its action to the list", (path, call) => {
    expect(read(path)).toMatch(call);
  });

  it.each(READERS)("%s draws pending rows from the list only", (path) => {
    const source = read(path);
    expect(source).toMatch(/useInFlightRows|inFlightRowsFor|inFlightAsWalletTransfers/);
    for (const old of OLD_LISTS) expect(source).not.toContain(old);
  });

  it("the euro and dollar history get their pending rows from the list", () => {
    expect(read("screens/home/UnifiedHomeScreen.tsx")).toMatch(
      /pendingTransfers=\{inFlightAsWalletTransfers\(/,
    );
  });

  it("the one card screen draws both pockets", () => {
    expect(read("screens/home/UnifiedHomeScreen.tsx")).toMatch(
      /key === "visa"\s*\?\s*\["visa", "visaUsd"\]/,
    );
  });

  it("the watcher that clears finished rows runs with the balance drivers", () => {
    expect(read("services/app/BalanceDriversService.ts")).toMatch(/startInFlightDoneWatcher\(\)/);
  });
});
