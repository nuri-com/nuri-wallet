// The activity a contact's page picks its rows from (#1793): the Cash (Euro
// and Dollar), Bitcoin and bank histories, read the way their own activity
// sheets read them and built into rows by the same builders, so a payment
// reads the same on the contact's page as in the activity. The page then keeps
// the rows the activity names after that contact (ActivityList `onlyContact`).
//
// Shown at once from the copies the activity sheets keep on the device, then
// each history fills in as its read answers. Read when a contact opens and kept
// while the address book is open, so browsing contacts does not read every
// history again; at most once a minute.
// Never a passkey or Face ID prompt: the bank history reads only with a read
// session already cached, and nothing here signs. A history that could not be
// read in full (no session, offline, a failed page) keeps the rows it did read,
// never reads as "no payments", and is read again on the next contact.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActivityItem } from "../../components/ActivitySheet";
import { useHomeCurrency } from "../../lib/currency/useHomeCurrency";
import { getEthereumAddress } from "../../lib/secureKeyStorage";
import { isWirexBankReady } from "../../lib/wirex/cardState";
import type { UnifiedTransaction } from "../../services/arkade/ArkadeTransactionHistoryService";
import { getCacheValue } from "../../services/balance/TransactionCacheService";
import {
  getArkadeTransactionsCacheKey,
  getBitcoinTransactionsCacheKey,
  getBitcoinTransactionsMetaCacheKey,
  getWalletTransactionsDbCacheKey,
} from "../../services/balance/transactions/cacheKeys";
import type { AddressTx } from "../../types/bitcoin";
import { EURC_SCAN_TOKEN, USDC_SCAN_TOKEN } from "../../services/balance/transactions/onchainScan";
import { walletActivityItems } from "../../services/balance/transactions/walletActivityItems";
import { buildWalletTransactionRows } from "../../services/balance/transactions/walletHistoryRows";
import { fetchWalletTransactions } from "../../services/balance/transactions/walletTransactions";
import {
  arkadeActivityItem,
  arkadeHistoryRows,
  bitcoinListTxs,
  onchainActivityItem,
} from "../../services/bitcoin/bitcoinActivityItems";
import {
  getBitcoinTransactions,
  type LegacyOnchainTx,
} from "../../services/bitcoin/BitcoinTransactionsService";
import { walletService } from "../../services/bitcoin/WalletService";
import { useSwapLegs } from "../../services/swapkit/swapActivity";
import { wirexAccountService } from "../../services/wirex/WirexAccountService";
import { wirexService } from "../../services/wirex/WirexService";
import type { WalletTransactionRow } from "../../types/wallet";
import { homeCurrencyService } from "../../lib/currency/HomeCurrencyService";
import {
  mapWirexBankActivity,
  type WirexActivityItem,
  type WirexBankCounterparty,
} from "../../lib/wirex/cardTransactions";
import { fxRateService } from "../../services/pricing/FxRateService";
import {
  keepRows,
  cachedBitcoinHistory,
  readAllPagesKept,
  seedFromCache,
  readCashHistory,
  withRailKeys,
} from "../../services/addressBook/contactActivityReads";

/** A Cash history: Euro is the EUR wallet, Dollar the USD one. */
export type CashRail = "wallet" | "dollar";

export type ContactActivityHandlers = {
  /** Pay a Cash row's address again from that currency (opens the send). */
  onSendAgainCash?: (address: string, rail: CashRail) => void;
  /** Pay a bank row's counterparty again (opens the bank transfer). */
  onSendAgainBank?: (counterparty: WirexBankCounterparty) => void;
};

type Read = {
  evm: string | null;
  euro: WalletTransactionRow[];
  dollar: WalletTransactionRow[];
  bitcoin: {
    arkade: UnifiedTransaction[];
    onchain: LegacyOnchainTx[];
    boarding: string;
    musig2: string;
  } | null;
  bank: ActivityItem[];
  failed: boolean;
};

const EMPTY: Read = { evm: null, euro: [], dollar: [], bitcoin: null, bank: [], failed: false };
const FRESH_MS = 60_000;

async function readCash(fiat: "EUR" | "USD") {
  const evm = await getEthereumAddress();
  if (!evm) return { evm: null, rows: [] as WalletTransactionRow[], failed: false };
  const token = fiat === "USD" ? USDC_SCAN_TOKEN : EURC_SCAN_TOKEN;
  const read = await readCashHistory((strict) =>
    fetchWalletTransactions({ primaryAddress: evm, address: evm, token, strict }),
  );
  return { evm, rows: read.rows, failed: !read.complete };
}

