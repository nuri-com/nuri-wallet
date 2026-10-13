// Every piece of money in flight, in ONE place.
//
// The home board's pending strip used to be fed by three separate stores, each
// keyed differently: stablecoin transfers by CURRENCY, bitcoin sends by rail,
// bitcoin purchases by their own shape. Three sources sharing one display space
// is what made this area a stream of one-off bugs:
//
//   - a currency is not a screen. Euro is the EUR wallet, the Visa euro pocket
//     and the IBAN, so a row aimed at the card landed on the wallet or nowhere;
//   - the card rails only ever drew rows through a hand-written special case
//     for bitcoin purchases, so EUR -> card and anything -> Visa USD showed the
//     money leaving and never arriving;
//   - a bitcoin-to-bitcoin move belonged to two rails at once and the readers
//     each asked a single question about the move, so it drew nothing at all.
//
// The rule this store exists to enforce: A MOVE SHOWS ON THE SCREEN IT LEAVES
// AND THE SCREEN IT ARRIVES ON. Both ends are named here explicitly, so no
// reader has to infer a screen from a currency, and no new rail needs a new
// special case.
import { getCacheValue, setCacheValue } from "../balance/TransactionCacheService";
import { EventBus } from "../events/AppEventBusService";

/** A screen on the home board that can hold money. */
export type MoneyRail = "wallet" | "dollar" | "onchain" | "arkade" | "visa" | "visaUsd";

export const MONEY_RAILS: readonly MoneyRail[] = [
  "wallet",
  "dollar",
  "onchain",
  "arkade",
  "visa",
  "visaUsd",
];

/** What a leg's amount is counted in, so a reader formats it without guessing. */
export type MoneyUnit = "sats" | "EUR" | "USD";

export type MoneyLeg = {
  rail: MoneyRail;
  /** Positive magnitude; the direction comes from which end of the move it is. */
  amount: number;
  unit: MoneyUnit;
};

export type MoneyInFlight = {
  /** Stable identity. A swap uses its order id; a send uses its txid. */
  id: string;
  /** Where the money leaves. Null only when it arrives from outside the app
   * (a purchase), which no screen can show as a debit. */
  from: MoneyLeg | null;
  /** Where it lands. Null when it leaves the app entirely — a send to someone
   * else's address has no destination screen, and inventing one would state
   * money arriving that is in fact gone. */
  to: MoneyLeg | null;
  /**
   * What produced it. Also decides how the record knows it is DONE — see
   * inFlightDoneRule — so no producer has to remember to clear its row.
   */
  kind: MoneyInFlightKind;
  createdAt: string;
};

/**
 * Every kind of money movement the app makes. Adding one here is the ONLY way
 * a new action gets a pending row, and the compiler then forces a done rule
 * for it in inFlightDoneRule.
 */
export type MoneyInFlightKind =
  /** A SwapKit v2 order. id = orderId (or its provisional id). */
  | "swap"
  /** A bitcoin or stablecoin send, and bitcoin rail-to-rail transfers. id = txid / tx hash. */
  | "send"
  /** Bitcoin bought from outside the app (Mercuryo). id = its merchant id. */
  | "purchase"
  /** A wallet -> card pocket transfer. id = the Base tx hash. */
  | "card_topup"
  /** A card pocket -> wallet withdrawal. id = the withdrawal's move id. */
  | "card_withdraw"
  /** A SEPA transfer out of the card. id = Wirex's transfer id. */
  | "sepa"
  /** Money added from another wallet. id = `<pay record key>#<start time>`. */
  | "wallet_topup";

/**
 * How a record knows it is no longer in flight. Derived from the kind, never
 * stored, so a record written by an older build is judged the same way.
 */
export type InFlightDoneRule =
  | { type: "order"; orderId: string }
  | { type: "baseTx"; hash: string }
  | { type: "bitcoinSend"; txid: string }
  | { type: "purchase"; id: string }
  | { type: "cardWithdraw" }
  | { type: "sepa"; transferId: string }
  | { type: "payWallet"; key: string };

export function inFlightDoneRule(record: MoneyInFlight): InFlightDoneRule {
  switch (record.kind) {
    case "swap":
      return { type: "order", orderId: record.id };
    case "send":
      // A stablecoin send is a Base tx hash; everything else is a bitcoin send.
      return /^0x[0-9a-fA-F]{64}$/.test(record.id)
        ? { type: "baseTx", hash: record.id }
        : { type: "bitcoinSend", txid: record.id };
    case "card_topup":
      return { type: "baseTx", hash: record.id };
    case "purchase":
      return { type: "purchase", id: record.id };
    case "card_withdraw":
      return { type: "cardWithdraw" };
    case "sepa":
      return { type: "sepa", transferId: record.id };
    case "wallet_topup":
      return { type: "payWallet", key: record.id.split("#")[0] };
  }
}

const CACHE_KEY = "money:in-flight:v1";
const CHANGED = "money:inFlightChanged";
/**
 * How a finished move ended, announced by whoever knows it just before its
 * record is finished: `{ id, outcome: "completed" | "failed" }`. A record
 * finished without it ended in a way nobody could judge.
 */
const OUTCOME = "money:inFlightOutcome";
export type InFlightOutcomePayload = { id: string; outcome: "completed" | "failed" };

