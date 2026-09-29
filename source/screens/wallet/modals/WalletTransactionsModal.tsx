// @screen wallet.transactions
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking } from "react-native";
import { formatActivityTime, withTxTime } from "../../../lib/transactionRowUtils";
import { shareCsvFile } from "../../../lib/csvExport";
import { csvDocument, csvFileName } from "../../../lib/csv";
import { basescanTxUrl, basescanTokenUrl } from "../../../config/endpoints";
import {
  buildWalletTransactionRows,
  classifyWalletRow,
  getOrderDateIso,
  getOrderState,
  pickOrderTxHash,
} from "../../../services/balance/transactions/walletHistoryRows";
import {
  walletCsvRecord,
  walletHistoryCsvCells,
  walletHistoryCsvHeader,
} from "../../../services/export/walletRows";
import { BASE_EURC } from "../../../config/network";
import ActivitySheet, { type ActivityItem } from "../../../components/ActivitySheet";
import { EventBus } from "../../../services/events/AppEventBusService";
import { getCacheValue } from "../../../services/balance/TransactionCacheService";
import { withCacheBuster } from "../../../lib/url";
import { getWalletTransactionsDbCacheKey } from "../../../services/balance/transactions/cacheKeys";
import { fetchWalletTransactions } from "../../../services/balance/transactions/walletTransactions";
import { maskAddress } from "../../../lib/mask";
import { resolveFiatCode } from "../../../lib/tokens";
import { t } from "../../../lib/i18n";
import { isEvmTxHash } from "../../../lib/validation";
import type { WalletTransactionsProps, WalletTransactionRow } from "../../../types/wallet";
import {
  getSwapKitV2LastView,
  getSwapKitV2StatusMessage,
} from "../../../services/swapkit/SwapKitV2PendingTracker";
import SwapStatusDetailSheet from "../../swapkit/SwapStatusDetailSheet";