async function readBitcoin() {
  const snapshot = walletService.getAddressSnapshot();
  const boarding = snapshot.currentAddress.trim();
  const musig2 = snapshot.musig2Address.trim();
  if (!boarding && !musig2) return { data: null, failed: true };
  // Same choice the Bitcoin activity makes: only the newest page once a full
  // history is cached, so a contact's page costs no full read.
  const fullCached = await getCacheValue<boolean>(
    getBitcoinTransactionsMetaCacheKey(boarding),
  ).catch((): null => null);
  const result = await getBitcoinTransactions({
    address: boarding,
    legacyMode: fullCached === true ? "head" : "full",
    prefetchFiatPrices: true,
  });
  return {
    data: {
      arkade: arkadeHistoryRows(result.rows),
      onchain: result.legacyFiltered,
      boarding,
      musig2,
    },
    failed: Boolean(result.error),
  };
}

/**
 * The copies the Cash and Bitcoin activity sheets keep on the device, read in
 * a moment: what the page shows while the histories are read again.
 */
async function readCached(): Promise<Partial<Read>> {
  const out: Partial<Read> = {};
  const evm = await getEthereumAddress().catch((): null => null);
  if (evm) {
    const cash = (token: typeof EURC_SCAN_TOKEN) =>
      getCacheValue<WalletTransactionRow[]>(
        getWalletTransactionsDbCacheKey(evm, undefined, evm, token.fiatCode),
      )
        .then((rows) => (Array.isArray(rows) ? rows.filter(Boolean) : []))
        .catch((): WalletTransactionRow[] => []);
    const [euro, dollar] = await Promise.all([cash(EURC_SCAN_TOKEN), cash(USDC_SCAN_TOKEN)]);
    Object.assign(out, { evm, euro, dollar });
  }
  const snapshot = walletService.getAddressSnapshot();
  const boarding = snapshot.currentAddress.trim();
  const musig2 = snapshot.musig2Address.trim();
  if (boarding || musig2) {
    out.bitcoin = await cachedBitcoinHistory({
      boarding,
      musig2,
      arkade: (key) => getCacheValue<UnifiedTransaction[]>(getArkadeTransactionsCacheKey(key)),
      onchain: (key) => getCacheValue<AddressTx[]>(getBitcoinTransactionsCacheKey(key)),
    });
  }
  return out;
}

/** The Wirex bank routes cap a page at 100. */
const BANK_PAGE_SIZE = 100;

/**
 * Every page of the bank history, with the read session already cached only:
 * opening a contact never asks for Face ID. No session, or a page that fails,
 * keeps what was read and says the history is incomplete.
 */
async function readBank(onSendAgain?: (counterparty: WirexBankCounterparty) => void) {
  const account = wirexAccountService.getSnapshot();
  // Still loading, or its last read failed: nothing is known about the account.
  if (account.loading || (account.error !== null && account.error !== "no_wallet")) {
    return { rows: [] as ActivityItem[], failed: true };
  }
  const wallet = account.wallet;
  if (!wallet || !account.isApproved || !isWirexBankReady(account)) {
    return { rows: [] as ActivityItem[], failed: false };
  }
  const read = await readAllPagesKept<WirexActivityItem>(
    (page) =>
      wirexService.getBankTransactions(wallet, page, {
        pageSize: BANK_PAGE_SIZE,
        cachedSessionOnly: true,
      }),
    BANK_PAGE_SIZE,
  );
  const rates = await fxRateService.getRates().catch((): undefined => undefined);
  const rows = mapWirexBankActivity(
    read.rows,
    rates,
    onSendAgain,
    homeCurrencyService.getHomeCurrency(),
  );
  return { rows, failed: !read.complete };
}

/**
 * Every row a contact's page can pick from, kept while `active` (the address
 * book is open). `load()` reads when the rows are older than a minute; call it
 * when a contact opens (`contactOpen`).
 */
