// Wirex account history (card + bank/SEPA) → CSV. The card sheet's own export
// writes the rows as the user sees them; the all-accounts export maps the raw
// Wirex items. Both live here so no Wirex CSV mapping exists twice. Deposits
// into the card account are Base transfers and go through walletRows.
import type { ActivityItem } from "../../components/ActivitySheet";
import {
  bankCounterpartyName,
  merchantName,
  type WirexActivityItem,
  wirexFiatCode,
} from "../../lib/wirex/cardTransactions";
import { type ExportStatus, type TransactionExportRow, signedDecimal } from "./exportRow";

// ── The card sheet's own export (columns unchanged) ────────────────────────

export const WIREX_ACTIVITY_CSV_HEADER = [
  "created_at",
  "description",
  "details",
  "amount",
  "amount_eur",
  "pending",
] as const;

/** The feed rows are already display-formatted; statement-style, one row per item. */
export function wirexActivityCsvCells(item: ActivityItem): string[] {
  return [
    item.createdAt ?? "",
    item.label,
    item.sublabel ?? "",
    item.amount ?? "",
    item.amountSecondary ?? "",
    item.pending ? "true" : "false",
  ];
}

// ── All-accounts export ────────────────────────────────────────────────────

const STATUS: Record<WirexActivityItem["status"], ExportStatus> = {
  Pending: "pending",
  Completed: "completed",
  Failed: "failed",
};

/**
 * One raw Wirex item as an export row. `rail` is which feed it came from: card
 * rows belong to the VISA account, bank rows to the IBAN. The amount is the
 * user's side of the move — what arrived on a credit, what was paid on a debit
 * — with the same sign the history sheet shows.
 */
export function wirexExportRow(
  item: WirexActivityItem,
  rail: "card" | "bank",
): TransactionExportRow {
  const isCredit = item.direction === "Inbound";
  const paid = isCredit ? item.destination_amount : item.source_amount;
  const amount =
    paid && typeof paid.amount === "number" && Number.isFinite(paid.amount)
      ? signedDecimal(paid.amount, !isCredit, 2)
      : "";
  const currency = wirexFiatCode(paid) ?? String(paid?.currency || paid?.token_symbol || "");
  let counterparty = "";
  if (rail === "card") {
    counterparty = merchantName(item);
  } else {
    const subject = isCredit ? item.source : item.destination;
    const iban = String(subject?.bank_account?.iban || "").trim();
    counterparty = [bankCounterpartyName(item), iban].filter(Boolean).join(" ");
  }
  return {
    date: item.created_at || "",
    account: rail === "card" ? "visa" : "iban",
    category: String(item.sub_type || item.type || rail),
    direction: isCredit ? "incoming" : "outgoing",
    amount,
    currency,
    // A card/bank row is fiat already.
    amountFiat: amount,
    fiatCurrency: currency,
    status: STATUS[item.status] ?? "completed",
    reference: item.id || "",
    counterparty,
    detailsUrl: "",
  };
}
