// Follows handed-off Mercuryo purchases to their terminal state without a sheet
// on screen. Checkout runs in the OS browser, so the app cannot observe it —
// the provider's status endpoint is the only signal, and polling it must
// therefore outlive the modal, the tab, and the app process itself.
import { reportErrorToSupport } from "../../lib/support/reportErrorToSupport";
import { startIncomingInFlight } from "../money/announce";
import {
  isMercuryoCancelledStatus,
  isMercuryoFailedStatus,
  isMercuryoPaidStatus,
  mercuryoFlowLog,
  normalizeMercuryoStatus,
} from "../../lib/mercuryo/helpers";
import { shortValue } from "../../lib/formatting";
import { PendingPurchasesStore } from "../app/PendingPurchasesStore";
import type { MercuryoStatusSnapshot } from "../../types/mercuryo";
import { MercuryoOrderStore, type MercuryoOrder } from "./MercuryoOrderStore";
import { fetchMercuryoStatus } from "./MercuryoStatusService";

// Fast right after handoff — the user is standing in checkout and the fiat leg
// settles in seconds — then backing off, since a purchase that has not settled
// within a minute is waiting on the provider, not on us.
const FAST_POLL_MS = 1_000;
const FAST_POLL_ATTEMPTS = 60;
const SLOW_POLL_MS = 15_000;

// Mirrors the store's TTL: past it the app has nothing useful left to say about
// an unsettled purchase.
const MERCURYO_ORDER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// One loop per mtid. A second start for the same order is a no-op rather than a
// second poller: resume runs on every foreground, and the sheet may hand off
// while a loop from a previous session is already live.
const inFlight = new Set<string>();

const stop = (mtid: string) => {
  inFlight.delete(mtid);
};

/**
 * Promotes a settled order to the visible activity row.
 *
 * The row is written only here, never at handoff: an unpaid handoff is not a
 * purchase, and showing one would put a "processing" row in the list for a user
 * who opened checkout and closed it again. From here on the existing
 * reconciliation owns it — `BitcoinBalanceStore.runArkadePendingCleanup`
 * removes the row once the matching on-chain tx confirms.
 */
const finalizePaid = async (order: MercuryoOrder, snapshot: MercuryoStatusSnapshot | null) => {
  const sats = Number(snapshot?.amountSats);
  const safeSats = Number.isFinite(sats) && sats > 0 ? Math.round(sats) : order.amountSats;
  try {
    // Drop any older placeholder for the same destination: two "processing" rows
    // for one address would both be matched by the same incoming tx.
    for (const row of PendingPurchasesStore.list()) {
      const sameId = String(row?.id || "") === order.mtid;
      const sameAddress =
        String(row?.address || "")
          .trim()
          .toLowerCase() === order.address.trim().toLowerCase();
      if (sameId || !sameAddress) continue;
      await PendingPurchasesStore.remove(String(row.id || ""));
    }
    void startIncomingInFlight({
      id: order.mtid,
      rail: "onchain",
      amount: safeSats,
      unit: "sats",
      kind: "purchase",
    }).catch(() => {});
    await PendingPurchasesStore.add({
      id: order.mtid,
      createdAt: order.createdAt,
      amountFiat: order.amountFiat,
      amountSats: safeSats,
      fiat: order.fiat,
      crypto: order.crypto,
      payment: order.payment,
      source: "mercuryo",
      address: order.address,
      openUrl: order.openUrl,
    });
  } catch {}
  mercuryoFlowLog("terminal_paid", {
    mtid: shortValue(order.mtid),
    providerMtid: shortValue(snapshot?.merchantTransactionId),
    sats: safeSats,
    transactionId: shortValue(snapshot?.transactionId),
    callbackId: shortValue(snapshot?.callbackId),
    blockchainTxId: shortValue(snapshot?.blockchainTxId),
  });
  await MercuryoOrderStore.remove(order.mtid);
};

