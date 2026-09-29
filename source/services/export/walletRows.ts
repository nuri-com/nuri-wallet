// Euro / dollar (Base EOA) history rows → CSV. One mapping, two outputs: the
// wallet history sheet's own export (its historic column set) and the
// all-accounts export row.
import { basescanTokenUrl, basescanTxUrl } from "../../config/endpoints";
import { resolveFiatCode } from "../../lib/tokens";
import type { WalletTransactionRow } from "../../types/wallet";
import {
  classifyWalletRow,
  getOrderDateIso,
  getOrderState,
  pickOrderTxHash,
} from "../balance/transactions/walletHistoryRows";
import { type ExportAccount, type TransactionExportRow, signedDecimal } from "./exportRow";

export type WalletCsvContext = {
  /** Token contract for the account-level explorer fallback link. */
  explorerToken: string;
  /** The account whose token page the fallback link opens. */
  explorerAccount: string | null | undefined;
};

/** Everything one wallet history row exports, read once. */
export type WalletCsvRecord = {
  createdAt: string;
  kind: string;
  status: string;
  direction: "incoming" | "outgoing";
  chainAddress: string;
  /** Unsigned, two decimals (or the raw value when it is not a number). */
  amount: string;
  currency: string;
  pending: boolean;
  rejectedReason: string;
  txHash: string;
  detailsUrl: string;
};

export function walletCsvRecord(o: WalletTransactionRow, ctx: WalletCsvContext): WalletCsvRecord {
  const { kind, isPendingBalance, isPendingLocal, isIncoming } = classifyWalletRow(o);
  const orderState = getOrderState(o);
  const amountRaw = o?.amount ?? o?.meta?.amount ?? null;
  const amountNum = Number(amountRaw);
  const txHash = (pickOrderTxHash(o) || "").trim();
  const account = (ctx.explorerAccount ?? "").trim();
  return {
    createdAt: getOrderDateIso(o) || "",
    kind,
    status: orderState,
    direction: isIncoming ? "incoming" : "outgoing",
    chainAddress: isPendingBalance ? "" : (o?.counterpart?.identifier?.address || "").trim(),
    amount: Number.isFinite(amountNum)
      ? amountNum.toFixed(2)
      : amountRaw === null || amountRaw === undefined
        ? ""
        : String(amountRaw),
    currency: resolveFiatCode(o?.currency ?? null),
    pending:
      isPendingBalance || isPendingLocal || orderState === "pending" || orderState === "placed",
    rejectedReason: orderState === "rejected" ? String(o?.meta?.rejectedReason || "").trim() : "",
    txHash,
    detailsUrl: txHash
      ? basescanTxUrl(txHash)
      : account
        ? basescanTokenUrl(ctx.explorerToken, account)
        : "",
  };
}

/** The wallet history sheet's own export columns (unchanged). */
export function walletHistoryCsvHeader(fiatCode: string): string[] {
  // Named after the history it belongs to, and every row still carries its own
  // code — a figure whose currency has to be inferred from a filename is one
  // that will be read as the wrong money.
  return [
    "created_at",
    "kind",
    "status",
    "direction",
    "chain_address",
    `amount_${fiatCode.toLowerCase()}`,
    "currency",
    "pending",
    "rejected_reason",
    "tx_hash",
    "details_url",
  ];
}

export function walletHistoryCsvCells(r: WalletCsvRecord): string[] {
  return [
    r.createdAt,
    r.kind,
    r.status,
    r.direction,
    r.chainAddress,
    r.amount,
    r.currency,
    r.pending ? "true" : "false",
    r.rejectedReason,
    r.txHash,
    r.detailsUrl,
  ];
}

/** `account` is the euro/dollar wallet, or the VISA account for card deposits. */
export function walletExportRow(r: WalletCsvRecord, account: ExportAccount): TransactionExportRow {
  const outgoing = r.direction === "outgoing";
  const n = Number(r.amount);
  const amount = Number.isFinite(n) ? signedDecimal(n, outgoing, 2) : r.amount;
  return {
    date: r.createdAt,
    account,
    category: r.kind,
    direction: r.direction,
    amount,
    currency: r.currency,
    // A stablecoin row IS its fiat value.
    amountFiat: amount,
    fiatCurrency: r.currency,
    status: r.status === "rejected" ? "failed" : r.pending ? "pending" : "completed",
    reference: r.txHash,
    counterparty: r.chainAddress,
    detailsUrl: r.detailsUrl,
  };
}
