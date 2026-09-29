// Bitcoin history (Arkade + on-chain + in flight) → CSV. One mapping, two
// outputs: the bitcoin history sheet's own export (its historic columns) and
// the all-accounts export row. Pure: fiat prices come in as `priceAt`.
import { mempoolTxUrl } from "../../config/endpoints";
import { classifyTransaction } from "../../lib/bitcoin/convert";
import type { UnifiedTransaction } from "../arkade/ArkadeTransactionHistoryService";
import type { LegacyOnchainTx } from "../bitcoin/BitcoinTransactionsService";
import { type ExportAccount, type TransactionExportRow, signedDecimal } from "./exportRow";
import { type InFlightCsvRecord, refSet } from "./inFlightExport";

/** Cached BTC price in the home fiat at a unix second, or null when unknown. */
export type PriceAt = (unixSeconds: number) => number | null;

export type ArkadeTxLike = Pick<
  UnifiedTransaction,
  "id" | "type" | "amountSats" | "timestamp" | "status" | "txid" | "isMigrationTx"
>;

export type BitcoinCsvRecord = {
  createdAt: string;
  category: string;
  direction: "incoming" | "outgoing";
  counterparty: string;
  /** Signed sats; null when the source amount is not a number. */
  amountSats: number | null;
  /** Signed, two decimals, home fiat; empty without a price. */
  amountFiat: string;
  confirmed: boolean;
  ref: string;
  detailsUrl: string;
};

const fiatAt = (priceAt: PriceAt, unixSeconds: number, btc: number | null): string => {
  if (btc === null) return "";
  try {
    const price = priceAt(unixSeconds);
    if (typeof price === "number" && Number.isFinite(price)) return (btc * price).toFixed(2);
  } catch {}
  return "";
};

export function arkadeCsvRecord(atx: ArkadeTxLike, priceAt: PriceAt): BitcoinCsvRecord {
  const isIncoming = atx.type === "received";
  const signed = isIncoming ? atx.amountSats : -atx.amountSats;
  const unixSeconds = atx.timestamp ? Math.floor(atx.timestamp / 1000) : null;
  return {
    createdAt: atx.timestamp ? new Date(atx.timestamp).toISOString() : "",
    category: atx.isMigrationTx ? "arkade_migration" : "arkade",
    direction: isIncoming ? "incoming" : "outgoing",
    counterparty: "",
    amountSats: Math.round(signed),
    amountFiat: unixSeconds ? fiatAt(priceAt, unixSeconds, signed / 1e8) : "",
    confirmed: atx.status === "confirmed",
    ref: atx.txid || atx.id || "",
    detailsUrl: "",
  };
}

export function onchainCsvRecord(
  { tx: t, address: txAddress }: LegacyOnchainTx,
  priceAt: PriceAt,
): BitcoinCsvRecord {
  const isConfirmed = !!t?.status?.confirmed;
  const display = classifyTransaction(t, txAddress);
  const isIncoming = display.isIncoming;
  const amountSats = Number(display.amountSats ?? 0);
  const signed = isIncoming ? amountSats : -amountSats;
  const btc = Number.isFinite(signed) ? signed / 1e8 : null;

  let counterparty = "";
  if (isIncoming) {
    const fromAddr = t?.vin?.[0]?.prevout?.scriptpubkey_address;
    if (fromAddr) counterparty = String(fromAddr);
  } else {
    const toAddr = (t.vout || [])
      .map((o) => o?.scriptpubkey_address)
      .find((a): a is string => !!a && a !== txAddress);
    if (toAddr) counterparty = String(toAddr);
  }

  let createdAt = "";
  const blockTime = t?.status?.block_time;
  if (blockTime) {
    try {
      createdAt = new Date(blockTime * 1000).toISOString();
    } catch {}
  }

  return {
    createdAt,
    category: "onchain",
    direction: isIncoming ? "incoming" : "outgoing",
    counterparty,
    amountSats: Number.isFinite(signed) ? Math.round(signed) : null,
    amountFiat: isConfirmed && blockTime ? fiatAt(priceAt, blockTime, btc) : "",
    confirmed: isConfirmed,
    ref: t?.txid || "",
    detailsUrl: t?.txid ? `${mempoolTxUrl(t.txid)}?mode=details` : "",
  };
}

/** Every id the settled bitcoin history already lists (for in-flight dedupe). */
export function bitcoinSettledRefs(
  arkade: readonly ArkadeTxLike[],
  onchain: readonly LegacyOnchainTx[],
): Set<string> {
  return refSet([...arkade.flatMap((a) => [a.id, a.txid]), ...onchain.map(({ tx }) => tx?.txid)]);
}

// ── The bitcoin history sheet's own export (columns unchanged) ──────────────

export const BITCOIN_HISTORY_CSV_HEADER = [
  "created_at",
  "category",
  "direction",
  "counterparty",
  "amount_sats",
  "amount_btc",
  "amount_fiat",
  "fiat_currency",
  "confirmed",
  "ref",
  "details_url",
] as const;

export function bitcoinHistoryCsvCells(r: BitcoinCsvRecord, fiatCurrency: string): string[] {
  return [
    r.createdAt,
    r.category,
    r.direction,
    r.counterparty,
    r.amountSats === null ? "" : String(r.amountSats),
    r.amountSats === null ? "" : (r.amountSats / 1e8).toFixed(8),
    r.amountFiat,
    r.amountFiat ? fiatCurrency : "",
    r.confirmed ? "true" : "false",
    r.ref,
    r.detailsUrl,
  ];
}

/** An in-flight bitcoin leg in the sheet's columns (sats legs only). */
export function bitcoinInFlightCsvCells(r: InFlightCsvRecord): string[] | null {
  if (r.unit !== "sats") return null;
  return [
    r.createdAt,
    r.category,
    r.direction,
    "",
    String(r.amount),
    (r.amount / 1e8).toFixed(8),
    "",
    "",
    "false",
    r.ref,
    "",
  ];
}

// ── All-accounts export ────────────────────────────────────────────────────

export function bitcoinExportRow(
  r: BitcoinCsvRecord,
  account: Extract<ExportAccount, "bitcoin_lightning" | "bitcoin_onchain">,
  fiatCurrency: string,
): TransactionExportRow {
  const outgoing = r.direction === "outgoing";
  return {
    date: r.createdAt,
    account,
    category: r.category,
    direction: r.direction,
    amount: r.amountSats === null ? "" : signedDecimal(r.amountSats / 1e8, outgoing, 8),
    currency: "BTC",
    amountFiat: r.amountFiat,
    fiatCurrency: r.amountFiat ? fiatCurrency : "",
    status: r.confirmed ? "completed" : "pending",
    reference: r.ref,
    counterparty: r.counterparty,
    detailsUrl: r.detailsUrl,
  };
}
