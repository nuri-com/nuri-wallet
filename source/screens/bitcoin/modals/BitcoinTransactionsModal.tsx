// @screen bitcoin.transactions
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking } from "react-native";
import { mempoolTxUrl } from "../../../config/endpoints";
import { formatActivityTime } from "../../../lib/transactionRowUtils";
import { shareCsvFile } from "../../../lib/csvExport";
import { csvDocument, csvFileName } from "../../../lib/csv";
import {
  BITCOIN_HISTORY_CSV_HEADER,
  arkadeCsvRecord,
  bitcoinHistoryCsvCells,
  bitcoinInFlightCsvCells,
  bitcoinSettledRefs,
  onchainCsvRecord,
} from "../../../services/export/bitcoinRows";
import { inFlightCsvRecord, unsettledInFlight } from "../../../services/export/inFlightExport";
import ActivitySheet, { type ActivityItem } from "../../../components/ActivitySheet";
import { priceService } from "../../../services/pricing/PriceService";
import { EventBus } from "../../../services/events/AppEventBusService";
import { getCacheValue, setCacheValue } from "../../../services/balance/TransactionCacheService";
import { useHomeCurrency } from "../../../lib/currency/useHomeCurrency";
import {
  getArkadeTransactionsCacheKey,
  getBitcoinTransactionsCacheKey,
  getBitcoinTransactionsMetaCacheKey,
} from "../../../services/balance/transactions/cacheKeys";
import type { BitcoinTransactionsProps, AddressTx } from "../../../types/bitcoin";
import { classifyTransaction } from "../../../lib/bitcoin/convert";
import type { UnifiedTransaction } from "../../../services/arkade/ArkadeTransactionHistoryService";
import {
  getBitcoinTransactions,
  type LegacyOnchainTx,
} from "../../../services/bitcoin/BitcoinTransactionsService";
import { getSwapKitV2StatusMessage } from "../../../services/swapkit/SwapKitV2PendingTracker";
import { useInFlightRows } from "../../../services/money/useInFlightRows";
import { inFlightActivityItem } from "../../../services/money/inFlightActivity";
import { t } from "../../../lib/i18n";
import { getArkadeWalletSummarySnapshot } from "../../../services/arkade/ArkadeWalletService";
import SwapStatusDetailSheet from "../../swapkit/SwapStatusDetailSheet";
import { swapRow, useSwapLegs } from "../../../services/swapkit/swapActivity";
import { groupCount } from "../../../lib/formatting";

type Props = BitcoinTransactionsProps;

