// Takes every in-flight record off the board the moment it is done.
//
// Each record knows how it is done from its kind (inFlightDoneRule); this is
// the one place that asks. Producers may also finish their own record early
// (the swap tracker does on a terminal status) — both are idempotent — but no
// row depends on its producer remembering to: a record whose action finished
// while the app was closed, or whose producer crashed, is still answered here
// on the next pass.
import { getBaseTransactionOutcome } from "../base/BaseTokenTransferService";
import { PendingBitcoinSendsStore } from "../bitcoin/PendingBitcoinSendsStore";
import { PendingPurchasesStore } from "../app/PendingPurchasesStore";
import { SwapKitV2OrderStore } from "../swapkit/SwapKitV2OrderStore";
import { SWAPKIT_V2_TERMINAL_STATUSES } from "../swapkit/SwapKitV2Service";
import { wirexService } from "../wirex/WirexService";
import { EventBus } from "../events/AppEventBusService";
import { createForegroundPoller, type ForegroundPoller } from "../app/ForegroundPoller";
import { getNetworkStatus } from "../app/NetworkStatusService";
import { MoneyInFlightStore, inFlightDoneRule, type MoneyInFlight } from "./MoneyInFlightStore";
import { adoptLegacyInFlight } from "./legacyInFlight";
import { isTerminalMovePhase, subscribeV2Moves } from "../swapkit/SwapKitV2MoveStatus";

const POLL_INTERVAL_MS = 8_000;

/**
 * A record is never judged "done because its backing entry is missing" in the
 * instant it was written: the producer may still be writing that entry. This
 * is not a timeout on the row — a record older than this that IS still backed
 * stays for as long as its action runs.
 */
const SETTLE_GRACE_MS = 30_000;

const SEPA_UNLISTED_MAX_MS = 7 * 24 * 60 * 60_000;
const ageMs = (record: MoneyInFlight): number => {
  const at = Date.parse(record.createdAt);
  return Number.isFinite(at) ? Date.now() - at : 0;
};

const young = (record: MoneyInFlight): boolean => {
  const at = Date.parse(record.createdAt);
  return Number.isFinite(at) && Date.now() - at < SETTLE_GRACE_MS;
};

/** True when the record's action is finished. Null when it cannot tell yet. */
export async function isInFlightDone(record: MoneyInFlight): Promise<boolean | null> {
  const rule = inFlightDoneRule(record);
  switch (rule.type) {
    case "order": {
      await SwapKitV2OrderStore.hydrate();
      // A provisional id belongs to a commit whose reply has not arrived. It is
      // live exactly as long as its commit intent is.
      if (rule.orderId.startsWith("pending:")) {
        const key = rule.orderId.slice("pending:".length);
        const intent = SwapKitV2OrderStore.get(`ord_pending:${key}`);
        if (intent && intent.status === "COMMITTING") return false;
        return young(record) ? null : true;
      }
      const order = SwapKitV2OrderStore.get(rule.orderId);
      if (!order) return young(record) ? null : true;
      return SWAPKIT_V2_TERMINAL_STATUSES.has(String(order.status || "").toUpperCase());
    }
    case "baseTx": {
      if (!/^0x[0-9a-fA-F]{64}$/.test(rule.hash)) return true;
      const outcome = await getBaseTransactionOutcome(rule.hash as `0x${string}`);
      return outcome !== "pending";
    }
    case "bitcoinSend": {
      // The send store's reconciler owns confirmation (arkade settled, or the
      // on-chain tx confirmed); the row lives exactly as long as its entry.
      const sends = await PendingBitcoinSendsStore.list();
      const id = rule.txid.trim().toLowerCase();
      if (sends.some((send) => String(send.txid).trim().toLowerCase() === id)) return false;
      return young(record) ? null : true;
    }
    case "purchase": {
      // The purchase store removes a purchase when its sats arrive.
      await PendingPurchasesStore.hydrate();
      if (PendingPurchasesStore.list().some((p) => p.id === rule.id)) return false;
      return young(record) ? null : true;
    }
    case "cardWithdraw": {
      const unresolved = await wirexService.hasUnresolvedWithdrawal();
      if (unresolved) return false;
      return young(record) ? null : true;
    }
    case "sepa": {
      const settled = await wirexService.isSepaTransferSettled(
        rule.transferId,
        record.createdAt,
        record.from?.amount ?? null,
      );
      // A transfer the bank feed never lists under its id or amount is not
      // left pending forever: SEPA settles within days.
      if (settled === false && ageMs(record) > SEPA_UNLISTED_MAX_MS) return true;
      return settled;
    }
  }
}

let scanning = false;

export async function checkInFlightOnce(): Promise<void> {
  if (scanning) return;
  scanning = true;
  try {
    await MoneyInFlightStore.hydrate();
    await adoptLegacyInFlight();
    for (const record of MoneyInFlightStore.list()) {
      let done: boolean | null = null;
      try {
        done = await isInFlightDone(record);
      } catch {
        // An answer that could not be had is not a verdict.
        done = null;
      }
      if (done === true) await MoneyInFlightStore.finish(record.id);
    }
  } finally {
    scanning = false;
  }
}

let poller: ForegroundPoller | null = null;
let offChanged: (() => void) | null = null;
let offMoves: (() => void) | null = null;
const retiredByMove = new Set<string>();

/**
 * "Completed" (or failed/refunded) on the pill IS done: the rows of that move
 * go the same instant, never a poll later.
 */
export function retireRowsOfFinishedMoves(
  moves: ReadonlyArray<{ orderId: string; phase: string; inFlightId?: string }>,
): void {
  for (const move of moves) {
    if (!isTerminalMovePhase(move.phase as never)) continue;
    for (const id of [move.orderId, move.inFlightId]) {
      if (!id || retiredByMove.has(id)) continue;
      retiredByMove.add(id);
      void MoneyInFlightStore.finish(id).catch(() => {});
    }
  }
}

/** Idempotent. */
export function startInFlightDoneWatcher(): void {
  poller =
    poller ??
    createForegroundPoller({
      intervalMs: POLL_INTERVAL_MS,
      tick: () => {
        void checkInFlightOnce();
      },
      canTick: () => !getNetworkStatus().isWaitingForNetwork,
    });
  poller.start();
  // A finished order, a removed send or purchase is answered at once rather
  // than an interval later.
  offChanged =
    offChanged ??
    (() => {
      const offs = [
        EventBus.on("bitcoin:pendingSendsChanged", () => void checkInFlightOnce()),
        EventBus.on("bitcoin:pendingPurchasesChanged", () => void checkInFlightOnce()),
      ];
      return () => {
        for (const off of offs) {
          try {
            off();
          } catch {}
        }
      };
    })();
  offMoves = offMoves ?? subscribeV2Moves((moves) => retireRowsOfFinishedMoves(moves));
  void checkInFlightOnce();
}

export function stopInFlightDoneWatcher(): void {
  poller?.stop();
  offChanged?.();
  offChanged = null;
  offMoves?.();
  offMoves = null;
  retiredByMove.clear();
}
