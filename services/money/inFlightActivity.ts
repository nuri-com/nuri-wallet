// An in-flight row as a history-list entry. The history lists (bitcoin, wallet,
// dollar, card) draw their pending entries from the same list the home rails
// do, through this, so a move reads the same everywhere.
import type { ActivityItem } from "../../components/ActivitySheet";
import { groupCount } from "../../lib/formatting";
import { t } from "../../lib/i18n";
import type { InFlightRow } from "./inFlightRows";

export function inFlightActivityItem(
  row: InFlightRow,
  opts: {
    /** Live status for a swap row, when the tracker has one. */
    statusText?: string | null;
    /** Opens the order's detail; only swap rows have one. */
    onOpenOrder?: (orderId: string) => void;
  } = {},
): ActivityItem {
  const sign = row.direction === "out" ? "-" : "+";
  const { amount, unit } = row.leg;
  const figure =
    unit === "sats"
      ? `${sign}BTC ${groupCount(Math.max(0, Math.trunc(amount)))}`
      : `${sign}${unit} ${amount.toFixed(2)}`;
  const isOrder = row.record.kind === "swap" && !row.record.id.startsWith("pending:");
  return {
    key: row.key,
    icon: row.direction === "out" ? "arrow-up" : "plus",
    label: t(`screen.HomeScreen.${row.label}`),
    sublabel: opts.statusText || t("common.pending"),
    amount: figure,
    amountSecondary: "",
    ...(isOrder && opts.onOpenOrder ? { onPress: () => opts.onOpenOrder?.(row.record.id) } : {}),
    pending: true,
    createdAt: row.record.createdAt,
  };
}
