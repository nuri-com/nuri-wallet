// Wallet → card. The card settles in the same two stables the wallet holds, so
// filling the pocket that matches the source is a TRANSFER: EURC on Base going
// in comes out as the card's euros, USDC as its dollars. There is nothing to
// price and nothing to choose, and the only question a caller has to answer is
// how much. Kept here rather than in a screen so every caller — the send sheet
// and the Move sheet, which already has the amount — runs the identical
// transfer instead of lookalikes.
//
// The pair that does NOT match (euros into the dollar pocket, or the reverse) is
// an exchange, not a transfer, and goes through the Move sheet's priced route.
import { BASE_EURC, BASE_USDC } from "../../config/network";
import { rememberOptimisticMove } from "../../lib/balance/pendingOptimisticMoves";
import { sendTokenOnBase } from "../base/BaseTokenTransferService";
import { usdcBalanceStore } from "../balance/UsdcBalanceStore";
import { walletBalanceStore } from "../balance/WalletBalanceStore";
import { EventBus } from "../events/AppEventBusService";
import { startCardTopUpInFlight } from "../money/announce";
import { wirexAccountService } from "../wirex/WirexAccountService";

export type CardTransferResult = {
  txHash?: string;
  /** The transfer is mined AND successful. False = broadcast, not yet mined. */
  confirmed: boolean;
};

type CardStable = { address: `0x${string}`; decimals: number };

/**
 * Move `amount` of one stable from the wallet to the card. `amount` is a plain
 * decimal string ("12.50") — it reaches parseUnits untouched, so no separators.
 *
 * Never waits for the receipt: both balances belong to the same person, so the
 * move is shown immediately and the chain catches up. Throws when the card has
 * no deposit address yet (no Wirex account) or the transfer itself fails.
 */
async function sendStableToCard(
  amount: string,
  stable: CardStable,
): Promise<CardTransferResult & { aaAddress: string }> {
  wirexAccountService.ensureStarted();
  const aaAddress = wirexAccountService.depositAddress();
  if (!aaAddress) throw new Error("Wirex deposit address unavailable");

  const { hash: txHash, confirmed } = await sendTokenOnBase({
    toAddress: aaAddress as `0x${string}`,
    amount: amount.replace(/\.$/, ""),
    tokenAddress: stable.address,
    tokenDecimals: stable.decimals,
    awaitReceipt: false,
  });

  return { txHash, confirmed, aaAddress };
}

/**
 * Euro wallet → the card's euro pocket. One EURC transfer to the card's address.
 *
 * Both sides of the move are stepped here, before the transaction is announced.
 * The announcement is what arms the settlement watcher, and the watcher takes
 * these moves back by tx hash — so anything parked after it could be parked
 * after the only revert event has already passed, leaving a balance overstated
 * with nothing left to correct it.
 */
export async function sendEuroToCard(amount: string): Promise<CardTransferResult> {
  const value = Number(amount);
  const { txHash, confirmed, aaAddress } = await sendStableToCard(amount, BASE_EURC);
  rememberOptimisticMove("wallet", txHash, walletBalanceStore.applyOptimisticDebit(value));
  // Held across the EURC confirmation AND the Wirex EURC↔WEUR swap behind it, so
  // the money is never shown as having left one side without having arrived on
  // the other.
  rememberOptimisticMove("card", txHash, wirexAccountService.applyOptimisticCredit(value));

  try {
    if (confirmed) {
      EventBus.emit("wallet:refresh");
      setTimeout(() => EventBus.emit("wallet:refresh"), 4000);
      EventBus.emit("transactions:refresh");
      setTimeout(() => EventBus.emit("transactions:refresh"), 4000);
    } else {
      EventBus.emit("wallet:pendingTransfer", {
        amountFiat: Number(amount),
        txHash,
        to: aaAddress,
        source: "base-mainnet",
        createdAt: new Date().toISOString(),
      });
      // The euro wallet pays and the card's EURO POCKET receives — two
      // different screens, which is exactly what the currency-keyed store
      // could not express, so the card never showed money arriving.
      void startCardTopUpInFlight({ id: txHash, amount: Number(amount), fiat: "EUR" }).catch(
        () => {},
      );
    }
  } catch {}

  return { txHash, confirmed };
}

/**
 * Dollar wallet → the card's dollar pocket. One USDC transfer to the same
 * address.
 *
 * The pending row names its token. It has to exist: `PendingTransferSettleWatcher`
 * only watches hashes that were registered here, and it is what later reports the
 * receipt as `wallet:transferSettled` — the event that takes the card's
 * optimistic credit back when the transfer turns out to have reverted. Without a
 * row, a broadcast that never mines leaves a credit on the card until it expires
 * three minutes later, with no failure shown and the dollars still apparently
 * spendable. `asset` is what keeps that row off the euro wallet's surfaces.
 *
 * The card's credit needs a rate, so it resolves asynchronously — which is
 * exactly why it is awaited HERE, ahead of the announcement, rather than by a
 * caller after it. The row is what arms the watcher.
 */
export async function sendDollarToCard(amount: string): Promise<CardTransferResult> {
  const value = Number(amount);
  const { txHash, confirmed, aaAddress } = await sendStableToCard(amount, BASE_USDC);
  rememberOptimisticMove("dollar", txHash, usdcBalanceStore.applyOptimisticDebit(value));
  // The card states one euro total, so dollars arriving on it are converted on
  // the way in rather than added at par.
  rememberOptimisticMove(
    "card",
    txHash,
    await wirexAccountService.applyOptimisticCreditIn(value, "USD"),
  );

  try {
    if (confirmed) {
      EventBus.emit("wallet:refresh");
      setTimeout(() => EventBus.emit("wallet:refresh"), 4000);
      EventBus.emit("transactions:refresh");
      setTimeout(() => EventBus.emit("transactions:refresh"), 4000);
    } else {
      EventBus.emit("wallet:pendingTransfer", {
        amountFiat: Number(amount),
        txHash,
        to: aaAddress,
        source: "base-mainnet",
        fiat: "USD",
        createdAt: new Date().toISOString(),
      });
      void startCardTopUpInFlight({ id: txHash, amount: Number(amount), fiat: "USD" }).catch(
        () => {},
      );
    }
  } catch {}

  return { txHash, confirmed };
}
