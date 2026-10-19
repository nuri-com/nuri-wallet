// Clears bitcoin sends from PendingBitcoinSendsStore once they are no longer in
// flight, so the "Sending" row disappears on its own.
//
// This ran in the Bitcoin tab's pending hook, which meant a row only cleared
// while that tab was mounted; with the tabs gone it cleared nowhere and every
// send would have sat there until its TTL. It is a driver now, like the balance
// reads: gated on the app being in the foreground, owned by nothing on screen.
//
// Arkade sends are off-chain and never confirm on mempool, so the arkade
// transaction history is what settles them — a send is done the moment it shows
// up there. Legacy on-chain sends clear on mempool confirmation instead.

import {
  getArkadeHistoryTxidSet,
  isArkadeVirtualTxKnown,
} from "../arkade/ArkadeTransactionHistoryService";
import { blockchainService } from "./BlockchainService";
import { PendingBitcoinSendsStore } from "./PendingBitcoinSendsStore";
import { EventBus } from "../events/AppEventBusService";
import { isBtcTxid } from "../../lib/validation";
import { createForegroundPoller, type ForegroundPoller } from "../app/ForegroundPoller";
import { getNetworkStatus } from "../app/NetworkStatusService";

const RECONCILE_INTERVAL_MS = 10_000;
let poller: ForegroundPoller | null = null;
let unsubscribe: (() => void) | null = null;
let inFlight = false;

export async function reconcilePendingSendsOnce(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await PendingBitcoinSendsStore.prune();
    const list = await PendingBitcoinSendsStore.list();
    if (list.length === 0) return;
    // Settled rows only: an arkade send shows up in the history the moment it is
    // made, still in flight, so clearing on mere presence would take the
    // "Sending" row away in the same breath it appeared.
    const arkadeTxids = await getArkadeHistoryTxidSet({ settledOnly: true });
    const markers = list.filter((entry) => entry.reconciliationRequired === true);
    // A signed send that the wallet history or the Ark indexer knows was
    // submitted: it becomes an ordinary pending row. Nothing else resolves a
    // marker: not knowing a txid is no proof it was never submitted (an older
    // submit can be stranded unfinalized), so the uncertainty stays.
    if (markers.length > 0) {
      const known = await getArkadeHistoryTxidSet();
      for (const marker of markers) {
        const inHistory = known.has(String(marker.txid || "").toLowerCase());
        if (inHistory || (await isArkadeVirtualTxKnown(marker.txid)) === true) {
          await PendingBitcoinSendsStore.markKnown(marker.txid).catch(() => {});
        }
      }
    }
    await Promise.all(
      list.map(async (entry) => {
        const txid = String(entry?.txid || "").trim();
        if (!txid) return;
        if (arkadeTxids.has(txid.toLowerCase())) {
          try {
            await PendingBitcoinSendsStore.remove(txid);
          } catch {}
          return;
        }
        // A marker is resolved above, never by TTL or mempool.
        if (entry.reconciliationRequired) return;
        // A local placeholder carries no real txid: only its TTL clears it.
        if (entry?.local || !isBtcTxid(txid)) return;
        try {
          const status = await blockchainService.getTransactionStatus(txid);
          if (status?.confirmed) await PendingBitcoinSendsStore.remove(txid);
        } catch {}
      }),
    );
  } catch {
  } finally {
    inFlight = false;
  }
}

/** Idempotent — a second call while running is a no-op. */
export function startPendingSendsReconciler(): void {
  if (poller) return;
  unsubscribe = EventBus.on("bitcoin:pendingSendsChanged", () => {
    void reconcilePendingSendsOnce();
  });
  poller = createForegroundPoller({
    intervalMs: RECONCILE_INTERVAL_MS,
    canTick: () => !getNetworkStatus().isWaitingForNetwork,
    tick: () => {
      void reconcilePendingSendsOnce();
    },
  });
  poller.start();
  void reconcilePendingSendsOnce();
}

export function stopPendingSendsReconciler(): void {
  poller?.stop();
  poller = null;
  try {
    unsubscribe?.();
  } catch {}
  unsubscribe = null;
}
