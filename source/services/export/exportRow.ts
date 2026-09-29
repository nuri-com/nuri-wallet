// One row of the all-accounts transaction export, and the CSV it becomes.
// Every rail maps its own history into this shape (bitcoinRows, walletRows,
// wirexRows); this module only merges, orders and writes them. Pure: no
// platform imports, so it is unit-tested directly.
import { csvDocument } from "../../lib/csv";

/** The home-board account a row belongs to. */
export type ExportAccount =
  | "bitcoin_lightning"
  | "bitcoin_onchain"
  | "euro"
  | "dollar"
  | "visa"
  | "iban";

export type ExportStatus = "pending" | "completed" | "failed";

export type TransactionExportRow = {
  /** ISO 8601; empty only when the source carries no time at all. */
  date: string;
  account: ExportAccount;
  /** Rail-specific kind, e.g. `onchain`, `arkade`, `wallet_transfer_out`, `card_payment`. */
  category: string;
  direction: "incoming" | "outgoing" | "internal";
  /** Signed decimal in `currency` units (outgoing is negative). */
  amount: string;
  currency: string;
  /** Signed value in `fiatCurrency`, empty when no price was available. */
  amountFiat: string;
  fiatCurrency: string;
  status: ExportStatus;
  /** txid / tx hash / order or transfer id. */
  reference: string;
  counterparty: string;
  detailsUrl: string;
};

export const TRANSACTION_EXPORT_HEADER = [
  "date",
  "account",
  "category",
  "direction",
  "amount",
  "currency",
  "amount_fiat",
  "fiat_currency",
  "status",
  "reference",
  "counterparty",
  "details_url",
] as const;

/** A decimal with a sign taken from the direction, never "-0". */
export function signedDecimal(magnitude: number, outgoing: boolean, digits: number): string {
  const abs = Math.abs(magnitude);
  if (!Number.isFinite(abs)) return "";
  const text = abs.toFixed(digits);
  return outgoing && Number(text) !== 0 ? `-${text}` : text;
}

const timeOf = (row: TransactionExportRow): number => {
  const ms = Date.parse(row.date);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
};

/**
 * All rails' rows as one list, newest first. A row two sources report for the
 * same account (same reference and direction) is kept once — the first one
 * given wins, so callers pass their richest source first. Rows without a
 * reference are never collapsed: nothing proves two of them are one event.
 */
export function mergeExportRows(
  groups: ReadonlyArray<readonly TransactionExportRow[]>,
): TransactionExportRow[] {
  const seen = new Set<string>();
  const out: TransactionExportRow[] = [];
  for (const group of groups) {
    for (const row of group) {
      const ref = row.reference.trim().toLowerCase();
      if (ref) {
        const key = `${row.account}|${row.direction}|${ref}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push(row);
    }
  }
  // Stable: equal times keep their source order.
  return out
    .map((row, index) => ({ row, index, time: timeOf(row) }))
    .sort((a, b) => b.time - a.time || a.index - b.index)
    .map(({ row }) => row);
}

export function transactionExportCsv(rows: readonly TransactionExportRow[]): string {
  return csvDocument(
    TRANSACTION_EXPORT_HEADER,
    rows.map((r) => [
      r.date,
      r.account,
      r.category,
      r.direction,
      r.amount,
      r.currency,
      r.amountFiat,
      r.fiatCurrency,
      r.status,
      r.reference,
      r.counterparty,
      r.detailsUrl,
    ]),
  );
}
