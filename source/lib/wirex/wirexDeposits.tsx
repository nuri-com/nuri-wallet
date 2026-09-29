import type { ActivityItem } from "../../components/ActivitySheet";
import type { WalletTransactionRow } from "../../types/wallet";
import { type FiatCode, resolveFiatCode } from "../tokens";
import {
  EURC_SCAN_TOKEN,
  USDC_SCAN_TOKEN,
  fetchOnchainWalletTransfers,
} from "../../services/balance/transactions/onchainScan";
import { getOrderDateIso } from "../../services/balance/transactions/walletHistoryRows";
import type { FxRates } from "../../services/pricing/FxRateService";
import { t } from "../i18n";
import { formatActivityTime } from "../transactionRowUtils";
import { homeSubtitle, wirexFiatCode } from "./cardTransactions";

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
 * The incoming onchain deposits into the Wirex smart-account (AA) address, as
 * raw wallet rows (`wallet_transfer_in`). EURC and USDC are scanned
 * independently: one token's scan failing must not hide the other's rows.
 * Rejects only when every scan failed, so a caller can tell "no deposits" from
 * "could not read them".
 */
export async function fetchWirexDepositRows(
  aaAddress: string,
  opts: { requireAll?: boolean } = {},
): Promise<WalletTransactionRow[]> {
  const addr = String(aaAddress || "").trim();
  if (!addr) return [];

  // The card holds euros AND dollars at one address, so the token — not the
  // address — separates them. Scanning only EURC is how a dollar top-up landed
  // on the card and showed up in no history at all.
  const scans = await Promise.allSettled(
    [EURC_SCAN_TOKEN, USDC_SCAN_TOKEN].map((token) =>
      // selfFilterAddrs drops self-transfers; rows keep their raw
      // `wallet_transfer_in`/`_out` kind (no card_topup/withdrawal retagging).
      fetchOnchainWalletTransfers({
        walletAddrs: [addr],
        selfFilterAddrs: [addr],
        token,
        // The export must see a failed scan, not the cached rows standing in.
        strict: opts.requireAll,
      }),
    ),
  );
  const rows: WalletTransactionRow[] = [];
  let failed = 0;
  for (const scan of scans) {
    if (scan.status === "fulfilled") rows.push(...scan.value);
    else {
      failed += 1;
      console.log(`${LOG_TAG} scan failed`, {
        message: scan.reason instanceof Error ? scan.reason.message : "unknown",
      });
    }
  }
  // The activity sheet shows whichever token loaded; the export needs both.
  if (failed === scans.length || (opts.requireAll && failed > 0)) {
    throw new Error("wirex deposit scan failed");
  }
  return rows.filter((row) => String(row?.kind || "") === "wallet_transfer_in");
}

/**
 * Fetch incoming onchain deposits into the Wirex smart-account (AA) address and
 * map them to `ActivityItem` rows (title "Cash deposit", credited
 * amount with its fiat symbol, inbound/positive — no minus sign).
 */
export async function fetchWirexDeposits(
  aaAddress: string,
  rates?: FxRates,
  home: FiatCode = "EUR",
): Promise<ActivityItem[]> {
  const rows = await fetchWirexDepositRows(aaAddress).catch((): WalletTransactionRow[] => []);
  return rows.map((row): ActivityItem => {
    const code = wirexFiatCode({ amount: Number(row.amount), currency: row.currency });
    return {
      icon: "plus",
      label: t("screen.WirexCard.depositRowTitle"),
      sublabel: formatActivityTime(getOrderDateIso(row) ?? undefined),
      // Credited to the card wallet → shown positive (no minus), like card refunds.
      amount: formatFiatAmount(row.amount, row.currency),
      amountSecondary: homeSubtitle(Number(row.amount), code, "", rates, home),
      key: row.id,
      createdAt: getOrderDateIso(row) ?? undefined,
    };
  });
}
