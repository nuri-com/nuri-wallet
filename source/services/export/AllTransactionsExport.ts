// "Export transactions" (Settings): every account's history in ONE CSV.
//
// Thin wiring only — the rows are built by allTransactionsRows.ts through the
// same per-rail mappers the history sheets export with. Each rail's address is
// read the way the home board reads it (cached EOA, the bitcoin address store,
// the Wirex account snapshot); nothing here signs, so the export can never
// raise a passkey prompt; a missing Wirex read session is minted (one Face ID
// at most). The file is the promise "every transaction": if any account could
// not be read in full, nothing is shared and the accounts are named instead.
//
// SECURITY: logs row/rail counts only — never addresses, amounts or balances.
import { BASE_EURC, BASE_USDC } from "../../config/network";
import { csvFileName } from "../../lib/csv";
import { shareCsvFile } from "../../lib/csvExport";
import { homeCurrencyService } from "../../lib/currency/HomeCurrencyService";
import { getEthereumAddress } from "../../lib/secureKeyStorage";
import { isWirexBankReady } from "../../lib/wirex/cardState";
import type { WirexActivityItem } from "../../lib/wirex/cardTransactions";
import { fetchWirexDepositRows } from "../../lib/wirex/wirexDeposits";
import { getCacheValue } from "../balance/TransactionCacheService";
import { getBitcoinTransactionsMetaCacheKey } from "../balance/transactions/cacheKeys";
import { EURC_SCAN_TOKEN, USDC_SCAN_TOKEN } from "../balance/transactions/onchainScan";
import { fetchWalletTransactions } from "../balance/transactions/walletTransactions";
import { getBitcoinTransactions } from "../bitcoin/BitcoinTransactionsService";
import { walletService } from "../bitcoin/WalletService";
import { MoneyInFlightStore } from "../money/MoneyInFlightStore";
import { priceService } from "../pricing/PriceService";
import { wirexAccountService } from "../wirex/WirexAccountService";
import { wirexService } from "../wirex/WirexService";
import {
  type AllTransactionsSources,
  type ExportAccount,
  collectAllTransactionRows,
  readAllPages,
} from "./allTransactionsRows";
import { transactionExportCsv } from "./exportRow";

const LOG_TAG = "[AllTransactionsExport]";
/** The Wirex activity routes cap a page at 100. */
const WIREX_PAGE_SIZE = 100;

export type ExportAllTransactionsResult =
  | { ok: true; rows: number }
  | { ok: false; reason: "empty" | "failed" }
  /** Some accounts could not be read; no file was shared. */
  | { ok: false; reason: "incomplete"; missing: ExportAccount[] };

/**
 * The per-account reads. Exported for the source-discovery tests only.
 *
 * `null` means the account is confirmed absent. A snapshot that is still
 * loading, or whose last read failed, says nothing about the account, so it
 * throws: the rail is reported missing (`incomplete`) instead of being
 * silently left out of a file that promises every transaction.
 */
