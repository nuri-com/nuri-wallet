import type { ActivityItem } from "../../components/ActivitySheet";
import { t } from "../i18n";
import { resolveFiatCode, type FiatCode } from "../tokens";
import { formatActivityTime, withTxTime } from "../transactionRowUtils";
import type { FxRates } from "../../services/pricing/FxRateService";
import { convertFiat } from "../currency/displayFiat";

// ── Wirex activity-feed shapes (subset of `ActivityItemResponse` we render) ──

export interface WirexActivityAmount {
  amount: number;
  currency?: string; // ISO 4217 — present for fiat assets only
  token_symbol?: string; // present for crypto assets only
  token_address?: string;
}

export interface WirexActivitySubject {
  type: string; // "Cards" | "Merchant" | "ExternalCard" | "Wallet" | …
  merchant?: { name?: string; mcc?: string } | null;
  card?: { pan_last?: string } | null;
  // Bank-rail counterparty (SEPA/AchPush/…): present on `/bank/transactions`
  // items. Field names pinned against a live payload (2026-07-15):
  // bank_account = { iban, bic, owner_name, is_business }. The older
  // holder_name/name candidates stay as defensive fallbacks.
  name?: string | null;
  bank_account?: {
    iban?: string | null;
    bic?: string | null;
    owner_name?: string | null;
    is_business?: boolean | null;
    name?: string | null;
    holder_name?: string | null;
  } | null;
}

export interface WirexActivityOperation {
  operation_reason?: string; // "Authorization" | "Clearing" | "Refund" | "Reversal" | …
  hash?: string;
}

export interface WirexActivityItem {
  id: string;
  created_at: string; // ISO 8601
  type: string; // "CardTransaction" | "ExternalCardTransaction" | …
  sub_type?: string;
  direction: "Inbound" | "Outbound" | "Internal";
  status: "Pending" | "Completed" | "Failed";
  status_reason?: string;
  source: WirexActivitySubject;
  destination: WirexActivitySubject;
  source_amount?: WirexActivityAmount;
  destination_amount?: WirexActivityAmount;
  operations?: WirexActivityOperation[];
}

/** Shape returned by the MCP `GET /v1/card/transactions`. */
export interface WirexCardTransactionsResponse {
  ok: boolean;
  page: number;
  page_size: number;
  count: number;
  transactions: WirexActivityItem[];
}

// ── Fiat peg (single source of truth) ──────────────────────────────────────

// Wirex settles in USD/EUR/GBP wrappers, so a card-wallet token maps to one of
// three fiat codes. EUR- and GBP-pegged tokens are listed explicitly; everything
// else (WUSD, USDC, USDT, USDe, DAI, …) is USD.
const EUR_TOKENS = new Set(["WEUR", "EURC", "EURE"]);
const GBP_TOKENS = new Set(["WGBP", "GBPE"]);

// The fiat code a Wirex settlement token symbol pegs to (WEUR→EUR, WGBP→GBP,
// everything else→USD). The one place peg detection lives.
function fiatCodeForToken(tokenSymbol: string | undefined): FiatCode {
  const token = (tokenSymbol ?? "").toUpperCase();
  if (EUR_TOKENS.has(token)) return "EUR";
  if (GBP_TOKENS.has(token)) return "GBP";
  return "USD";
}

// Fiat code (EUR / USD / GBP) for the paid amount — never the token name. Prefer an
// explicit fiat `currency` when Wirex provides one; otherwise derive it from the
// settlement token's peg.
function fiatCodeFor(a: WirexActivityAmount): string {
  if (a.currency) return resolveFiatCode(a.currency);
  return resolveFiatCode(fiatCodeForToken(a.token_symbol));
}

// The FiatCode for an amount: the ISO `currency` when it's a supported fiat,
// else the settlement token's peg. Null only when the amount has neither.
export function wirexFiatCode(a: WirexActivityAmount | undefined): FiatCode | null {
  if (!a) return null;
  const iso = (a.currency ?? "").toUpperCase();
  if (iso === "EUR" || iso === "GBP" || iso === "USD") return iso as FiatCode;
  if (!a.currency && !a.token_symbol) return null;
  return fiatCodeForToken(a.token_symbol ?? a.currency);
}

// Secondary "≈ <display currency> x.xx" line under an amount paid in another
// currency. Undefined when the amount is already in the display currency, its
// code is unknown, or FX rates are unavailable.
export function homeSubtitle(
  amount: number,
  code: FiatCode | null,
  sign: string,
  rates: FxRates | undefined,
  home: FiatCode,
): string | undefined {
  if (code === home || code === null) return undefined;
  const converted = convertFiat(Math.abs(amount), code, home, rates);
  return converted === null ? undefined : `${sign}${home} ${converted.toFixed(2)}`;
}

// ── Mapping ──────────────────────────────────────────────────────────────

// Formats the user-side amount in major units. Wirex amounts are already major
// (e.g. 12.5), so there is no minor-unit division.
function formatPaid(a: WirexActivityAmount | undefined): string {
  if (!a || typeof a.amount !== "number" || Number.isNaN(a.amount)) return "—";
  return `${fiatCodeFor(a)} ${Math.abs(a.amount).toFixed(2)}`.trim();
}

export function merchantName(item: WirexActivityItem): string {
  return item.destination?.merchant?.name || item.source?.merchant?.name || "";
}

/**
 * Maps Wirex card-transaction activity items into ready-to-render
 * `ActivityItem` rows for `components/ActivitySheet`, sorted with
 * pending first, then newest first.
 */
