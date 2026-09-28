// @screen wallet.transactions
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking } from "react-native";
import { formatActivityTime, withTxTime } from "../../../lib/transactionRowUtils";
import { csvEscape, shareCsvFile } from "../../../lib/csvExport";
import { basescanTxUrl, basescanTokenUrl } from "../../../config/endpoints";
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
import type {
  PendingWalletTransfer,
  WalletTransactionsProps,
  WalletTransactionRow,
} from "../../../types/wallet";
import {
  getSwapKitV2LastView,
  getSwapKitV2StatusMessage,
} from "../../../services/swapkit/SwapKitV2PendingTracker";
import SwapStatusDetailSheet from "../../swapkit/SwapStatusDetailSheet";

// ── Local row helpers ────────────────────────────────────────────────
// Inlined generic row helpers so this wallet screen carries no bank-rail
// dependency. The transaction rows are Base onchain transfers; these operate
// purely on the generic row shape (no IBAN/bank-order logic).
const getOrderState = (o: WalletTransactionRow | null | undefined): string =>
  String(o?.state || "")
    .trim()
    .toLowerCase();

const getOrderDateIso = (o: WalletTransactionRow | null | undefined): string | null => {
  const raw = o?.meta?.placedAt || "";
  // Trim fractional seconds to max 3 digits to avoid Invalid Date in some environments.
  const fixed = typeof raw === "string" ? raw.replace(/\.(\d{3})\d+Z$/, ".$1Z") : "";
  return fixed || raw || null;
};

const formatFiatAmount = (
  raw: string | number | null | undefined,
  currency?: string | null,
): string => {
  if (raw === null || raw === undefined) return "—";
  const value = Number(raw);
  if (!Number.isFinite(value)) return String(raw);
  return `${resolveFiatCode(currency ?? null)} ${value.toFixed(2)}`;
};

// Best single tx hash for the explorer link / CSV export.
const pickOrderTxHash = (o: WalletTransactionRow | null | undefined): string | null => {
  const metaHash = String(o?.meta?.txHash || "").trim();
  if (metaHash) return metaHash;
  const metaHashes = Array.isArray(o?.meta?.txHashes) ? o.meta.txHashes : [];
  for (const h of metaHashes) {
    const trimmed = String(h || "").trim();
    if (trimmed) return trimmed;
  }
  const txs = o?.transactions ?? [];
  for (const tx of txs) {
    const trimmed = String(tx?.hash || "").trim();
    if (trimmed) return trimmed;
  }
  return null;
};

const collectKnownTxHashes = (
  orders: ReadonlyArray<WalletTransactionRow> | null | undefined,
): Set<string> => {
  const out = new Set<string>();
  for (const o of orders || []) {
    const metaHash = String(o?.meta?.txHash || "")
      .trim()
      .toLowerCase();
    if (metaHash) out.add(metaHash);
    const metaHashes = Array.isArray(o?.meta?.txHashes) ? o.meta.txHashes : [];
    for (const h of metaHashes) {
      const trimmed = String(h || "")
        .trim()
        .toLowerCase();
      if (trimmed) out.add(trimmed);
    }
    const txs = o?.transactions ?? [];
    for (const tx of txs) {
      const txHash = String(tx?.hash || "")
        .trim()
        .toLowerCase();
      if (txHash) out.add(txHash);
    }
  }
  return out;
};

const collectKnownOrderIds = (
  orders: ReadonlyArray<WalletTransactionRow> | null | undefined,
): Set<string> => {
  const out = new Set<string>();
  for (const o of orders || []) {
    const id = String(o?.id || o?.meta?.orderId || "")
      .trim()
      .toLowerCase();
    if (id) out.add(id);
  }
  return out;
};

type Props = WalletTransactionsProps;

// One address holds euro and dollar, so a pending row belongs to whichever
// history is showing ITS token. A row that names no asset predates the dollar
// rail and is euro by construction.
const pendingRowFiat = (entry: { fiat?: "EUR" | "USD" }): string =>
  entry.fiat === "USD" ? "USD" : "EUR";

/**
 * The rows the history is made of: the one aggregate "pending balance" entry,
 * then every local pending transfer the server has not echoed back yet, then
 * the settled orders. The screen and the CSV export read the SAME list —
 * building it twice had the export classifying a sweep as a plain transfer.
 */
