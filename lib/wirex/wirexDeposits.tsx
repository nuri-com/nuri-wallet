import type { ActivityItem } from "../../components/ActivitySheet";
import type { WalletTransactionRow } from "../../types/wallet";
import { resolveFiatCode } from "../tokens";
import {
  EURC_SCAN_TOKEN,
  USDC_SCAN_TOKEN,
  fetchOnchainWalletTransfers,
} from "../../services/balance/transactions/onchainScan";
import type { FxRates } from "../../services/pricing/FxRateService";
import { t } from "../i18n";
import { formatActivityTime } from "../transactionRowUtils";
import { eurSubtitle, wirexFiatCode } from "./cardTransactions";

// Local date/amount row helpers for the wallet transaction layer.
const normalizeIsoMillis = (s?: string | null): string | null => {
  if (!s || typeof s !== "string") return null;
  return s.replace(/\.(\d{3})\d+Z$/, ".$1Z");
};
const getOrderDateIso = (o: WalletTransactionRow | null | undefined): string | null => {
  const raw = o?.meta?.placedAt || "";
  const fixed = normalizeIsoMillis(raw);
  return fixed || raw || null;
};
const formatFiatAmount = (
  raw: string | number | null | undefined,
  currency?: string | null,
): string => {
  if (raw === null || raw === undefined) return "—";
  const value = Number(raw);
  if (!Number.isFinite(value)) return String(raw);
  const symbol = resolveFiatCode(currency ?? null);
  return `${symbol} ${value.toFixed(2)}`;
};

const LOG_TAG = "[WirexDeposits]";

/**
 * Fetch incoming onchain deposits into the Wirex smart-account (AA) address and
 * map them to `ActivityItem` rows (title "Cash deposit", credited
 * amount with its fiat symbol, inbound/positive — no minus sign).
 */
export async function fetchWirexDeposits(
  aaAddress: string,
  rates?: FxRates,
): Promise<ActivityItem[]> {
  const addr = String(aaAddress || "").trim();
  if (!addr) return [];

  // The card holds euros AND dollars at one address, so the token — not the
  // address — separates them. Scanning only EURC is how a dollar top-up landed
  // on the card and showed up in no history at all. Settled independently: one
  // token's scan failing must not hide the other's rows.
  const scans = await Promise.allSettled(
    [EURC_SCAN_TOKEN, USDC_SCAN_TOKEN].map((token) =>
      // selfFilterAddrs drops self-transfers; rows keep their raw
      // `wallet_transfer_in`/`_out` kind (no card_topup/withdrawal retagging).
      fetchOnchainWalletTransfers({ walletAddrs: [addr], selfFilterAddrs: [addr], token }),
    ),
  );
  const rows: WalletTransactionRow[] = [];
  for (const scan of scans) {
    if (scan.status === "fulfilled") rows.push(...scan.value);
    else
      console.log(`${LOG_TAG} scan failed`, {
        message: scan.reason instanceof Error ? scan.reason.message : "unknown",
      });
  }

  return rows
    .filter((row) => String(row?.kind || "") === "wallet_transfer_in")
    .map((row): ActivityItem => {
      const code = wirexFiatCode({ amount: Number(row.amount), currency: row.currency });
      return {
        icon: "plus",
        label: t("screen.WirexCard.depositRowTitle"),
        sublabel: formatActivityTime(getOrderDateIso(row) ?? undefined),
        // Credited to the card wallet → shown positive (no minus), like card refunds.
        amount: formatFiatAmount(row.amount, row.currency),
        amountSecondary: eurSubtitle(Number(row.amount), code, "", rates),
        key: row.id,
        createdAt: getOrderDateIso(row) ?? undefined,
      };
    });
}