let memory: MoneyInFlight[] = [];
let loaded = false;
let loading: Promise<void> | null = null;
// Bumped by clear(): a cache read started before it belongs to the previous
// identity and must not land in memory after it.
let generation = 0;

const emitChange = () => {
  try {
    EventBus.emit(CHANGED);
  } catch {}
};

async function persist(): Promise<void> {
  try {
    await setCacheValue(CACHE_KEY, memory);
  } catch {}
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  if (!loading) {
    const started = generation;
    loading = (async () => {
      try {
        const cached = await getCacheValue<MoneyInFlight[]>(CACHE_KEY);
        if (started === generation && Array.isArray(cached)) memory = cached.filter(isRecord);
      } catch {}
      if (started === generation) loaded = true;
    })();
  }
  await loading;
}

const isLeg = (value: unknown): value is MoneyLeg => {
  const leg = value as MoneyLeg | null;
  return (
    !!leg &&
    typeof leg === "object" &&
    MONEY_RAILS.includes(leg.rail) &&
    Number.isFinite(leg.amount) &&
    leg.amount > 0
  );
};

const KINDS: ReadonlySet<string> = new Set([
  "swap",
  "send",
  "purchase",
  "card_topup",
  "card_withdraw",
  "sepa",
  "wallet_topup",
]);

const isRecord = (value: unknown): value is MoneyInFlight => {
  const row = value as MoneyInFlight | null;
  if (!row || typeof row !== "object" || !row.id) return false;
  if (!KINDS.has(String(row.kind))) return false;
  const from = row.from == null || isLeg(row.from);
  const to = row.to == null || isLeg(row.to);
  // A record with neither end names no screen and could never be drawn.
  return from && to && (row.from != null || row.to != null);
};

/**
 * Announce money in flight. Idempotent by id: a re-announced move replaces its
 * record rather than drawing a second row, so a resumed or retried commit is
 * safe to call.
 */
async function start(record: MoneyInFlight): Promise<void> {
  if (!isRecord(record)) return;
  await ensureLoaded();
  const index = memory.findIndex((row) => row.id === record.id);
  if (index >= 0) memory[index] = record;
  else memory.push(record);
  await persist();
  emitChange();
}

/**
 * The money landed, failed or was refunded — either way it is no longer in
 * flight. ONE call retires BOTH ends, which is what makes a half-cleared move
 * impossible: there are not two rows to keep in step, there is one record.
 */
async function finish(id: string): Promise<void> {
  const key = String(id || "").trim();
  if (!key) return;
  await ensureLoaded();
  const next = memory.filter((row) => row.id !== key);
  if (next.length === memory.length) return;
  memory = next;
  await persist();
  emitChange();
}

function list(): MoneyInFlight[] {
  return memory.slice();
}

/** The records one rail draws, each with the leg and direction it shows. */
export function inFlightForRail(
  records: readonly MoneyInFlight[],
  rail: MoneyRail,
): Array<{ record: MoneyInFlight; leg: MoneyLeg; direction: "out" | "in" }> {
  const rows: Array<{ record: MoneyInFlight; leg: MoneyLeg; direction: "out" | "in" }> = [];
  for (const record of records) {
    // A move between two rails of the same screen draws both ends there.
    if (record.from?.rail === rail) rows.push({ record, leg: record.from, direction: "out" });
    if (record.to?.rail === rail) rows.push({ record, leg: record.to, direction: "in" });
  }
  return rows;
}

/** Session teardown: a new identity must not inherit these. */
async function clear(): Promise<void> {
  generation += 1;
  const stale = loading;
  loading = null;
  memory = [];
  loaded = true;
  // A read already in flight resolves into nothing (its generation is gone);
  // waiting for it keeps the persisted empty list the last write.
  if (stale) await stale.catch(() => {});
  memory = [];
  loaded = true;
  await persist();
  emitChange();
}

/**
 * Adds records only where their id is not already listed. The one-time copy of
 * rows an older build left in its own lists uses this: a record the new list
 * already holds is newer and wins.
 */
async function adoptMissing(records: readonly MoneyInFlight[]): Promise<number> {
  await ensureLoaded();
  const known = new Set(memory.map((row) => row.id));
  const fresh = records.filter((record) => isRecord(record) && !known.has(record.id));
  if (fresh.length === 0) return 0;
  memory = memory.concat(fresh);
  await persist();
  emitChange();
  return fresh.length;
}

export const MoneyInFlightStore = {
  start,
  finish,
  list,
  clear,
  adoptMissing,
  hydrate: ensureLoaded,
  CHANGED,
  OUTCOME,
  /** Tests only. */
  _resetForTests(opts: { cold?: boolean } = {}): void {
    memory = [];
    loaded = !opts.cold;
    loading = null;
  },
};

/** The leg `rail` draws for this record, or null when it is not an end of it. */
export function railLeg(
  record: MoneyInFlight,
  rail: MoneyRail,
): { leg: MoneyLeg; direction: "out" | "in" } | null {
  // The paying end is checked first: when a move's two ends are the SAME rail,
  // the money leaving is what to show.
  if (record.from?.rail === rail) return { leg: record.from, direction: "out" };
  if (record.to?.rail === rail) return { leg: record.to, direction: "in" };
  return null;
}