const buildWalletTransactionRows = (
  orders: WalletTransactionRow[] | null | undefined,
  pendingTransfers: PendingWalletTransfer[] | null | undefined,
  pendingWalletFiat: number,
): WalletTransactionRow[] => {
  const settled = orders ?? [];
  const pendingEffective = Math.max(0, Number.isFinite(pendingWalletFiat) ? pendingWalletFiat : 0);
  const pendingOrder: WalletTransactionRow | null =
    pendingEffective > 0
      ? {
          id: "pending_balance",
          kind: "pending_balance",
          state: "pending",
          amount: String(pendingEffective),
          counterpart: { identifier: {} },
          meta: { placedAt: new Date().toISOString() },
        }
      : null;
  const knownTxHashes = collectKnownTxHashes(settled);
  const knownOrderIds = collectKnownOrderIds(settled);
  const pendingLocal = (pendingTransfers ?? [])
    .filter((entry) => {
      const tx = (entry.txHash || "").toString().trim().toLowerCase();
      const order = (entry.orderId || "").toString().trim().toLowerCase();
      if (tx && knownTxHashes.has(tx)) return false;
      if (order && knownOrderIds.has(order)) return false;
      return true;
    })
    .map(
      (entry, index): WalletTransactionRow => ({
        id: entry.txHash
          ? `pending:${entry.txHash}`
          : entry.orderId
            ? `pending:order:${entry.orderId}`
            : `pending:local:${index}`,
        kind:
          entry.kind === "card_topup"
            ? "card_topup_pending"
            : entry.kind === "bank_transfer"
              ? "bank_transfer_pending"
              : entry.source === "swapkit" ||
                  entry.source === "swapkit_topup" ||
                  entry.source === "swapkit_sweep"
                ? "swapkit_swap_pending"
                : "wallet_transfer_pending",
        state: "pending",
        amount: String(entry.amount),
        // Without this the shared formatter resolves an absent currency to
        // EUR, so a pending dollar transfer reads — and exports — as euros.
        currency: pendingRowFiat(entry),
        counterpart: { identifier: {} },
        meta: {
          placedAt: entry.createdAt,
          txHash: entry.txHash ?? null,
          orderId: entry.orderId ?? null,
          source: entry.source ?? null,
        },
      }),
    );
  return pendingOrder ? [pendingOrder, ...pendingLocal, ...settled] : [...pendingLocal, ...settled];
};

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
      const rawKind: string = (o?.kind || "").toLowerCase();
      const kind = rawKind === "card_topup_swap" ? "wallet_transfer_in" : rawKind;
      const isPendingBalance = kind === "pending_balance";
      const isPendingLocal =
        kind === "wallet_transfer_pending" ||
        kind === "card_topup_pending" ||
        kind === "bank_transfer_pending" ||
        kind === "swapkit_swap_pending";
      // A BTC→EUR topup surfaces here as the euro-incoming (destination) mirror
      // of the Bitcoin-origin row. It shares the swap pending machinery but is
      // incoming (euros arriving), so it renders without a minus sign and never
      // uses the EUR→BTC "≈ BTC sats" framing.
      // A sweep is euros arriving from another chain — same incoming framing as
      // a topup, never the EUR→BTC "≈ BTC sats" one.
      const isTopup =
        isPendingLocal &&
        kind === "swapkit_swap_pending" &&
        (o?.meta?.source === "swapkit_topup" || o?.meta?.source === "swapkit_sweep");
      const isIncoming =
        isPendingBalance ||
        kind === "issue" ||
        kind === "card_topup" ||
        kind === "wallet_transfer_in" ||
        isTopup;
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

      // The column stated euros for every history, including the dollar one.
      // Named after the history it belongs to, and every row still carries its
      // own code — a figure whose currency has to be inferred from a filename is
      // one that will be read as the wrong money.
      const header = [
        "created_at",
        "kind",
        "status",
        "direction",
        "chain_address",
        `amount_${(token?.fiatCode ?? "EUR").toLowerCase()}`,
        "currency",
        "pending",
        "rejected_reason",
        "tx_hash",
        "details_url",
      ];
      const rows = [header.map(csvEscape).join(",")];

      for (const o of list) {
        const kindRaw = (o?.kind || "").toString();
        const kindLower = kindRaw.toLowerCase();
        const kind = kindLower === "card_topup_swap" ? "wallet_transfer_in" : kindLower;
        const isPendingBalance = kind === "pending_balance";
        const isPendingLocal =
          kind === "wallet_transfer_pending" ||
          kind === "card_topup_pending" ||
          kind === "bank_transfer_pending" ||
          kind === "swapkit_swap_pending";
        // A BTC→EUR topup pending row is incoming euros, not an outgoing swap.
        const isTopup = kind === "swapkit_swap_pending" && o?.meta?.source === "swapkit_topup";
        const isIncoming =
          isPendingBalance ||
          kind === "issue" ||
          kind === "card_topup" ||
          kind === "wallet_transfer_in" ||
          isTopup;
        const dir = isIncoming ? "incoming" : "outgoing";

        const chainAddr = isPendingBalance
          ? ""
          : (o?.counterpart?.identifier?.address || "").trim();

        const orderState = getOrderState(o);
        const status = orderState || "";
        const pendingFlag =
          isPendingBalance || isPendingLocal || orderState === "pending" || orderState === "placed";
        const rejectedReason =
          orderState === "rejected" ? String(o?.meta?.rejectedReason || "").trim() : "";

        const amountRaw = o?.amount ?? o?.meta?.amount ?? null;
        const amountNum = Number(amountRaw);
        const amountFiat = Number.isFinite(amountNum)
          ? amountNum.toFixed(2)
          : amountRaw === null || amountRaw === undefined
            ? ""
            : String(amountRaw);

        const txHash = (pickOrderTxHash(o) || "").trim();
        const detailsUrl = txHash
          ? basescanTxUrl(txHash)
          : (() => {
              const acct = (explorerAddress ?? primaryAddress ?? address ?? "").trim();
              return acct ? basescanTokenUrl(BASE_EURC.address, acct) : "";
            })();

        const createdIso = (() => {
          const iso = getOrderDateIso(o) || "";
          return iso ? String(iso) : "";
        })();

        rows.push(
          [
            createdIso,
            kind,
            status,
            dir,
            chainAddr || "",
            amountFiat,
            resolveFiatCode(o?.currency ?? null),
            pendingFlag ? "true" : "false",
            rejectedReason,
            txHash,
            detailsUrl,
          ]
            .map(csvEscape)
            .join(","),
        );
      }

      const csv = rows.join("\n");
      const nowIso = new Date().toISOString().slice(0, 10);
      const fileName = `wallet-transactions-${nowIso}.csv`;
      await shareCsvFile(csv, fileName);
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
