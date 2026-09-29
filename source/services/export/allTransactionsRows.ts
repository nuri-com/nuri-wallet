// Every account's history as rows of ONE export. The fetchers are injected, so
// this is plain, testable logic: which rails exist, how each one's history is
// mapped (through the same per-rail mappers the history sheets export with),
// which in-flight rows the settled history already covers, and what happens
// when a rail fails. AllTransactionsExport.ts wires the real fetchers.
import type { LegacyOnchainTx } from "../bitcoin/BitcoinTransactionsService";
import { buildWalletTransactionRows } from "../balance/transactions/walletHistoryRows";
import type { MoneyInFlight, MoneyRail } from "../money/MoneyInFlightStore";
import { inFlightAsWalletTransfers, inFlightRowsFor } from "../money/inFlightRows";
import type { WirexActivityItem } from "../../lib/wirex/cardTransactions";
import type { WalletTransactionRow } from "../../types/wallet";
import {
  type ArkadeTxLike,
  type PriceAt,
  arkadeCsvRecord,
  bitcoinExportRow,
  bitcoinSettledRefs,
  onchainCsvRecord,
} from "./bitcoinRows";
import { type TransactionExportRow, mergeExportRows } from "./exportRow";
import { inFlightExportRow, refSet, unsettledInFlight } from "./inFlightExport";
import { walletCsvRecord, walletExportRow } from "./walletRows";
import { wirexExportRow } from "./wirexRows";

export type BitcoinHistory = {
  arkade: readonly ArkadeTxLike[];
  onchain: readonly LegacyOnchainTx[];
  /** The MuSig2 (on-chain rail) addresses; every other on-chain row is Arkade boarding. */
  onchainAddresses: readonly string[];
};

/**
 * Each fetcher resolves `null` when the user has no such account (the rail is
 * skipped, not an error) and rejects when the account exists but its history
 * could not be read.
 */
export type AllTransactionsSources = {
  inFlight: () => Promise<readonly MoneyInFlight[]>;
  bitcoin: () => Promise<BitcoinHistory | null>;
  stablecoin: (fiat: "EUR" | "USD") => Promise<{
    rows: readonly WalletTransactionRow[];
    explorerToken: string;
    explorerAccount: string;
  } | null>;
  wirexCard: () => Promise<readonly WirexActivityItem[] | null>;
  wirexBank: () => Promise<readonly WirexActivityItem[] | null>;
  wirexDeposits: () => Promise<readonly WalletTransactionRow[] | null>;
  priceAt: PriceAt;
  homeFiat: string;
};

/** The accounts an export can be missing, named so the UI can say which. */
export type ExportAccount = "bitcoin" | "euro" | "dollar" | "card" | "bank";

export type AllTransactionsResult = {
  rows: TransactionExportRow[];
  /** Rails whose history was read in full (possibly empty). */
  loaded: number;
  /** Rails that exist but could not be read in full. */
  failed: number;
  /** Every account whose history is missing or incomplete, in display order. */
  missing: ExportAccount[];
};

const inFlightFor = (
  records: readonly MoneyInFlight[],
  rails: readonly MoneyRail[],
  settledRefs: ReadonlySet<string>,
): TransactionExportRow[] =>
  unsettledInFlight(inFlightRowsFor(records, rails), settledRefs).map(inFlightExportRow);

// A rail's rows plus the accounts it could not read. `null`: no such account.
type RailResult = { rows: TransactionExportRow[]; missing: ExportAccount[] };
type Rail = { accounts: ExportAccount[]; read: () => Promise<RailResult | null> };

