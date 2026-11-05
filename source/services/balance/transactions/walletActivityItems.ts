// A Cash (Euro or Dollar) history row as an activity-list entry. The Cash
// activity sheet and a contact's page in the address book (#1793) both build
// their rows here, so a payment reads the same in both.
import { Linking } from "react-native";
import type { ActivityItem } from "../../../components/ActivitySheet";
import { basescanTokenUrl, basescanTxUrl } from "../../../config/endpoints";
import { BASE_EURC } from "../../../config/network";
import { t } from "../../../lib/i18n";
import { VISA_LOGO } from "../../../lib/railMarks";
import { resolveFiatCode } from "../../../lib/tokens";
import { formatActivityTime, withTxTime } from "../../../lib/transactionRowUtils";
import { withCacheBuster } from "../../../lib/url";
import { isEvmTxHash, isValidEvmAddress } from "../../../lib/validation";
import type { WalletTransactionRow } from "../../../types/wallet";
import {
  getSwapKitV2LastView,
  getSwapKitV2StatusMessage,
} from "../../swapkit/SwapKitV2PendingTracker";
import { type Legs, swapRow } from "../../swapkit/swapActivity";
import { wirexAccountService } from "../../wirex/WirexAccountService";
import {
  classifyWalletRow,
  getOrderDateIso,
  getOrderState,
  pickOrderTxHash,
} from "./walletHistoryRows";

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

export type WalletActivityContext = {
  /** The wallet's own addresses: a transfer to or from one is your own move. */
  primaryAddress?: string | null;
  address?: string | null;
  /** The account the explorer opens when a row has no transaction hash. */
  explorerAddress?: string | null;
  swapLegs: Legs;
  /** Transactions in which this user's card withdrew (lowercase hashes). */
  cardWithdrawalTxs?: ReadonlySet<string>;
  /** Opens a pending swap's live detail. */
  onOpenOrder: (orderId: string) => void;
  /** Pay this row's recipient again (opens the send, never sends). */
  onSendAgain?: (address: string) => void;
};