const finalizeFailed = async (
  order: MercuryoOrder,
  status: string,
  snapshot: MercuryoStatusSnapshot | null,
) => {
  const terminal = normalizeMercuryoStatus(status || snapshot?.status);
  const cancelled = isMercuryoCancelledStatus(terminal);
  mercuryoFlowLog("terminal_failed", {
    mtid: shortValue(order.mtid),
    providerMtid: shortValue(snapshot?.merchantTransactionId),
    status: terminal || (cancelled ? "cancelled" : "failed"),
    selectionReason: snapshot?.selectionReason || "",
    matchedCount: snapshot?.matchedCount,
    transactionId: shortValue(snapshot?.transactionId),
    failureReason: snapshot?.failureReason || "",
    paymentMethod: snapshot?.paymentMethod || "",
    cardCountry: snapshot?.cardCountry || "",
  });
  await MercuryoOrderStore.remove(order.mtid);
  // A cancelled purchase is the user's own doing and cost them nothing, so it
  // stays silent. A failure is not: it is reported to support rather than shown
  // as an error, which is the app's standing rule for payment failures.
  if (cancelled) return;
  void reportErrorToSupport({
    error: new Error(
      `Mercuryo purchase failed: ${terminal || "failed"}${
        snapshot?.failureReason ? ` (${snapshot.failureReason})` : ""
      }`,
    ),
    userMessage: "My purchase did not work, please help!",
    appSnapshot: { activeTab: "bitcoin", bitcoinAddress: order.address },
  });
};

const runLoop = async (order: MercuryoOrder) => {
  const { mtid } = order;
  let attempt = 0;
  mercuryoFlowLog("poll_start", { mtid: shortValue(mtid) });
  try {
    while (inFlight.has(mtid)) {
      attempt += 1;
      const snapshot = await fetchMercuryoStatus(mtid);
      if (!inFlight.has(mtid)) return;
      const status = normalizeMercuryoStatus(snapshot?.status);
      mercuryoFlowLog("poll_tick", {
        mtid: shortValue(mtid),
        attempt,
        status: status || "",
        selectionReason: snapshot?.selectionReason || "",
        matchedCount: snapshot?.matchedCount,
      });
      if (status && isMercuryoPaidStatus(status)) {
        await finalizePaid(order, snapshot);
        return;
      }
      if (status && (isMercuryoFailedStatus(status) || isMercuryoCancelledStatus(status))) {
        await finalizeFailed(order, status, snapshot);
        return;
      }
      // The TTL is the only thing that ends a loop the provider never answers
      // for — without it a silent order would poll for the life of the process.
      if (Date.now() - order.createdAt > MERCURYO_ORDER_MAX_AGE_MS) {
        mercuryoFlowLog("poll_expired", { mtid: shortValue(mtid), attempts: attempt });
        await MercuryoOrderStore.remove(mtid);
        return;
      }
      const delay = attempt <= FAST_POLL_ATTEMPTS ? FAST_POLL_MS : SLOW_POLL_MS;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  } finally {
    stop(mtid);
    mercuryoFlowLog("poll_stop", { mtid: shortValue(mtid), attempts: attempt });
  }
};

const track = (order: MercuryoOrder) => {
  if (inFlight.has(order.mtid)) return;
  inFlight.add(order.mtid);
  void runLoop(order).catch(() => stop(order.mtid));
};

/**
 * Records a purchase handed off to the browser and starts following it.
 *
 * Awaited by the caller so the write is durable before the browser takes over:
 * the app may be killed the moment it does, and an unrecorded purchase is one
 * the user would never see arrive.
 */
/**
 * Abandons every running loop. Called wherever the orders themselves are dropped
 * (logout, factory reset): clearing the store does not reach a loop already in
 * its poll, and that loop would otherwise file the previous wallet's purchase
 * into the next one's activity list.
 */
export function stopAllMercuryoTracking(): void {
  inFlight.clear();
}

export async function startMercuryoOrderTracking(order: MercuryoOrder): Promise<void> {
  await MercuryoOrderStore.add(order);
  track(order);
}

/**
 * Picks up every open order — on sign-in and on every foreground. Idempotent:
 * an order already being polled is not polled twice.
 */
export async function hydrateAndResumeMercuryoOrders(): Promise<void> {
  await MercuryoOrderStore.hydrate();
  await PendingPurchasesStore.hydrate();
  const expired = await MercuryoOrderStore.cleanup();
  for (const order of expired) {
    stop(order.mtid);
    mercuryoFlowLog("order_expired", { mtid: shortValue(order.mtid) });
  }
  for (const order of MercuryoOrderStore.list()) {
    track(order);
  }
}