function rails(src: AllTransactionsSources, records: readonly MoneyInFlight[]): Rail[] {
  const bitcoin = async (): Promise<RailResult | null> => {
    const history = await src.bitcoin();
    if (!history) return null;
    const onchain = new Set(history.onchainAddresses.map((a) => a.trim().toLowerCase()));
    const settled = bitcoinSettledRefs(history.arkade, history.onchain);
    const rows = [
      ...inFlightFor(records, ["arkade", "onchain"], settled),
      ...history.arkade.map((atx) =>
        bitcoinExportRow(arkadeCsvRecord(atx, src.priceAt), "bitcoin_lightning", src.homeFiat),
      ),
      ...history.onchain.map((entry) =>
        bitcoinExportRow(
          onchainCsvRecord(entry, src.priceAt),
          onchain.has(entry.address.trim().toLowerCase()) ? "bitcoin_onchain" : "bitcoin_lightning",
          src.homeFiat,
        ),
      ),
    ];
    return { rows, missing: [] };
  };

  // The history sheet's own list: settled rows plus the in-flight transfers it
  // does not list yet (buildWalletTransactionRows is where that dedupe lives).
  const stablecoin = (fiat: "EUR" | "USD") => async (): Promise<RailResult | null> => {
    const history = await src.stablecoin(fiat);
    if (!history) return null;
    const rail = fiat === "USD" ? "dollar" : "wallet";
    const account = fiat === "USD" ? "dollar" : "euro";
    const ctx = {
      explorerToken: history.explorerToken,
      explorerAccount: history.explorerAccount,
    };
    const rows = buildWalletTransactionRows(
      history.rows,
      inFlightAsWalletTransfers(records, rail),
      0,
    ).map((o) => walletExportRow(walletCsvRecord(o, ctx), account));
    return { rows, missing: [] };
  };

  // Card, bank and deposits are read independently (as the card sheet does),
  // so one failing does not stop the others — but it is reported by name: a
  // card history without its bank half is not "every transaction". The Wirex
  // in-flight rows (card top-ups, SEPA, withdrawals) ride with the card feed,
  // deduped against every Wirex reference that did load.
  const wirex = async (): Promise<RailResult | null> => {
    const [card, bank, deposits] = await Promise.allSettled([
      src.wirexCard(),
      src.wirexBank(),
      src.wirexDeposits(),
    ]);
    const results = [card, bank, deposits];
    const existing = results.filter((r) => r.status === "rejected" || r.value !== null);
    // No Wirex account at all: every feed said so.
    if (existing.length === 0) return null;
    const missing: ExportAccount[] = [];
    if (card.status === "rejected" || deposits.status === "rejected") missing.push("card");
    if (bank.status === "rejected") missing.push("bank");
    const value = <T>(r: PromiseSettledResult<T | null>): T | null =>
      r.status === "fulfilled" ? r.value : null;
    const cardItems = value(card);
    const bankItems = value(bank);
    const depositRows = value(deposits);
    const settled = refSet([
      ...(cardItems ?? []).map((i) => i.id),
      ...(bankItems ?? []).map((i) => i.id),
      ...(depositRows ?? []).flatMap((r) => [r.id, r.meta?.txHash]),
    ]);
    const rows = [
      ...inFlightFor(records, ["visa", "visaUsd"], settled),
      ...(cardItems ?? []).map((i) => wirexExportRow(i, "card")),
      ...(bankItems ?? []).map((i) => wirexExportRow(i, "bank")),
      ...(depositRows ?? []).map((o) => ({
        ...walletExportRow(walletCsvRecord(o, { explorerToken: "", explorerAccount: "" }), "visa"),
        category: "card_deposit",
      })),
    ];
    return { rows, missing };
  };

  return [
    { accounts: ["bitcoin"], read: bitcoin },
    { accounts: ["euro"], read: stablecoin("EUR") },
    { accounts: ["dollar"], read: stablecoin("USD") },
    // A Wirex read that throws outright (not per feed) loses both halves.
    { accounts: ["card", "bank"], read: wirex },
  ];
}

/**
 * Every page of a paged history, read until a short page. `maxPages` bounds a
 * server that never returns one; hitting it throws rather than exporting a
 * history silently cut off.
 */
export async function readAllPages<T>(
  fetchPage: (page: number) => Promise<readonly T[]>,
  pageSize: number,
  maxPages = 100,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const items = await fetchPage(page);
    out.push(...items);
    if (items.length < pageSize) return out;
  }
  throw new Error("history longer than the page limit");
}

/**
 * Reads every rail in parallel (one failing never stops another) and merges
 * what loaded, newest first. Whatever could not be read is named in `missing`:
 * the caller decides whether a file without it may be called an export.
 */
export async function collectAllTransactionRows(
  src: AllTransactionsSources,
): Promise<AllTransactionsResult> {
  const records = await src.inFlight().catch((): MoneyInFlight[] => []);
  const railList = rails(src, records);
  const settled = await Promise.allSettled(railList.map((rail) => rail.read()));
  const groups: TransactionExportRow[][] = [];
  const missing: ExportAccount[] = [];
  let loaded = 0;
  let failed = 0;
  settled.forEach((result, i) => {
    if (result.status === "rejected") {
      failed += 1;
      missing.push(...railList[i].accounts);
      return;
    }
    if (!result.value) return;
    groups.push(result.value.rows);
    if (result.value.missing.length > 0) {
      failed += 1;
      missing.push(...result.value.missing);
    } else {
      loaded += 1;
    }
  });
  return { rows: mergeExportRows(groups), loaded, failed, missing };
}
