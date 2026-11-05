// A card withdrawal as both histories tell it.
//
// Wirex pays a withdrawal out with `withdrawTo`: the card account burns its
// card money (WEUR or WUSD) and Wirex's contract sends the euros or dollars to
// the recipient in the same transaction. The card account never sends them
// itself, so the payout's sender names neither the card nor the user. What
// ties the payout to this card is the burn: a transaction in which this card
// account burned its card money is this card's withdrawal.
import type { ActivityItem } from "../../components/ActivitySheet";
import type { AssetTransfer } from "../../services/balance/transactions/alchemyTransfers";
import type { FxRates } from "../../services/pricing/FxRateService";
import { t } from "../i18n";
import type { FiatCode } from "../tokens";
import { formatActivityTime } from "../transactionRowUtils";
import { homeSubtitle, wirexFiatCode } from "./cardTransactions";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Card money the card account burned: one per withdrawal transaction. */
export type CardBurn = {
  txHash: string;
  blockNumber: bigint;
  amount: number;
  /** The card money burned ("WEUR", "WUSD"): it names the currency. */
  tokenSymbol: string;
};

/** A withdrawal that paid the user's own Cash. */
export type CardWithdrawal = CardBurn & { createdAt: string };

/** The burns among the card account's outgoing transfers, one per transaction. */
export function cardBurns(transfers: readonly AssetTransfer[], card: string): CardBurn[] {
  const account = card.toLowerCase();
  const byHash = new Map<string, CardBurn>();
  for (const transfer of transfers) {
    if (transfer.from.toLowerCase() !== account) continue;
    if (transfer.to.toLowerCase() !== ZERO_ADDRESS) continue;
    const txHash = transfer.transactionHash.toLowerCase();
    if (!txHash || byHash.has(txHash)) continue;
    byHash.set(txHash, {
      txHash,
      blockNumber: transfer.blockNumber,
      amount: transfer.value,
      tokenSymbol: transfer.asset,
    });
  }
  return [...byHash.values()];
}

type ReceiptLog = { address: string; topics?: readonly string[] };

/**
 * Whether a withdrawal's transaction paid one of the user's own addresses in a
 * Cash token. A withdrawal paying anyone else (a currency swap pays Wirex's
 * deposit address) is not money moved to Cash.
 */
export function paidOwnCash(
  logs: readonly ReceiptLog[],
  own: readonly string[],
  cashTokens: readonly string[],
): boolean {
  const owners = new Set(own.map((a) => a.toLowerCase()));
  const tokens = new Set(cashTokens.map((a) => a.toLowerCase()));
  return logs.some((log) => {
    if (!tokens.has(log.address.toLowerCase())) return false;
    if ((log.topics?.[0] ?? "").toLowerCase() !== TRANSFER_TOPIC) return false;
    const to = `0x${(log.topics?.[2] ?? "").slice(-40)}`.toLowerCase();
    return owners.has(to);
  });
}

/** Card history rows for withdrawals to Cash: money out of the card. */
export function cardWithdrawalActivityItems(
  withdrawals: readonly CardWithdrawal[],
  rates: FxRates | undefined,
  home: FiatCode,
): ActivityItem[] {
  return withdrawals.map((w): ActivityItem => {
    const code = wirexFiatCode({ amount: w.amount, token_symbol: w.tokenSymbol });
    return {
      icon: "arrow-up",
      label: t("screen.WalletTransactionsModal.toYourWallet"),
      sublabel: formatActivityTime(w.createdAt),
      amount: `-${code ?? "EUR"} ${Math.abs(w.amount).toFixed(2)}`,
      amountSecondary: homeSubtitle(w.amount, code, "-", rates, home),
      key: `chain:${w.txHash}:card_withdrawal`,
      createdAt: w.createdAt,
    };
  });
}
