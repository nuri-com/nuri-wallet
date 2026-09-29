// What a finished v2 move does to the numbers on screen.
//
// The sheet closes when the user accepts the quote, so by the time an order is
// COMPLETED nobody is watching a screen that could refetch. The tracker emits a
// refresh at terminal, but a refetch is an indexer read: for several seconds it
// still answers with the pre-swap figures, and the user sees a move that
// "finished" without either balance changing. That gap is what this closes —
// the terminal event applies the exact two legs of the move against the
// existing keyed anchor primitives, and the refetch settles them when it
// catches up.
//
// Rules this file exists to keep:
//   - both legs are named exactly (asset + rail), never inferred: USDC and EURC
//     are separate stores, and BTC on-chain is not BTC Arkade;
//   - a leg is applied ONLY when the LEDGER has moved on its own, which is not
//     the same as "the number changed" — this module's own earlier legs are
//     subtracted out, or two concurrent moves from one rail would each read the
//     other's debit as the ledger and skip their own;
//   - a non-COMPLETED terminal reverts exactly this order's legs and nothing
//     else, keyed by orderId.
import { usdcBalanceStore } from "../balance/UsdcBalanceStore";
import { walletBalanceStore } from "../balance/WalletBalanceStore";
import { bitcoinBalanceStore } from "../bitcoin/BitcoinBalanceStore";
import { SatsReservationsStore } from "../bitcoin/SatsReservationsStore";
import { EventBus } from "../events/AppEventBusService";
import type { SwapKitV2StoredOrder } from "./SwapKitV2OrderStore";

/** The app-side balance a v2 asset id belongs to. Null for a rail this file
 * does not anchor (Bitcoin, the card) — those settle from their own reads. */
type BalanceRail = "eur" | "usd";

function railOf(asset: string): BalanceRail | null {
  const id = String(asset || "").toUpperCase();
  if (id === "EURC_BASE") return "eur";
  if (id === "USDC_BASE") return "usd";
  return null;
}

