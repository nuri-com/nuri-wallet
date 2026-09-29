// @screen wirex.cardTransactions
// Wirex merged activity feed. Loads card transactions + bank/SEPA +
// onchain deposits via WirexService.getActivityFeed (already mapped to
// ActivityItem rows and sorted newest-first) and renders them in the DS
// ActivitySheet, which owns the month grouping. Bank rows with a known
// counterparty IBAN are tappable → `onSendAgain` (prefilled SEPA send).
import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import ActivitySheet, { type ActivityItem } from "../../components/ActivitySheet";
import { shareCsvFile } from "../../lib/csvExport";
import { csvDocument, csvFileName } from "../../lib/csv";
import { t } from "../../lib/i18n";
import type { WirexBankCounterparty } from "../../lib/wirex/cardTransactions";
import { wirexService } from "../../services/wirex/WirexService";
import { getSwapKitV2StatusMessage } from "../../services/swapkit/SwapKitV2PendingTracker";
import { useInFlightRows } from "../../services/money/useInFlightRows";
import { inFlightActivityItem } from "../../services/money/inFlightActivity";
import { WIREX_ACTIVITY_CSV_HEADER, wirexActivityCsvCells } from "../../services/export/wirexRows";
import SwapStatusDetailSheet from "../swapkit/SwapStatusDetailSheet";

type Props = {
  visible: boolean;
  onClose: () => void;
  wallet: string | null;
  /** Tap on a bank row with a known counterparty IBAN → send-again flow. */
  onSendAgain?: (counterparty: WirexBankCounterparty) => void;
  /** Narrows the feed to specific rails. Omitted = the whole account. */
  rails?: Array<"card" | "bank" | "deposits">;
};

const WirexCardTransactionsModal: React.FC<Props> = ({
  visible,
  onClose,
  wallet,
  onSendAgain,
  rails,
}) => {
  const [items, setItems] = useState<ActivityItem[]>([]);
  // The detail sheet's state is declared BEFORE the memo that names its setter.
  // The memo's callback runs in the render that reaches it, so a `const`
  // declared further down is still uninitialized there: reading it throws
  // ("Cannot access 'setDetailOrderId' before initialization") and the
  // uncaught error takes the whole tree down — the blank screen of #1480.
  const [detailOrderId, setDetailOrderId] = useState<string | null>(null);
  // The IBAN statement lists only what leaves by bank transfer; the card
  // lists everything moving on either pocket.
  const inFlight = useInFlightRows(["visa", "visaUsd"]);
  const pendingRows = useMemo(
    () =>
      inFlight
        .filter((row) => !rails || rails.includes("deposits") || row.record.kind === "sepa")
        .map((row) =>
          inFlightActivityItem(row, {
            statusText: getSwapKitV2StatusMessage(row.record.id),
            onOpenOrder: setDetailOrderId,
          }),
        ),
    [inFlight, rails],
  );
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [exportingCsv, setExportingCsv] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (mode: "initial" | "refresh") => {
      if (!wallet) return;
      if (mode === "refresh") setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const feed = await wirexService.getActivityFeed(wallet, onSendAgain, rails);
        setItems(feed);
      } catch {
        setError(t("screen.CardTransactionsModal.errorDefault"));
      } finally {
        if (mode === "refresh") setRefreshing(false);
        else setLoading(false);
      }
    },
    [wallet, onSendAgain, rails],
  );

  useEffect(() => {
    if (visible) void load("initial");
  }, [visible, load]);

  // The feed rows are already display-formatted; the CSV mirrors what the
  // user sees (statement-style), one row per activity item.
  const exportCsv = useCallback(async () => {
    if (exportingCsv || items.length === 0) return;
    setExportingCsv(true);
    try {
      await shareCsvFile(
        csvDocument(WIREX_ACTIVITY_CSV_HEADER, items.map(wirexActivityCsvCells)),
        csvFileName("card-transactions"),
      );
    } catch (e) {
      console.log("[WirexCardTransactionsModal] CSV export failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setExportingCsv(false);
    }
  }, [exportingCsv, items]);

  return (
    <>
      <ActivitySheet
        visible={visible}
        onClose={onClose}
        title="Card Activity"
        items={pendingRows.length > 0 ? [...pendingRows, ...items] : items}
        loading={loading}
        refreshing={refreshing}
        onRefresh={() => {
          void load("refresh");
        }}
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

export default WirexCardTransactionsModal;