const BitcoinTransactionsModal: React.FC<Props> = ({
  visible,
  onClose,
  address = "",
  historyAddresses,
  rail,
}) => {
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Each entry carries its own classifying address: the boarding address and
  // the MuSig2 wallet are separate on-chain rails in one list.
  const [txs, setTxs] = useState<LegacyOnchainTx[]>([]);
  const [isFullCache, setIsFullCache] = useState(false);
  const [pricesVersion, setPricesVersion] = useState(0);
  // The fiat column is in the display currency; each row is priced at its own
  // time in it.
  const homeSym = useHomeCurrency();
  const inFlight = useInFlightRows(rail === "onchain" ? ["onchain"] : ["arkade"]);
  const [exportingCsv, setExportingCsv] = useState(false);
  const [arkadeTxs, setArkadeTxs] = useState<UnifiedTransaction[]>([]);
  // Pending topup swap row tapped → live "where is my money?" sheet for it.
  const [detailOrderId, setDetailOrderId] = useState<string | null>(null);
  // Load ALL transactions; no pagination UI

  // Which addresses' rows belong in this list. Normalized to a stable key first
  // so a caller passing a fresh array literal every render does not rebuild the
  // list. `address` is untouched by this — it stays the one address the rail
  // fetches and caches under.
  const railAddressKey = (historyAddresses?.length ? historyAddresses : [address])
    .map((a) =>
      String(a || "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean)
    .sort()
    .join("|");
  const railAddresses = useMemo(
    () => new Set(railAddressKey ? railAddressKey.split("|") : []),
    [railAddressKey],
  );

  const cacheKey = useMemo(() => (address || "").trim().toLowerCase(), [address]);
  const hasAddress = !!cacheKey;
  const dbCacheKey = useMemo(() => getBitcoinTransactionsCacheKey(address), [address]);
  const arkadeCacheKey = useMemo(() => getArkadeTransactionsCacheKey(address), [address]);
  const dbMetaKey = useMemo(() => getBitcoinTransactionsMetaCacheKey(address), [address]);

  // Single fetch path for the modal — calls the BitcoinTransactionsService
  // wrapper which fans out to legacy onchain + arkade, prefetches fiat prices,
  // and returns unified data. The per-source state slots below (txs /
  // arkadeTxs) stay because the existing renderer reads them directly.
  const refreshAll = useCallback(
    async (legacyMode: "head" | "full") => {
      console.log("[BitcoinTransactionsModal] refreshAll enter", {
        hasAddress,
        legacyMode,
      });
      setLoading(true);
      setError(null);
      try {
        const result = await getBitcoinTransactions({
          address,
          legacyMode,
          prefetchFiatPrices: true,
        });
        console.log("[BitcoinTransactionsModal] refreshAll got", {
          rowCount: result.rows.length,
          legacyFilteredCount: result.legacyFiltered.length,
          isFullCache: result.isFullCache,
          hasError: !!result.error,
        });
        const arkadeRows: UnifiedTransaction[] = [];
        for (const row of result.rows) {
          if (row.source !== "arkade") continue;
          arkadeRows.push({
            id: row.id,
            type: row.type,
            amountSats: row.amountSats,
            timestamp: row.timestamp,
            status: row.status,
            source: "arkade",
            kind: row.kind,
            txid: row.txid,
            isMigrationTx: row.isMigrationTx,
            counterpartyScripts: row.counterpartyScripts,
          });
        }
        // A refresh that fetched nothing never replaces what is already shown.
        // Transaction history only grows, so an empty result means the fetch
        // failed — mempool.space rate-limits under the polling this screen does
        // — and the old rows are still the truth. Overwriting them blanked the
        // list on every 429.
        setArkadeTxs((prev) => (arkadeRows.length === 0 && prev.length > 0 ? prev : arkadeRows));
        // Persist for the next open. The Arkade half is derived from the
        // indexer on every call, so without this the list has nothing to draw
        // until that round trip finishes — the legacy rows hydrate instantly
        // and the Arkade ones appear seconds later. Only a non-empty result is
        // written, for the same reason it is not allowed to replace the rows
        // above: an empty answer is a failed fetch, not an empty history.
        if (arkadeCacheKey && arkadeRows.length > 0) {
          void setCacheValue(arkadeCacheKey, arkadeRows).catch(() => {});
        }
        setTxs((prev) =>
          result.legacyFiltered.length === 0 && prev.length > 0 ? prev : result.legacyFiltered,
        );
        if (legacyMode === "full" && hasAddress && !result.error) {
          setIsFullCache(true);
        }
        if (result.error) setError(result.error);
        setPricesVersion((v) => v + 1);
      } catch (e) {
        console.log(
          "[BitcoinTransactionsModal] refreshAll threw",
          e instanceof Error ? e.message : String(e),
        );
        setError(e instanceof Error ? e.message : "Failed to load transactions");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [address, hasAddress, arkadeCacheKey],
  );

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void (async () => {
      console.log("[BitcoinTransactionsModal] mount enter", {
        hasAddress,
        addressLen: address.length,
      });
      // Hydrate from db cache for instant display of legacy onchain rows
      // while the fresh refreshAll() is in flight.
      let cached: AddressTx[] | null = null;
      let full = false;
      if (hasAddress) {
        try {
          const cachedArkade = await getCacheValue<UnifiedTransaction[]>(arkadeCacheKey);
          if (!cancelled && Array.isArray(cachedArkade) && cachedArkade.length > 0) {
            setArkadeTxs(cachedArkade);
          }
        } catch {}
        try {
          cached = await getCacheValue<AddressTx[]>(dbCacheKey);
          // The db cache is keyed by the boarding address, so every cached tx
          // classifies against it.
          if (!cancelled && cached) setTxs(cached.map((tx) => ({ tx, address })));
        } catch {}
        try {
          const meta = await getCacheValue<boolean>(dbMetaKey);
          if (typeof meta === "boolean") {
            full = meta;
          } else {
            full = Array.isArray(cached) && cached.length > 0;
          }
        } catch {
          full = Array.isArray(cached) && cached.length > 0;
        }
        if (!cancelled) setIsFullCache(full);
      } else {
        setTxs([]);
      }
      if (!cancelled) {
        void refreshAll(full ? "head" : "full");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, refreshAll, dbCacheKey, dbMetaKey, arkadeCacheKey, hasAddress, address]);

  const selfRefreshingRef = useRef(false);
  const onRefresh = useCallback(() => {
    console.log("[BitcoinTransactionsModal] onRefresh enter setRefreshing(true)", {
      hasAddress,
      isFullCache,
    });
    selfRefreshingRef.current = true;
    setTimeout(() => {
      selfRefreshingRef.current = false;
    }, 0);
    setRefreshing(true);
    try {
      EventBus.emit("bitcoin:refresh");
    } catch {}
    return refreshAll(isFullCache ? "head" : "full");
  }, [hasAddress, isFullCache, refreshAll]);

  useEffect(() => {
    if (!visible) return;
    const handler = () => {
      // Guard against re-entry: onRefresh emits bitcoin:refresh to update the
      // main-screen balance hook, and we re-subscribe to bitcoin:refresh for
      // external triggers — without this flag the two would loop.
      if (selfRefreshingRef.current) return;
      try {
        onRefresh();
      } catch {}
    };
    const offBitcoin = EventBus.on("bitcoin:refresh", handler);
    const offTx = EventBus.on("transactions:refresh", handler);
    return () => {
      try {
        offBitcoin();
      } catch {}
      try {
        offTx();
      } catch {}
    };
  }, [visible, onRefresh]);

  // On-chain rows carry the address they were read for, and that address is
  // what decides the rail: the boarding address belongs to the arkade wallet
  // (deposits on their way in), the MuSig2 addresses to the on-chain one. The
  // fetch returns all of them, so filtering by rail without looking at the
  // address emptied the arkade list of its boarding history. One shared list
  // for the renderer and the CSV export, so both show the same rows.
  const railTxs = useMemo(
    () =>
      (txs ?? []).filter(({ address: txAddress }) => {
        if (!rail) return true;
        if (railAddresses.size === 0) return true;
        // A row belongs here exactly when it was read for one of this rail's
        // addresses — boarding for arkade, the MuSig2 address for on-chain.
        return railAddresses.has(
          String(txAddress || "")
            .trim()
            .toLowerCase(),
        );
      }),
    [txs, rail, railAddresses],
  );

  // A display-currency switch needs every row's historical price in the new
  // currency; the list prefetch only read the one selected at the time.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-price on a currency switch only, not on every row update
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const stamps: number[] = [];
    for (const atx of arkadeTxs) {
      if (atx.status === "confirmed" && atx.timestamp)
        stamps.push(Math.floor(atx.timestamp / 1000));
    }
    for (const { tx } of railTxs) {
      if (tx?.status?.block_time) stamps.push(tx.status.block_time);
    }
    if (stamps.length === 0) return;
    void priceService
      .getPriceForBatch(stamps, homeSym)
      .catch(() => {})
      .then(() => {
        if (!cancelled) setPricesVersion((v) => v + 1);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, homeSym]);

  // A leg of a swap reads as the other side of it: "From Euro", "To Dollar".
  const swapLegs = useSwapLegs(visible);
  const items = useMemo(() => {
    const list: ActivityItem[] = [];
    // Sats that are in the wallet but cannot be spent yet: a VTXO still being
    // finalized, or one settled so recently that the server refuses to settle
    // it again. They are deliberately out of the headline balance (a balance
    // that cannot be sent is a lie), and they have no history row of their own
    // — the change of a send is not a receive — so without this row the money
    // simply looks gone.
    // Arkade's own unspendable sats. The on-chain wallet has no VTXOs, so this
    // row has no business in its list.
    const pendingVtxoSats =
      rail === "onchain"
        ? 0
        : Math.max(
            0,
            Math.trunc(
              Number(getArkadeWalletSummarySnapshot()?.debugPendingVtxoTotalSats || 0) || 0,
            ),
          );
    if (pendingVtxoSats > 0) {
      list.push({
        key: "pending-vtxo-balance",
        icon: "plus",
        label: t("screen.BitcoinTransactionsModal.pendingBalanceLabel"),
        sublabel: t("common.pending"),
        amount: `BTC ${groupCount(pendingVtxoSats)}`,
        pending: true,
        createdAt: new Date().toISOString(),
      });
    }
    // Money in flight on this rail, from the one list every screen reads. A
    // send the chain history already lists is shown once, by that row.
    for (const row of unsettledInFlight(inFlight, bitcoinSettledRefs(arkadeTxs, railTxs))) {
      list.push(
        inFlightActivityItem(row, {
          statusText: getSwapKitV2StatusMessage(row.record.id),
          onOpenOrder: setDetailOrderId,
        }),
      );
    }

    // Arkade transactions (off-chain, lightning, boarding)
    if (rail !== "onchain" && arkadeTxs.length > 0) {
      for (const atx of arkadeTxs) {
        const isIncoming = atx.type === "received";
        const sign = isIncoming ? "" : "-";
        // Anything not finalized stays pending: Arkade may reject a fresh
        // preconfirmed VTXO when a spend requires settlement.
        const isPending = atx.status !== "confirmed";
        const unixSeconds = atx.timestamp ? Math.floor(atx.timestamp / 1000) : null;
        const timeStr = formatActivityTime(null, unixSeconds);
        const subtitle = isPending ? "Pending" : timeStr;
        const title = isIncoming ? "Received Bitcoin" : "Send Bitcoin";

        let fiatLine: string | null = null;
        if (!isPending && unixSeconds) {
          const fiatPrice = priceService.getCachedPriceAt(unixSeconds, homeSym);
          if (typeof fiatPrice === "number") {
            const fiatValue = (atx.amountSats / 1e8) * fiatPrice;
            fiatLine = `${sign}${homeSym} ${fiatValue.toFixed(2)}`;
          }
        }

        const _createdAt = atx.timestamp
          ? new Date(atx.timestamp).toISOString()
          : new Date().toISOString();
        const swap = swapRow(swapLegs, atx.id, isIncoming);
        list.push({
          key: atx.id,
          icon: atx.isMigrationTx ? "transfer-horizontal" : isIncoming ? "plus" : "arrow-up",
          sublabel: subtitle,
          label: atx.isMigrationTx ? "Migration" : (swap?.title ?? title),
          ...(swap?.image ? { image: swap.image } : {}),
          ...(swap?.sides ? { swap: swap.sides } : {}),
          amount: `${sign}BTC ${atx.amountSats}`,
          amountSecondary: fiatLine ?? `${homeSym} —`,
          pending: isPending,
          createdAt: _createdAt,
          incoming: isIncoming,
          counterpartyScripts: atx.counterpartyScripts,
        });
      }
    }

    const sortPendingFirst = (rows: ActivityItem[]): ActivityItem[] => {
      return [...rows].sort((a, b) => {
        const aPending = a.pending === true;
        const bPending = b.pending === true;
        if (aPending !== bPending) return aPending ? -1 : 1;
        const aTime = Date.parse(String(a.createdAt || ""));
        const bTime = Date.parse(String(b.createdAt || ""));
        const aScore = Number.isFinite(aTime) ? aTime : 0;
        const bScore = Number.isFinite(bTime) ? bTime : 0;
        return bScore - aScore;
      });
    };

    if (railTxs.length === 0) return sortPendingFirst(list);
    const mempoolLabel = t("component.ActivityRowActions.viewOnMempool");
    const mapped = railTxs.map(({ tx: t, address: txAddress }) => {
      const isPending = !t?.status?.confirmed;
      const display = classifyTransaction(t, txAddress);
      const isIncoming = display.isIncoming;
      const amountSats = display.amountSats;

      const blockTime = t?.status?.block_time;
      const txTime = formatActivityTime(null, blockTime);
      const subtitle = isPending ? "Pending" : txTime;
      const title = isIncoming ? "Received Bitcoin" : "Send Bitcoin";
      const _createdAt = blockTime
        ? new Date(blockTime * 1000).toISOString()
        : new Date().toISOString();

      const onOpenExplorer = () => {
        const url = `${mempoolTxUrl(t.txid)}?mode=details`;
        Linking.openURL(url);
      };

      const sign = isIncoming ? "" : "-";
      let fiatLine: string | null = null;
      if (!isPending && t?.status?.block_time) {
        const fiatPrice = priceService.getCachedPriceAt(t.status?.block_time as number, homeSym);
        if (typeof fiatPrice === "number") {
          const fiatValue = (amountSats / 1e8) * fiatPrice;
          fiatLine = `${sign}${homeSym} ${fiatValue.toFixed(2)}`;
        }
      }

      // Who a send paid: its one output that is not this wallet's own. A send
      // with several such outputs names no single recipient to save.
      const paidTo = isIncoming
        ? []
        : (t.vout || [])
            .map((o: { scriptpubkey_address?: string }) => o?.scriptpubkey_address || "")
            // Never the wallet's own addresses: a transfer between its rails
            // (or change) has no recipient to save.
            .filter((a: string) => a && a !== txAddress && !railAddresses.has(a.toLowerCase()));
      // A swap's deposit address is the swap, never someone to save.
      const swap = swapRow(swapLegs, t.txid, isIncoming);
      const recipient = paidTo.length === 1 && !swap ? paidTo[0] : null;
      return {
        // Address-scoped: a transfer between the two on-chain rails appears in
        // both histories, once as a send and once as a receive.
        key: `${txAddress}:${t.txid}`,
        icon: isIncoming ? "plus" : "arrow-up",
        sublabel: subtitle,
        label: swap?.title ?? title,
        ...(swap?.image ? { image: swap.image } : {}),
        ...(swap?.sides ? { swap: swap.sides } : {}),
        onPress: onOpenExplorer,
        onPressLabel: mempoolLabel,
        saveOffer: recipient
          ? { destination: { type: "crypto", raw: recipient, network: "bitcoin", asset: "BTC" } }
          : null,
        amount: `${sign}BTC ${amountSats}`,
        amountSecondary: fiatLine ?? `${homeSym} —`,
        pending: isPending,
        createdAt: _createdAt,
        incoming: isIncoming,
      } satisfies ActivityItem;
    });
    return sortPendingFirst(list.concat(mapped));
  }, [railTxs, pricesVersion, inFlight, arkadeTxs, rail, homeSym, railAddresses, swapLegs]);

  const exportCsv = useCallback(async () => {
    if (exportingCsv) return;
    // No `address` check: each row carries the address that classifies it, so a
    // MuSig2-only history is still exportable.
    const hasLegacy = Boolean(railTxs.length);
    const hasAnything = hasLegacy || inFlight.length > 0 || arkadeTxs.length > 0;
    if (!hasAnything) return;
    setExportingCsv(true);
    try {
      const priceAt = (unixSeconds: number) => priceService.getCachedPriceAt(unixSeconds, homeSym);
      const rows: string[][] = [];
      // Same rows as the list: a move the history already lists is written once.
      for (const row of unsettledInFlight(inFlight, bitcoinSettledRefs(arkadeTxs, railTxs))) {
        const cells = bitcoinInFlightCsvCells(inFlightCsvRecord(row));
        if (cells) rows.push(cells);
      }
      for (const atx of arkadeTxs) {
        rows.push(bitcoinHistoryCsvCells(arkadeCsvRecord(atx, priceAt), homeSym));
      }
      for (const entry of hasLegacy ? railTxs : []) {
        rows.push(bitcoinHistoryCsvCells(onchainCsvRecord(entry, priceAt), homeSym));
      }
      await shareCsvFile(
        csvDocument(BITCOIN_HISTORY_CSV_HEADER, rows),
        csvFileName("bitcoin-transactions"),
      );
    } catch (e) {
      console.log("[BitcoinTransactionsModal] CSV export failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setExportingCsv(false);
    }
  }, [exportingCsv, railTxs, inFlight, arkadeTxs, homeSym]);

  return (
    <>
      <ActivitySheet
        visible={visible}
        onClose={onClose}
        title={t("screen.BitcoinTransactionsModal.title")}
        items={items}
        loading={loading}
        refreshing={refreshing}
        onRefresh={onRefresh}
        onExport={() => {
          void exportCsv();
        }}
        exportDisabled={exportingCsv || items.length === 0}
        error={error}
      />
      <SwapStatusDetailSheet
        visible={detailOrderId != null}
        orderId={detailOrderId ?? ""}
        onClose={() => setDetailOrderId(null)}
      />
    </>
  );
};

export default BitcoinTransactionsModal;