export function liveSources(): AllTransactionsSources {
  // Read once: the whole file states its fiat column in one currency.
  const homeFiat = homeCurrencyService.getHomeFiatCode();
  // Settled once per export: a snapshot still on its first read is awaited
  // (joining the load in flight, within the status cache) rather than read as
  // "no account".
  let wirexSettled: Promise<ReturnType<typeof wirexAccountService.getSnapshot>> | null = null;
  const wirexAccount = async () => {
    wirexSettled ??= (async () => {
      if (!wirexAccountService.getSnapshot().loading) return wirexAccountService.getSnapshot();
      await wirexAccountService.refresh(false);
      return wirexAccountService.getSnapshot();
    })();
    const snap = await wirexSettled;
    // "no_wallet": there is no key to hold a Wirex account with, so none exists.
    if (snap.loading || (snap.error !== null && snap.error !== "no_wallet")) {
      throw new Error("wirex account not loaded");
    }
    return snap.isApproved && snap.wallet ? snap : null;
  };
  // Every page. The user asked for the export, so a missing read session is
  // minted (one Face ID, deduped across reads) rather than dropping the card
  // and bank history from the file.
  const wirexPages = (rail: "card" | "bank", wallet: string) =>
    readAllPages<WirexActivityItem>((page) => {
      const opts = { pageSize: WIREX_PAGE_SIZE };
      return rail === "card"
        ? wirexService.getCardTransactions(wallet, page, opts)
        : wirexService.getBankTransactions(wallet, page, opts);
    }, WIREX_PAGE_SIZE);

  return {
    inFlight: async () => {
      await MoneyInFlightStore.hydrate();
      return MoneyInFlightStore.list();
    },
    bitcoin: async () => {
      const snapshot = walletService.getAddressSnapshot();
      const boarding = snapshot.currentAddress.trim();
      const musig2 = snapshot.musig2Address.trim();
      // Every wallet has an Arkade account, so no address is never "no Bitcoin
      // account": it is an address load still running or one that failed.
      if (!boarding && !musig2) throw new Error("bitcoin address not loaded");
      // Same choice the history sheet makes: incremental once a full history
      // is cached, a full read otherwise.
      const fullCached = await getCacheValue<boolean>(
        getBitcoinTransactionsMetaCacheKey(boarding),
      ).catch((): null => null);
      const result = await getBitcoinTransactions({
        address: boarding,
        legacyMode: fullCached === true ? "head" : "full",
        prefetchFiatPrices: true,
      });
      // Any error means part of the history is missing (Arkade, on-chain or
      // the cache), even when the rest loaded.
      if (result.error) throw new Error(result.error);
      const arkade = result.rows.filter((row) => row.source === "arkade");
      return {
        arkade,
        onchain: result.legacyFiltered,
        onchainAddresses: musig2 ? [musig2] : [],
      };
    },
    stablecoin: async (fiat) => {
      const evm = await getEthereumAddress();
      if (!evm) return null;
      const token = fiat === "USD" ? USDC_SCAN_TOKEN : EURC_SCAN_TOKEN;
      // Strict: a failed Base scan is a missing account, not the cached rows.
      const result = await fetchWalletTransactions({
        primaryAddress: evm,
        address: evm,
        token,
        strict: true,
      });
      if (result.error || !result.orders) throw new Error(result.error ?? "history failed");
      return {
        rows: result.orders ?? [],
        explorerToken: (fiat === "USD" ? BASE_USDC : BASE_EURC).address,
        explorerAccount: evm,
      };
    },
    wirexCard: async () => {
      const account = await wirexAccount();
      if (!account?.wallet) return null;
      return wirexPages("card", account.wallet);
    },
    wirexBank: async () => {
      const account = await wirexAccount();
      if (!account?.wallet || !isWirexBankReady(account)) return null;
      return wirexPages("bank", account.wallet);
    },
    wirexDeposits: async () => {
      const aa = (await wirexAccount())?.smartAccountAddress?.trim();
      // Both tokens or neither: a card with only its euro deposits is incomplete.
      return aa ? fetchWirexDepositRows(aa, { requireAll: true }) : null;
    },
    priceAt: (unixSeconds) => priceService.getCachedPriceAt(unixSeconds, homeFiat),
    homeFiat,
  };
}

/**
 * Builds one CSV of every account's transactions (newest first) and hands it
 * to the share sheet / browser download as `nuri-transactions-YYYY-MM-DD.csv`.
 * Accounts the user does not have are skipped. Every account is read
 * independently; if any could not be read in full, no file is shared and the
 * result names them (`incomplete`) — tapping again retries every read.
 */
export async function exportAllTransactionsCsv(): Promise<ExportAllTransactionsResult> {
  try {
    const { rows, loaded, failed, missing } = await collectAllTransactionRows(liveSources());
    console.log(`${LOG_TAG} collected`, { rows: rows.length, loaded, failed, missing });
    if (missing.length > 0) {
      return loaded === 0 && rows.length === 0
        ? { ok: false, reason: "failed" }
        : { ok: false, reason: "incomplete", missing };
    }
    if (rows.length === 0) return { ok: false, reason: "empty" };
    await shareCsvFile(transactionExportCsv(rows), csvFileName("nuri-transactions"));
    return { ok: true, rows: rows.length };
  } catch (e) {
    console.log(`${LOG_TAG} failed`, { error: e instanceof Error ? e.message : "unknown" });
    return { ok: false, reason: "failed" };
  }
}
