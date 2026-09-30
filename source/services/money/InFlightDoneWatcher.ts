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

/**
 * How a finished in-flight action ended, announced as it leaves the board
 * (MoneyInFlightStore.OUTCOME), so a pill or a held follow-up (an address-book
 * save) can tell success from failure. "unknown" when the rule only knows it
 * is over; nothing is announced then.
 */
export type InFlightOutcome = "completed" | "failed" | "unknown";

/** True when the record's action is finished. Null when it cannot tell yet. */
export async function isInFlightDone(record: MoneyInFlight): Promise<boolean | null> {
  return (await judgeInFlight(record)).done;
}

/** Whether the record's action is finished, and how it ended when it is. */
export async function judgeInFlight(
  record: MoneyInFlight,
): Promise<{ done: boolean | null; outcome: InFlightOutcome }> {
  const unknown = (done: boolean | null) => ({ done, outcome: "unknown" as const });
  const rule = inFlightDoneRule(record);
  switch (rule.type) {
    case "order": {
      await SwapKitV2OrderStore.hydrate();
      // A provisional id belongs to a commit whose reply has not arrived. It is
      // live exactly as long as its commit intent is.
      if (rule.orderId.startsWith("pending:")) {
        const key = rule.orderId.slice("pending:".length);
        const intent = SwapKitV2OrderStore.get(`ord_pending:${key}`);
        if (intent && intent.status === "COMMITTING") return unknown(false);
        return unknown(young(record) ? null : true);
      }
      const order = SwapKitV2OrderStore.get(rule.orderId);
      if (!order) return unknown(young(record) ? null : true);
      const status = String(order.status || "").toUpperCase();
      if (!SWAPKIT_V2_TERMINAL_STATUSES.has(status)) return unknown(false);
      return { done: true, outcome: status === "COMPLETED" ? "completed" : "failed" };
    }
    case "baseTx": {
      if (!/^0x[0-9a-fA-F]{64}$/.test(rule.hash)) return unknown(true);
      const outcome = await getBaseTransactionOutcome(rule.hash as `0x${string}`);
      if (outcome === "pending") return unknown(false);
      return { done: true, outcome: outcome === "success" ? "completed" : "failed" };
    }
    case "bitcoinSend": {
      // The send store's reconciler owns confirmation (arkade settled, or the
      // on-chain tx confirmed); the row lives exactly as long as its entry.
      const sends = await PendingBitcoinSendsStore.list();
      const id = rule.txid.trim().toLowerCase();
      if (sends.some((send) => String(send.txid).trim().toLowerCase() === id))
        return unknown(false);
      return unknown(young(record) ? null : true);
    }
    case "purchase": {
      // The purchase store removes a purchase when its sats arrive.
      await PendingPurchasesStore.hydrate();
      if (PendingPurchasesStore.list().some((p) => p.id === rule.id)) return unknown(false);
      return unknown(young(record) ? null : true);
    }
    case "cardWithdraw": {
      const unresolved = await wirexService.hasUnresolvedWithdrawal();
      if (unresolved) return unknown(false);
      return unknown(young(record) ? null : true);
    }
    case "sepa": {
      const status = await wirexService.sepaTransferStatus(
        rule.transferId,
        record.createdAt,
        record.from?.amount ?? null,
      );
      if (status === null) return unknown(null);
      if (status === "Pending") return unknown(false);
      // A transfer the bank feed never lists under its id or amount is not
      // left pending forever: SEPA settles within days.
      if (status === "unlisted") return unknown(ageMs(record) > SEPA_UNLISTED_MAX_MS);
      return { done: true, outcome: status === "Completed" ? "completed" : "failed" };
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
      let verdict: { done: boolean | null; outcome: InFlightOutcome } = {
        done: null,
        outcome: "unknown",
      };
      try {
        verdict = await judgeInFlight(record);
      } catch {
        // An answer that could not be had is not a verdict.
      }
      if (verdict.done !== true) continue;
      // How it ended goes out before the row does, so anything waiting on the
      // outcome hears it no later than the row leaving.
      if (verdict.outcome !== "unknown") {
        try {
          EventBus.emit(MoneyInFlightStore.OUTCOME, { id: record.id, outcome: verdict.outcome });
        } catch {}
      }
      await MoneyInFlightStore.finish(record.id);
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
