// The producer of `wallet:transferSettled`.
//
// A plain wallet send announces its pending row only when the send itself gave
// up waiting for the receipt — and then NOTHING announced the end of it: no
// module in the app emitted `wallet:transferSettled`, so the tx mined seconds
// later and the row stayed on the rail until the 24h prune. Every listener for
// that event already exists (the pending store drops the row, the balance
// stores re-read, the home takes an optimistic move back); only the producer
// was missing.
//
// It watches ONLY the rows the wallet itself broadcast. A swap or a top-up row
// is cleared by its own tracker when that order ends, and a mined deposit is
// not the end of a swap.

import type { PendingWalletTransfer } from "../../types/wallet";
import { createForegroundPoller, type ForegroundPoller } from "../app/ForegroundPoller";
import { getBaseTransactionOutcome } from "../base/BaseTokenTransferService";
import { EventBus } from "../events/AppEventBusService";
import { getNetworkStatus } from "../app/NetworkStatusService";
import { PendingWalletTransfersStore } from "./PendingWalletTransfersStore";

// A Base block is ~2s, but a row only exists here once the send's own receipt
// wait has already timed out — this is the tail case, not the common path.
const POLL_INTERVAL_MS = 10_000;

type BroadcastRow = PendingWalletTransfer & { txHash: string };

const isBroadcastBySend = (row: PendingWalletTransfer): row is BroadcastRow =>
  row.source === "base-mainnet" &&
  !row.orderId &&
  typeof row.txHash === "string" &&
  row.txHash.trim().startsWith("0x");

// One scan at a time. A scan reads its rows serially and every read may sit on
// the transport timeout, so a slow RPC makes it outlast the interval — and the
// poller does not await its tick. Without this, a second scan starts on top of
// the first and asks for the same receipts again.
let scanning = false;

async function checkOnce(): Promise<void> {
  if (scanning) return;
  scanning = true;
  try {
    await scanBroadcastRows();
  } finally {
    scanning = false;
  }
}

async function scanBroadcastRows(): Promise<void> {
  let rows: BroadcastRow[];
  try {
    rows = (await PendingWalletTransfersStore.list()).filter(isBroadcastBySend);
  } catch {
    return;
  }
  for (const row of rows) {
    const hash = row.txHash.trim() as `0x${string}`;
    let outcome: "pending" | "success" | "reverted";
    try {
      outcome = await getBaseTransactionOutcome(hash);
    } catch {
      continue;
    }
    // No receipt yet, or an RPC that could not answer: neither is a verdict.
    if (outcome === "pending") continue;
    // The event rather than a direct removal — a reverted transfer also has an
    // optimistic debit to take back, and that listener lives elsewhere.
    try {
      EventBus.emit("wallet:transferSettled", { txHash: hash, reverted: outcome === "reverted" });
    } catch {}
  }
}

let poller: ForegroundPoller | null = null;

/** Idempotent — a second call while running is a no-op. */
export function startPendingTransferSettleWatcher(): void {
  poller =
    poller ??
    createForegroundPoller({
      intervalMs: POLL_INTERVAL_MS,
      tick: () => {
        void checkOnce();
      },
      canTick: () => !getNetworkStatus().isWaitingForNetwork,
    });
  poller.start();
  // A row inherited from a previous session is usually mined already, so it is
  // answered now rather than an interval from now.
  void checkOnce();
}

export function stopPendingTransferSettleWatcher(): void {
  poller?.stop();
}
