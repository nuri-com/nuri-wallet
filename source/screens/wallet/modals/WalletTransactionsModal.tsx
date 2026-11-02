// @screen wallet.transactions
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { shareCsvFile } from "../../../lib/csvExport";
import { csvDocument, csvFileName } from "../../../lib/csv";
import { buildWalletTransactionRows } from "../../../services/balance/transactions/walletHistoryRows";
import {
  walletCsvRecord,
  walletHistoryCsvCells,
  walletHistoryCsvHeader,
} from "../../../services/export/walletRows";
import { BASE_EURC } from "../../../config/network";
import ActivitySheet, { type ActivityItem } from "../../../components/ActivitySheet";
import { EventBus } from "../../../services/events/AppEventBusService";
import { getCacheValue } from "../../../services/balance/TransactionCacheService";
import { getWalletTransactionsDbCacheKey } from "../../../services/balance/transactions/cacheKeys";
import { fetchWalletTransactions } from "../../../services/balance/transactions/walletTransactions";
import { t } from "../../../lib/i18n";
import type { WalletTransactionsProps, WalletTransactionRow } from "../../../types/wallet";
import SwapStatusDetailSheet from "../../swapkit/SwapStatusDetailSheet";
import { useSwapLegs } from "../../../services/swapkit/swapActivity";
import { walletActivityItems } from "../../../services/balance/transactions/walletActivityItems";

type Props = WalletTransactionsProps;

const WalletTransactionsModal: React.FC<Props> = ({
  visible,
  onClose,
  address,
  token,
  primaryAddress,
  secondaryAddress,
  explorerAddress,
  pendingTransfers,
  onSendAgain,
}) => {
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orders, setOrders] = useState<WalletTransactionRow[]>([]);
  const [pendingWalletFiat, setPendingWalletFiat] = useState(0);
  const [exportingCsv, setExportingCsv] = useState(false);
  // Pending swap row tapped → live "where is my money?" sheet for that order.
  const [detailOrderId, setDetailOrderId] = useState<string | null>(null);
  const isFirstRender = useRef(true);
  const dbCacheKey = useMemo(
    () =>
      getWalletTransactionsDbCacheKey(primaryAddress, secondaryAddress, address, token?.fiatCode),
    [primaryAddress, secondaryAddress, address, token?.fiatCode],
  );

  const fetchAll = useCallback(
    async (options?: { silent?: boolean }) => {
      setError(null);
      if (!options?.silent) {
        setLoading(true);
      }
      try {
        const result = await fetchWalletTransactions({
          primaryAddress,
          secondaryAddress,
          address,
          token,
        });
        if (Array.isArray(result.orders)) {
          setOrders(result.orders);
        }
        setPendingWalletFiat(result.pendingWalletFiat);
        if (result.error) {
          setError(result.error);
        }
      } catch {
      } finally {
        if (!options?.silent) {
          setLoading(false);
        }
        setRefreshing(false);
      }
    },
    // The token is part of WHICH history this is: switching rails must refetch,
    // not reuse the other rail's rows.
    [primaryAddress, secondaryAddress, address, token],
  );

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      if (!visible) {
        return;
      }
    }
    if (!visible) return;
    console.log("[WalletTxModal] visible, fetching", {
      primaryAddress,
      secondaryAddress,
      address,
    });
    let cancelled = false;
    void (async () => {
      if (dbCacheKey) {
        try {
          const cached = await getCacheValue<WalletTransactionRow[]>(dbCacheKey);
          if (!cancelled && cached) {
            const rows = cached.filter((row): row is WalletTransactionRow => !!row);
            console.log("[WalletTxModal] loaded from cache", { count: rows.length });
            setOrders(rows);
          }
        } catch {}
      }
      if (!cancelled) {
        try {
          EventBus.emit("wallet:refresh");
        } catch {}
        void fetchAll();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, fetchAll, dbCacheKey, primaryAddress, secondaryAddress, address]);

  // External event trigger to refresh when visible
  useEffect(() => {
    const off = EventBus.on("transactions:refresh", () => {
      if (visible) {
        try {
          void fetchAll({ silent: true });
        } catch {}
      }
    });
    return off;
  }, [visible, fetchAll]);

  const onRefresh = () => {
    setRefreshing(true);
    try {
      EventBus.emit("wallet:refresh");
    } catch {}
    return fetchAll();
  };

  const swapLegs = useSwapLegs(visible);
  const items = useMemo(() => {
    const list = buildWalletTransactionRows(orders, pendingTransfers, pendingWalletFiat);
    console.log("[WalletTxModal] building items", {
      ordersCount: orders.length,
      totalList: list.length,
    });
    if (!list || list.length === 0) {
      return [] as ActivityItem[];
    }
    return walletActivityItems(list, {
      primaryAddress,
      address,
      explorerAddress,
      swapLegs,
      onOpenOrder: setDetailOrderId,
      onSendAgain,
    });
  }, [
    orders,
    pendingWalletFiat,
    pendingTransfers,
    address,
    explorerAddress,
    primaryAddress,
    swapLegs,
    onSendAgain,
  ]);

  const exportCsv = useCallback(async () => {
    if (exportingCsv) return;
    if (
      (!orders || orders.length === 0) &&
      (!pendingTransfers || pendingTransfers.length === 0) &&
      pendingWalletFiat <= 0
    ) {
      return;
    }
    setExportingCsv(true);
    try {
      const list = buildWalletTransactionRows(orders, pendingTransfers, pendingWalletFiat);
      if (!list || list.length === 0) return;
      const ctx = {
        explorerToken: BASE_EURC.address,
        explorerAccount: explorerAddress ?? primaryAddress ?? address,
      };
      await shareCsvFile(
        csvDocument(
          walletHistoryCsvHeader(token?.fiatCode ?? "EUR"),
          list.map((o) => walletHistoryCsvCells(walletCsvRecord(o, ctx))),
        ),
        csvFileName("wallet-transactions"),
      );
    } catch (e) {
      console.log("[WalletTxModal] CSV export failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setExportingCsv(false);
    }
  }, [
    exportingCsv,
    orders,
    pendingTransfers,
    token?.fiatCode,
    pendingWalletFiat,
    address,
    primaryAddress,
    explorerAddress,
  ]);

  return (
    <>
      <ActivitySheet
        visible={visible}
        onClose={onClose}
        title={t("screen.WalletTransactionsModal.title")}
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

export default WalletTransactionsModal;
