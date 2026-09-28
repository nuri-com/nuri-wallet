// Asks SwapKit, on the app's own wake-ups, whether a funded Lightning send now
// needs a signature.
//
// The corridor needs nothing from this wallet on the happy path, and the one
// action it can ask for — returning a lockup whose solver went dark — only
// exists once `refundLocktime` has matured, hours after the payment. So there
// is no timer here: the wallet-summary event the rest of the arkade layer
// already wakes on is frequent enough for a deadline measured in hours, and an
// empty answer is the normal one.
//
// Lives in the arkade layer, but the work is swapkit's: the import is dynamic
// so the swap client is not dragged into the wallet's parse-time graph.
import { checkV2LightningSends } from "../../swapkit/SwapKitV2LightningResume";
import { errMsg } from "../../../lib/errorMessage";
import { emitTrace } from "./logging";
import { truncateForLog } from "./utils";
import { getCachedArkadeWallet } from "./walletCache";
import { addArkadeWalletSummaryListener } from "./walletSummaryEvents";

let checkInFlight: Promise<void> | null = null;

export function scheduleArkadeLightningSendCheck(reason: string): void {
  if (checkInFlight) return;
  // Never build a wallet just to look: this runs off a wallet-summary event, so
  // one exists by then, and creating one here could prompt.
  if (!getCachedArkadeWallet()) return;
  const run = (async () => {
    await checkV2LightningSends(reason);
  })().catch((error: unknown) => {
    emitTrace({
      atMs: Date.now(),
      op: "ln_send_check",
      status: "failed",
      detail: `reason=${reason} err=${truncateForLog(errMsg(error, "unknown"), 170)}`,
    });
  });
  checkInFlight = run;
  void run.finally(() => {
    if (checkInFlight === run) {
      checkInFlight = null;
    }
  });
}

addArkadeWalletSummaryListener(() => {
  scheduleArkadeLightningSendCheck("wallet_summary");
});