/**
 * One Wirex activity row, card rail or bank rail. Both read the same fields off
 * the same item and differ only in what the row is CALLED: the merchant or the
 * counterparty as the title, and what a settled row says underneath.
 */
const wirexActivityRow = (
  item: WirexActivityItem,
  rates: FxRates | undefined,
  home: FiatCode,
  row: { title: string; settledLabel: string; onPress?: () => void },
): ActivityItem => {
  const isCredit = item.direction === "Inbound";
  const paid = isCredit ? item.destination_amount : item.source_amount;
  const isPending = item.status === "Pending";
  const isFailed = item.status === "Failed";
  const label = isPending
    ? t("screen.CardTransactionsModal.statusPending")
    : isFailed
      ? item.status_reason || t("screen.CardTransactionsModal.statusFailed")
      : row.settledLabel;
  return {
    onPress: row.onPress,
    icon: isFailed ? "cross" : isCredit ? "plus" : "arrow-up",
    label: row.title,
    // A sublabel that just repeats the title adds nothing — time only then.
    sublabel: withTxTime(formatActivityTime(item.created_at), label === row.title ? "" : label),
    // Debit shows a minus; credit (a refund, or money received) shows none.
    amount: `${isCredit ? "" : "-"}${formatPaid(paid)}`,
    amountSecondary: homeSubtitle(
      paid?.amount ?? 0,
      wirexFiatCode(paid),
      isCredit ? "" : "-",
      rates,
      home,
    ),
    key: item.id,
    pending: isPending,
    createdAt: item.created_at,
  };
};

/** Pending first, then newest first — the order both histories are read in. */
const byPendingThenNewest = (a: ActivityItem, b: ActivityItem): number => {
  if (a.pending !== b.pending) return a.pending ? -1 : 1;
  return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
};

export function mapWirexCardTransactions(
  items: WirexActivityItem[],
  rates?: FxRates,
  home: FiatCode = "EUR",
): ActivityItem[] {
  if (!Array.isArray(items)) return [];

  return items
    .map((item) =>
      wirexActivityRow(item, rates, home, {
        title: merchantName(item) || t("screen.CardTransactionsModal.typePayment"),
        settledLabel:
          item.direction === "Inbound"
            ? t("screen.CardTransactionsModal.typeRefund")
            : t("screen.CardTransactionsModal.typePayment"),
      }),
    )
    .sort(byPendingThenNewest);
}

// Counterparty (holder) name for a bank-rail item. The counterparty is the
// *other* side of the transfer: the sender on Inbound, the recipient on
// Outbound. There is no merchant on bank rails.
// Banks report inbound holder names in all caps ("LENNARD EVERTZ") while
// outbound names keep the user's own casing — title-case the all-caps form so
// the same person renders identically in both directions. Mixed-case names
// pass through untouched.
function normalizeBankNameCase(name: string): string {
  if (!name || name !== name.toUpperCase()) return name;
  return name
    .toLowerCase()
    .split(" ")
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}

export function bankCounterpartyName(item: WirexActivityItem): string {
  const subject = item.direction === "Inbound" ? item.source : item.destination;
  const raw = (
    subject?.bank_account?.owner_name ||
    subject?.bank_account?.holder_name ||
    subject?.bank_account?.name ||
    subject?.name ||
    ""
  ).trim();
  return normalizeBankNameCase(raw);
}

/** Counterparty of a bank-rail row (sender on Inbound, recipient on Outbound). */
export type WirexBankCounterparty = { iban: string; bic: string; name: string };

/**
 * Maps Wirex bank-rail activity items (SEPA/AchPush/AchPull/FasterPayment/Swift)
 * into ready-to-render `ActivityItem` rows for `components/ActivitySheet`.
 * Mirrors `mapWirexCardTransactions` but titles rows by the bank counterparty
 * (or a generic "Bank transfer" label) instead of a merchant name.
 * `onCounterpartyPress` (when given) becomes the row's onPress for every row
 * whose counterparty IBAN is known — the send-again entry point.
 */
export function mapWirexBankActivity(
  items: WirexActivityItem[],
  rates?: FxRates,
  onCounterpartyPress?: (counterparty: WirexBankCounterparty) => void,
  home: FiatCode = "EUR",
): ActivityItem[] {
  if (!Array.isArray(items)) return [];

  return items
    .map((item) => {
      const subject = item.direction === "Inbound" ? item.source : item.destination;
      const counterparty: WirexBankCounterparty = {
        iban: (subject?.bank_account?.iban || "").trim(),
        bic: (subject?.bank_account?.bic || "").trim(),
        name: bankCounterpartyName(item),
      };
      const row = wirexActivityRow(item, rates, home, {
        title: counterparty.name || t("screen.WirexSendChoice.sepaTitle"),
        settledLabel: t("screen.WirexSendChoice.sepaTitle"),
        onPress:
          onCounterpartyPress && counterparty.iban
            ? () => onCounterpartyPress(counterparty)
            : undefined,
      });
      const iban = counterparty.iban.replace(/\s+/g, "").toUpperCase();
      // Whoever the transfer went to or came from can be saved by its IBAN.
      return iban
        ? {
            ...row,
            onPressLabel: t("component.ActivityRowActions.sendAgain"),
            saveOffer: {
              destination: {
                type: "bank" as const,
                raw: iban,
                iban,
                // May be empty: saving opens the add form, which looks it up.
                bic: counterparty.bic,
                ...(counterparty.name ? { holder: counterparty.name } : {}),
              },
              ...(counterparty.name ? { name: counterparty.name } : {}),
            },
          }
        : row;
    })
    .sort(byPendingThenNewest);
}