export function useContactActivity(
  active: boolean,
  contactOpen: boolean,
  handlers: ContactActivityHandlers,
) {
  const [read, setRead] = useState<Read>(EMPTY);
  const [loading, setLoading] = useState(false);
  const loadedAt = useRef(0);
  // Which read owns the state: closing the address book drops a read in flight.
  const generation = useRef(0);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (active) return;
    generation.current++;
    loadedAt.current = 0;
    setRead(EMPTY);
    setLoading(false);
  }, [active]);

  // Rows show at once from the copies the activity sheets keep on the device,
  // then each history replaces its own rows as its read answers: the page never
  // waits for the slowest history.
  const load = useCallback(() => {
    if (!active || loading || Date.now() - loadedAt.current < FRESH_MS) return;
    const gen = ++generation.current;
    const current = () => gen === generation.current;
    const update = (change: (prev: Read) => Read) => {
      if (current()) setRead(change);
    };
    setLoading(true);
    void (async () => {
      // The device copy only fills a history this open has not read yet: rows
      // an earlier contact's read found are newer than it and stay.
      const cached = await readCached().catch((): Partial<Read> => ({}));
      update((prev) => seedFromCache(prev, cached));
      let incomplete = false;
      const settle = <T>(promise: Promise<T>, apply: (value: T) => void) =>
        promise.then(apply, () => {
          incomplete = true;
        });
      await Promise.all([
        settle(readCash("EUR"), (r) => {
          incomplete ||= r.failed;
          update((prev) => ({
            ...prev,
            evm: r.evm ?? prev.evm,
            euro: keepRows(prev.euro, r.rows, !r.failed),
          }));
        }),
        settle(readCash("USD"), (r) => {
          incomplete ||= r.failed;
          update((prev) => ({
            ...prev,
            evm: r.evm ?? prev.evm,
            dollar: keepRows(prev.dollar, r.rows, !r.failed),
          }));
        }),
        settle(readBitcoin(), (r) => {
          incomplete ||= r.failed;
          const data = r.data;
          if (!data) return;
          update((prev) => ({
            ...prev,
            bitcoin: {
              ...data,
              arkade: keepRows(prev.bitcoin?.arkade ?? [], data.arkade, !r.failed),
              onchain: keepRows(prev.bitcoin?.onchain ?? [], data.onchain, !r.failed),
            },
          }));
        }),
        settle(
          readBank((counterparty) => handlersRef.current.onSendAgainBank?.(counterparty)),
          (r) => {
            incomplete ||= r.failed;
            update((prev) => ({ ...prev, bank: keepRows(prev.bank, r.rows, !r.failed) }));
          },
        ),
      ]);
      if (!current()) return;
      // An incomplete read is not kept as fresh: the next contact reads again.
      loadedAt.current = incomplete ? 0 : Date.now();
      update((prev) => ({ ...prev, failed: incomplete }));
      setLoading(false);
    })();
  }, [active, loading]);

  const swapLegs = useSwapLegs(active && contactOpen);
  const homeSym = useHomeCurrency();
  const items = useMemo(() => {
    // Keys name the currency: a Euro and a Dollar leg of one transaction are two rows.
    const cash = (rows: WalletTransactionRow[], rail: CashRail) =>
      withRailKeys(
        walletActivityItems(buildWalletTransactionRows(rows, [], 0), {
          primaryAddress: read.evm,
          address: read.evm,
          swapLegs,
          // A swap in progress is no payment with a contact: its rows never show here.
          onOpenOrder: () => {},
          onSendAgain: (address) => handlersRef.current.onSendAgainCash?.(address, rail),
        }),
        rail,
      );
    const list: ActivityItem[] = [...cash(read.euro, "wallet"), ...cash(read.dollar, "dollar")];
    const btc = read.bitcoin;
    if (btc) {
      const own = [btc.boarding, btc.musig2].filter(Boolean).map((a) => a.toLowerCase());
      const railAddresses = new Set(own);
      for (const atx of btc.arkade) list.push(arkadeActivityItem(atx, { homeSym, swapLegs }));
      const txs = bitcoinListTxs({
        txs: btc.onchain,
        rail: "bitcoin",
        railAddresses,
        ownAddresses: own,
        address: btc.boarding,
        boardingDepositTxids: btc.arkade
          .filter((row) => row.boarding && row.boardingTxid)
          .map((row) => String(row.boardingTxid)),
      });
      for (const entry of txs) {
        list.push(onchainActivityItem(entry, { homeSym, swapLegs, railAddresses }));
      }
    }
    return list.concat(read.bank);
  }, [read, swapLegs, homeSym]);

  return { items, loading, failed: read.failed, load };
}