/** The activity entries for a Cash history (rows from buildWalletTransactionRows). */
export function walletActivityItems(
  list: readonly WalletTransactionRow[],
  ctx: WalletActivityContext,
): ActivityItem[] {
  const {
    primaryAddress,
    address,
    explorerAddress,
    swapLegs,
    cardWithdrawalTxs,
    onOpenOrder,
    onSendAgain,
  } = ctx;
  return list.map((o): ActivityItem => {
    // A BTC→EUR topup surfaces here as the euro-incoming (destination) mirror
    // of the Bitcoin-origin row. It shares the swap pending machinery but is
    // incoming (euros arriving), so it renders without a minus sign and never
    // uses the EUR→BTC "≈ BTC sats" framing. A sweep is euros arriving from
    // another chain, the same incoming framing.
    const { kind, isPendingBalance, isPendingLocal, isTopup, isIncoming } = classifyWalletRow(o);
    // Onchain rows carry only a counterparty address (no IBAN/name).
    const chainAddr = isPendingBalance ? "" : (o?.counterpart?.identifier?.address || "").trim();
    const isCard =
      (o?.meta?.source === "onchain_card" || kind.startsWith("card_")) &&
      kind !== "wallet_transfer_in";
    // Empty: a counterparty known only by its address, read as someone, or
    // as your own wallet when it is this wallet's address.
    let displayName = "";
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
    // Pending swap rows stay compact (Emin): euro amount + "≈ BTC <sats>",
    // never the word sats, always the bitcoin symbol. Route/provider detail
    // lives in the show-more sheet.
    const swapLastStatus =
      isPendingLocal && kind === "swapkit_swap_pending"
        ? getSwapKitV2LastView(String(o?.meta?.orderId || ""))
        : null;
    if (isPendingLocal && kind === "swapkit_swap_pending") {
      displayName = isTopup ? t("screen.WalletTransactionsModal.topUp") : "SwapKit EUR → BTC";
    }
    // A plain transfer to or from the card's own deposit address is the
    // user's own move: it reads as the card, never as a stranger's wallet.
    const cardAddress = (wirexAccountService.depositAddress() ?? "").toLowerCase();
    // A card withdrawal is paid out by Wirex's contract, not by the card
    // account, so it is known by the transaction the card withdrew in.
    const isOwnCard =
      (Boolean(cardAddress) && chainAddr.toLowerCase() === cardAddress) ||
      (isIncoming &&
        !isPendingBalance &&
        !isPendingLocal &&
        Boolean(cardWithdrawalTxs?.has((pickOrderTxHash(o) ?? "").toLowerCase())));
    if (isOwnCard) {
      displayName = t("screen.HomeScreen.groupCardBanking");
    }
    // A leg of a swap reads as the swap: "Euro → Dollar", "From Bitcoin".
    const swap =
      isPendingBalance || isPendingLocal ? null : swapRow(swapLegs, pickOrderTxHash(o), isIncoming);
    const own = [primaryAddress, address].some(
      (mine) => Boolean(mine) && mine?.toLowerCase() === chainAddr.toLowerCase(),
    );
    const title =
      swap?.title ??
      (isPendingBalance || isPendingLocal
        ? displayName
        : !displayName
          ? t(
              own
                ? isIncoming
                  ? "screen.WalletTransactionsModal.fromYourWallet"
                  : "screen.WalletTransactionsModal.toYourWallet"
                : isIncoming
                  ? "screen.WalletTransactionsModal.fromSomeone"
                  : "screen.WalletTransactionsModal.toSomeone",
            )
          : `${isIncoming ? "From" : "To"} ${displayName}`);
    // The counterpart's mark, as a contact's picture: Visa for the card.
    const image = swap ? swap.image : isCard || isOwnCard ? VISA_LOGO : undefined;
    const dateIso = getOrderDateIso(o);
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
        : txTime;
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

    // A pending swap row opens the live "where is my money?" detail sheet.
    const swapOrderId = kind === "swapkit_swap_pending" ? String(o?.meta?.orderId || "") : "";
    const hasExplorer = !isPendingBalance && !isPendingLocal;

    // A send to someone else's address can be saved. Every outgoing
    // onchain transfer is a "wallet_transfer_out"; one to this wallet or
    // the card's own deposit address is the user's own move, never a card
    // row, a swap or a pending one.
    const recipient =
      !isIncoming &&
      !own &&
      !swap &&
      chainAddr &&
      !isCard &&
      !isPendingLocal &&
      !isPendingBalance &&
      isValidEvmAddress(chainAddr) &&
      chainAddr.toLowerCase() !== cardAddress
        ? chainAddr
        : "";

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
      ...(image ? { image } : {}),
      ...(swapOrderId ? { onOpen: () => onOpenOrder(swapOrderId) } : {}),
      ...(hasExplorer
        ? {
            onPress: onOpenExplorer,
            onPressLabel: t("component.ActivityRowActions.viewOnBasescan"),
          }
        : {}),
      incoming: isIncoming,
      // Money in names its sender the way money out names its recipient;
      // your own wallet, the card and a swap are no sender to name.
      ...(isIncoming &&
      chainAddr &&
      !own &&
      !isOwnCard &&
      !isCard &&
      !swap &&
      isValidEvmAddress(chainAddr)
        ? { counterpartyAddress: chainAddr }
        : {}),
      ...(swap?.sides ? { swap: swap.sides } : {}),
      saveOffer: recipient
        ? {
            destination: {
              type: "crypto",
              raw: recipient,
              network: "base",
              asset: /usd/i.test(String(o?.currency ?? "")) ? "USDC" : "EURC",
            },
          }
        : null,
      // Paying someone again: never your own wallet or a swap's counterparty.
      ...(recipient && !swap && onSendAgain
        ? { onSendAgain: (to?: string) => onSendAgain(to ?? recipient) }
        : {}),
      amount: amountText,
      pending: (isPendingBalance || isPendingLocal || isPending) && !isRejected,
      createdAt: dateIso || undefined,
    };
  });
}