// Display-only: the amount as the sheet prints it.
const formatFiatAmount = (
  raw: string | number | null | undefined,
  currency?: string | null,
): string => {
  if (raw === null || raw === undefined) return "—";
  const value = Number(raw);
  if (!Number.isFinite(value)) return String(raw);
  return `${resolveFiatCode(currency ?? null)} ${value.toFixed(2)}`;
};

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

  const items = useMemo(() => {
    const list = buildWalletTransactionRows(orders, pendingTransfers, pendingWalletFiat);
    console.log("[WalletTxModal] building items", {
      ordersCount: orders.length,
      totalList: list.length,
    });
    if (!list || list.length === 0) {
      return [] as ActivityItem[];
    }
    return list.map((o): ActivityItem => {
      // A BTC→EUR topup surfaces here as the euro-incoming (destination) mirror
      // of the Bitcoin-origin row. It shares the swap pending machinery but is
      // incoming (euros arriving), so it renders without a minus sign and never
      // uses the EUR→BTC "≈ BTC sats" framing. A sweep is euros arriving from
      // another chain — same incoming framing.
      const { kind, isPendingBalance, isPendingLocal, isTopup, isIncoming } = classifyWalletRow(o);
      // Onchain rows carry only a counterparty address (no IBAN/name).
      const chainAddr = isPendingBalance ? "" : (o?.counterpart?.identifier?.address || "").trim();
      const isCard =
        (o?.meta?.source === "onchain_card" || kind.startsWith("card_")) &&
        kind !== "wallet_transfer_in";
      let displayName = chainAddr ? "Wallet" : "";
      const isWalletTransferOut = kind === "wallet_transfer_out";
      if (isCard || kind === "card_topup_pending") {
        displayName = kind === "card_withdrawal" ? "Card Transfer" : "Card Top-Up";
      }
      if (isPendingBalance) {
        displayName = "Top-up";
      }
      if (isPendingLocal && kind === "wallet_transfer_pending") {
        displayName = "Wallet Transfer";
      }
      if (isPendingLocal && kind === "bank_transfer_pending") {
        displayName = "Bank Transfer";
      }
      // Pending swap rows stay compact (Emin): euro amount + "≈ BTC <sats>" —
      // never the word sats, always the bitcoin symbol. Route/provider detail
      // lives in the show-more sheet.
      const swapLastStatus =
        isPendingLocal && kind === "swapkit_swap_pending"
          ? getSwapKitV2LastView(String(o?.meta?.orderId || ""))
          : null;
      if (isPendingLocal && kind === "swapkit_swap_pending") {
        displayName = isTopup ? t("screen.WalletTransactionsModal.topUp") : "SwapKit EUR → BTC";
      }
      if (isWalletTransferOut) {
        displayName = "Wallet";
      }
      const title =
        isPendingBalance || isPendingLocal
          ? displayName
          : `${isIncoming ? "From" : "To"} ${displayName}`;
      const dateIso = getOrderDateIso(o);
      const extra =
        isPendingBalance || isPendingLocal
          ? ""
          : isCard
            ? ""
            : chainAddr
              ? maskAddress(chainAddr)
              : "";
      const txTime = formatActivityTime(dateIso);
      // "≈ BTC 36326": quoted receive amount in sats, BTC symbol, no word "sats".
      const swapSats =
        !isTopup &&
        swapLastStatus &&
        String((swapLastStatus.accepted as { to?: string } | undefined)?.to || "").startsWith("BTC")
          ? Math.round(
              Number(
                (swapLastStatus.execution as { settleAmount?: string } | undefined)?.settleAmount,
              ) * 100_000_000,
            )
          : 0;
      let subtitle = isPendingBalance
        ? "Pending availability"
        : isPendingLocal
          ? (kind === "swapkit_swap_pending" &&
              (swapSats > 0
                ? `≈ BTC ${swapSats}`
                : getSwapKitV2StatusMessage(String(o?.meta?.orderId || "")))) ||
            "Pending broadcast"
          : withTxTime(txTime, extra);
      const orderState = getOrderState(o);
      const isPending = orderState === "pending" || orderState === "placed";
      const isRejected = orderState === "rejected";
      const rejectedReason = isRejected ? String(o?.meta?.rejectedReason || "").trim() : "";
      if (isRejected && !isPendingBalance && !isPendingLocal) {
        const reason = rejectedReason || t("screen.WalletTransactionsModal.statusRejected");
        subtitle = withTxTime(txTime, reason);
      } else if (isPending && !isPendingBalance && !isPendingLocal) {
        subtitle = subtitle ? `Pending · ${subtitle}` : "Pending";
      }
      // For a live swap show what actually leaves the wallet (leg 0 deposit
      // incl. provider fee), not the nominal quote amount.
      const swapDeposit = Number(
        (swapLastStatus?.execution as { depositAmount?: string } | undefined)?.depositAmount,
      );
      const amount =
        swapSats > 0 && Number.isFinite(swapDeposit) && swapDeposit > 0
          ? swapDeposit
          : (o?.amount ?? o?.meta?.amount ?? null);
      const amountFiat = formatFiatAmount(amount, o?.currency);
      const amountText = Number(amount) > 0 && !isIncoming ? `-${amountFiat}` : amountFiat;

      const onOpenExplorer = () => {
        const txHash = pickOrderTxHash(o) || "";
        if (txHash && isEvmTxHash(txHash)) {
          Linking.openURL(withCacheBuster(basescanTxUrl(txHash))).catch(() => {});
          return;
        }
        const acct = (explorerAddress ?? primaryAddress ?? address ?? "").trim();
        if (!acct) return;
        Linking.openURL(withCacheBuster(basescanTokenUrl(BASE_EURC.address, acct))).catch(() => {});
      };

      const handlePress = () => {
        // A pending swap row opens the live "where is my money?" detail sheet.
        if (kind === "swapkit_swap_pending") {
          const orderId = String(o?.meta?.orderId || "");
          if (orderId) setDetailOrderId(orderId);
          return;
        }
        if (isPendingBalance || isPendingLocal) return;
        onOpenExplorer();
      };

      return {
        key: o?.id ?? `${kind}-${dateIso ?? ""}`,
        icon: isRejected
          ? "cross"
          : kind === "swapkit_swap_pending"
            ? "transfer-horizontal"
            : isIncoming
              ? "plus"
              : "arrow-up",
        sublabel: subtitle,
        label: title,
        onPress: handlePress,
        amount: amountText,
        pending: (isPendingBalance || isPendingLocal || isPending) && !isRejected,
        createdAt: dateIso || undefined,
      };
    });
  }, [orders, pendingWalletFiat, pendingTransfers, address, explorerAddress, primaryAddress]);

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
        title="Cash Activity"
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