function displayedBalance(rail: BalanceRail): number | null {
  const value =
    rail === "eur"
      ? walletBalanceStore.getSnapshot().balanceEur
      : usdcBalanceStore.getSnapshot().balanceUsd;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Signed total this module has itself applied to each rail. A displayed figure
 * that moved by exactly this much has not moved on its own, so it is not
 * evidence that the ledger published anything — without it, two concurrent
 * moves out of one rail each mistake the other's debit for the ledger and skip
 * their own leg, and the user is shown one of the two moves. */
const appliedByRail: Record<BalanceRail, number> = { eur: 0, usd: 0 };

/** The figures a move started from, captured at the commit handoff. Without the
 * baseline there is no way to tell a balance that still shows the pre-swap
 * amount from one the ledger has already updated, and applying a leg to the
 * latter double-counts it. Session-scoped: after a restart the authoritative
 * read is the only truth, and no optimistic leg is applied. */
type MoveLeg = {
  rail: BalanceRail;
  /** Displayed balance when the move was handed off. */
  balanceAtCommit: number | null;
  /** `appliedByRail[rail]` at that same moment, so a later comparison can tell
   * this module's own deltas apart from the ledger's. */
  appliedAtCommit: number;
};

type MoveBaseline = {
  from: string;
  to: string;
  sendAmount: number;
  receiveAmount: number;
  source: MoveLeg | null;
  destination: MoveLeg | null;
};

const baselines = new Map<string, MoveBaseline>();
/** Terminal is processed exactly once per order, however many times the tracker
 * reports it (duplicate callback, foreground resume, a late poll). */
const settled = new Set<string>();

const amount = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function captureLeg(rail: BalanceRail | null): MoveLeg | null {
  if (!rail) return null;
  return {
    rail,
    balanceAtCommit: displayedBalance(rail),
    appliedAtCommit: appliedByRail[rail],
  };
}

/**
 * Has the LEDGER already published this leg on its own?
 *
 * The comparison is against what the balance would read if nothing but this
 * module had touched it since the handoff — baseline plus our own deltas since.
 * Half the leg is the tolerance: a partial fill or a fee still counts as
 * published, a figure that has not moved does not.
 */
function ledgerAlreadyMoved(leg: MoveLeg | null, delta: number): boolean {
  if (!leg || leg.balanceAtCommit == null) return false;
  const shown = displayedBalance(leg.rail);
  if (shown == null) return false;
  const expected = leg.balanceAtCommit + (appliedByRail[leg.rail] - leg.appliedAtCommit);
  return delta < 0 ? shown < expected + delta / 2 : shown > expected + delta / 2;
}

/**
 * Record what this move is about to do, at the moment the sheet closes.
 * Cheap and side-effect-free — it only reads the balances currently on screen.
 */
export function noteV2MoveBaseline(order: {
  orderId: string;
  from: string;
  to: string;
  sendAmount: unknown;
  receiveAmount: unknown;
}): void {
  const id = String(order.orderId || "").trim();
  if (!id || baselines.has(id)) return;
  baselines.set(id, {
    from: order.from,
    to: order.to,
    sendAmount: amount(order.sendAmount),
    receiveAmount: amount(order.receiveAmount),
    source: captureLeg(railOf(order.from)),
    destination: captureLeg(railOf(order.to)),
  });
}

function creditRail(rail: BalanceRail, value: number, moveId: string): void {
  EventBus.emit("wallet:optimisticCredit", {
    amount: value,
    // Naming the asset is mandatory: an unnamed credit lands on the euro
    // wallet, which is a balance the user cannot spend when the dollars are
    // what arrived.
    asset: rail === "eur" ? "EURC_BASE" : "USDC_BASE",
    moveId,
  });
  appliedByRail[rail] += value;
}

function debitRail(rail: BalanceRail, value: number): void {
  if (rail === "eur") walletBalanceStore.applyOptimisticDebit(value);
  else usdcBalanceStore.applyOptimisticDebit(value);
  appliedByRail[rail] -= value;
}

/**
 * Apply this order's terminal outcome to the balances it touched.
 *
 * COMPLETED: debit the sending rail and credit the receiving one, each against
 * its own store, and only where the ledger has not already published that leg.
 * Anything else: revoke the credit this order made (if any) and let the
 * authoritative refresh restore the rest.
 */
export function applyV2TerminalBalances(
  order: Pick<SwapKitV2StoredOrder, "orderId" | "from" | "to" | "destination">,
  status: string,
): void {
  const id = String(order.orderId || "").trim();
  if (!id || settled.has(id)) return;
  settled.add(id);

  const terminal = String(status || "").toUpperCase();
  const baseline = baselines.get(id) ?? null;
  baselines.delete(id);

  if (terminal !== "COMPLETED") {
    // Only this order's credit comes back. Every other outstanding move stays.
    try {
      EventBus.emit("wallet:revokeOptimisticCredit", { moveId: id });
    } catch {}
    // A Bitcoin-spending move that never completed gets its held sats back; the
    // hold is reason-keyed, and a failed move is the only thing that releases it.
    if (
      railOf(order.from) == null &&
      String(order.from || "")
        .toUpperCase()
        .startsWith("BTC")
    ) {
      bitcoinBalanceStore.revertArkadeOutgoingBalance(`v2_move_${terminal.toLowerCase()}`);
    }
    return;
  }

  // No baseline means this session never saw the move start — it was adopted by
  // a restart or a server-side reconcile. There is no way to tell a balance that
  // still shows the pre-swap figure from one the ledger already updated, so the
  // authoritative refresh is the only honest answer and nothing is applied here.
  if (!baseline) return;

  const { sendAmount, receiveAmount, source } = baseline;
  if (source && sendAmount > 0 && !ledgerAlreadyMoved(source, -sendAmount)) {
    debitRail(source.rail, sendAmount);
  }

  // The card credits through its own terminal event (DIRECT_SWAP_SETTLED_EVENT)
  // — crediting here as well would show the money twice.
  const destination = order.destination === "card" ? null : baseline.destination;
  if (destination && receiveAmount > 0 && !ledgerAlreadyMoved(destination, receiveAmount)) {
    creditRail(destination.rail, receiveAmount, id);
  }
}

/** Soft logout: the previous account's moves and their pending legs are gone. */
/**
 * Hold the sats an Arkade-funded order has committed, the instant it commits.
 *
 * The money is spoken for well before the wallet pays: the server has to create
 * the provider order and issue the funding invoice first. Leaving it spendable
 * in the meantime let a second move race the first and overdraw the wallet —
 * the internal board/offboard path has always held its amount; the swap path,
 * which is where the sats actually go, did not.
 *
 * Deliberately NOT an optimistic write of a final figure: the hold deducts the
 * committed amount and a fresh live read always wins, so Arkade change and the
 * solver's real fee correct it as soon as they are known.
 */
export async function holdV2ArkadeFunding(orderId: string, sats: number): Promise<void> {
  const amount = Math.trunc(Number(sats));
  if (!Number.isFinite(amount) || amount <= 0) return;
  // AWAITED, and a write failure propagates. The hold exists to survive a
  // crash; funding that broadcasts before it is durable is the case it cannot
  // cover, so the caller refuses to fund rather than proceeding without it.
  await SatsReservationsStore.reserve({ orderId, rail: "arkade", sats: amount });
  applyArkadeReservations(`v2_order_${orderId}`);
}

/**
 * Release the hold once the order is terminal — settled, failed or refunded.
 *
 * Correct for every outcome precisely because it releases rather than asserts:
 * a completed swap really did spend the sats, so the live read is lower; a
 * failed one never spent them, so the live read is unchanged. Either way the
 * chain is the answer and the hold stops standing in for it.
 */
export function releaseV2ArkadeFunding(orderId: string): void {
  // Releasing is the safe direction: a write that fails keeps the hold, which
  // only overstates what is committed until the next reconciliation.
  void SatsReservationsStore.release(orderId)
    .then(() => applyArkadeReservations(`v2_order_${orderId}_terminal`))
    .catch(() => {});
}

/**
 * Push the CURRENT TOTAL of every open Arkade reservation into the balance
 * store's single hold.
 *
 * The store holds one figure, which is why an order finishing used to release
 * sats another order still had committed. Re-deriving the total from the
 * reservation ledger on every change keeps that one figure correct with any
 * number of orders in flight: two open orders hold both amounts, and the last
 * one to finish clears the hold.
 */
function applyArkadeReservations(reason: string): void {
  const total = SatsReservationsStore.totalFor("arkade");
  if (total > 0) bitcoinBalanceStore.holdArkadeOutgoingBalance(reason, total);
  else bitcoinBalanceStore.clearArkadeOutgoingBalanceHold(reason);
}

/**
 * Restart safety: re-apply whatever is still reserved.
 *
 * A relaunch mid-swap came up with the committed sats spendable again, because
 * the hold lived only in memory. The ledger is persisted, so resume re-derives
 * the same total; orders that finished while the app was closed are released by
 * the tracker's own reconciliation and drop out of it.
 */
export async function restoreV2ArkadeReservations(): Promise<void> {
  await SatsReservationsStore.hydrate();
  applyArkadeReservations("v2_reservations_restored");
}

/**
 * Session teardown: drop every reservation, on disk AND in the loaded
 * singleton, and release the balance hold they fed. Deleting only the cache
 * key would leave the singleton holding the previous wallet's sats, and the
 * next wallet would restore them as its own hold.
 */
export async function clearV2ArkadeReservations(): Promise<void> {
  await SatsReservationsStore.clear();
  applyArkadeReservations("v2_reservations_cleared");
}

export function clearV2MoveAccounting(): void {
  baselines.clear();
  settled.clear();
  appliedByRail.eur = 0;
  appliedByRail.usd = 0;
}

/** Test seam. */
export const _resetV2MoveAccountingForTests = clearV2MoveAccounting;
