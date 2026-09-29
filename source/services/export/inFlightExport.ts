// Money still in flight (MoneyInFlightStore) as export rows. One mapping for
// every rail's export, and the one rule for dropping a pending row whose
// settled counterpart the history already lists.
import type { MoneyRail } from "../money/MoneyInFlightStore";
import type { InFlightRow } from "../money/inFlightRows";
import { type ExportAccount, type TransactionExportRow, signedDecimal } from "./exportRow";

export type InFlightCsvRecord = {
  createdAt: string;
  /** `<kind>_pending`, e.g. `swap_pending`, `send_pending`. */
  category: string;
  direction: "incoming" | "outgoing";
  /** Signed; sats for bitcoin legs, major units for EUR/USD legs. */
  amount: number;
  unit: InFlightRow["leg"]["unit"];
  ref: string;
};

export function inFlightCsvRecord(row: InFlightRow): InFlightCsvRecord {
  const outgoing = row.direction === "out";
  const magnitude = row.leg.unit === "sats" ? Math.trunc(row.leg.amount) : row.leg.amount;
  return {
    createdAt: row.record.createdAt,
    category: `${row.record.kind}_pending`,
    direction: outgoing ? "outgoing" : "incoming",
    amount: outgoing ? -magnitude : magnitude,
    unit: row.leg.unit,
    ref: row.record.id,
  };
}

/** The account a rail's rows belong to in the all-accounts export. */
export const EXPORT_ACCOUNT_BY_RAIL: Record<MoneyRail, ExportAccount> = {
  arkade: "bitcoin_lightning",
  onchain: "bitcoin_onchain",
  wallet: "euro",
  dollar: "dollar",
  visa: "visa",
  visaUsd: "visa",
};

export function inFlightExportRow(row: InFlightRow): TransactionExportRow {
  const r = inFlightCsvRecord(row);
  const outgoing = r.direction === "outgoing";
  const isSats = r.unit === "sats";
  const amount = isSats
    ? signedDecimal(r.amount / 1e8, outgoing, 8)
    : signedDecimal(r.amount, outgoing, 2);
  return {
    date: r.createdAt,
    account: EXPORT_ACCOUNT_BY_RAIL[row.leg.rail],
    category: r.category,
    direction: r.direction,
    amount,
    currency: isSats ? "BTC" : r.unit,
    amountFiat: isSats ? "" : amount,
    fiatCurrency: isSats ? "" : r.unit,
    status: "pending",
    reference: r.ref,
    counterparty: "",
    detailsUrl: "",
  };
}

/**
 * The in-flight rows the settled history does not list yet. A move the chain
 * (or the provider) already reports is shown once, by that settled row.
 */
export function unsettledInFlight<T extends { record: { id: string } }>(
  rows: readonly T[],
  settledRefs: ReadonlySet<string>,
): T[] {
  return rows.filter((row) => !settledRefs.has(row.record.id.trim().toLowerCase()));
}

/** Lower-cased, non-empty refs, for `unsettledInFlight`. */
export function refSet(refs: Iterable<string | null | undefined>): Set<string> {
  const out = new Set<string>();
  for (const ref of refs) {
    const key = String(ref || "")
      .trim()
      .toLowerCase();
    if (key) out.add(key);
  }
  return out;
}
