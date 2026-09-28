// The transfer that moves sats between the two bitcoin rails. Neither direction
// is a swap — both rails are the same asset — so there is no route and no quote;
// these are the plain offboard/onboard sends the wallet already performs, wired
// with the bookkeeping the send path owns:
//
//   arkade → on-chain  offboard (collaborative exit) — arms the arkade outgoing
//                      balance hold first, or the post-broadcast refresh can
//                      publish a transient/zero arkade balance while change
//                      awaits the next round.
//   on-chain → arkade  board — a MuSig2 send to the arkade boarding address,
//                      gated by the on-chain miner fee so a max send fails
//                      before submission, not after.
//
// Kept as a service (not screen code) so the lifecycle is one place and unit
// testable.

import { sendArkadeBitcoinOnchain } from "../arkade/ArkadeSendService";
import { isArkadeMaxSendAmountError } from "../arkade/internal/maxSendAmount";
import { isArkadeVtxoTooFreshError } from "../arkade/internal/settlementExpiryGap";
import { errMsg } from "../../lib/errorMessage";
import { EventBus } from "../events/AppEventBusService";
import { bitcoinBalanceStore } from "./BitcoinBalanceStore";
import { estimateOnchainSendFeeSats, sendBitcoinOnchainFromMusig2 } from "./OnchainSendService";
import { PendingBitcoinSendsStore } from "./PendingBitcoinSendsStore";

export type OffboardArkadeToOnchainResult = { txid: string; amountSats: number };
export type BoardOnchainToArkadeResult = { txid: string; amountSats: number };

/** Amount the receiver can get while leaving the current on-chain miner fee. */
export async function getOnchainToArkadeTransferableSats(
  onchainSpendableSats: number,
): Promise<number> {
  const spendable = Math.max(0, Math.trunc(Number(onchainSpendableSats) || 0));
  const feeSats = await estimateOnchainSendFeeSats();
  return Math.max(0, spendable - feeSats);
}

/**
 * Offboard the arkade balance to the wallet's on-chain address.
 *
 * Arms the arkade outgoing-balance hold before dispatch (long anchor, no TTL)
 * and clears it on success / reverts it on failure — the same lifecycle the
 * dedicated send screen arms. Throws on failure with the hold already reverted.
 */
export async function offboardArkadeToOnchain(params: {
  toAddress: string;
  amountSats: number;
}): Promise<OffboardArkadeToOnchainResult> {
  const toAddress = String(params.toAddress || "").trim();
  const amountSats = Math.max(0, Math.trunc(Number(params.amountSats)));
  if (!toAddress) throw new Error("recipient address required");
  if (!Number.isFinite(amountSats) || amountSats <= 0) {
    throw new Error("amount_sats must be positive");
  }

  bitcoinBalanceStore.holdArkadeOutgoingBalance("btc_rail_offboard", amountSats);
  try {
    const { txid, offboardSats } = await sendArkadeBitcoinOnchain({
      address: toAddress,
      amountSats,
    });
    // The offboard grosses the receiver amount up with the on-chain output fee,
    // so the balance actually debited is `offboardSats`, not `amountSats`.
    // Re-arm the anchor with the real figure or it waits on an overstated
    // balance and shows sats that are no longer spendable.
    if (offboardSats !== amountSats) {
      bitcoinBalanceStore.holdArkadeOutgoingBalance("btc_rail_offboard_gross", offboardSats);
    }
    bitcoinBalanceStore.clearArkadeOutgoingBalanceHold("btc_rail_offboard_success");
    if (txid) {
      void PendingBitcoinSendsStore.add({
        txid,
        amountSats,
        toAddress,
        source: "arkade",
        toRail: "onchain",
      }).catch(() => {});
    }
    EventBus.emit("bitcoin:refresh");
    return { txid, amountSats };
  } catch (error) {
    bitcoinBalanceStore.revertArkadeOutgoingBalance("btc_rail_offboard_error");
    throw new Error(formatArkadeOffboardError(error));
  }
}

/**
 * Board the on-chain balance into the arkade wallet via its boarding address.
 *
 * Reserves the on-chain miner fee before sending so a max send that leaves no
 * headroom is rejected up front. Throws before anything is broadcast when the
 * amount plus fee does not fit.
 */
export async function boardOnchainToArkade(params: {
  toAddress: string;
  amountSats: number;
  onchainSpendableSats: number;
}): Promise<BoardOnchainToArkadeResult> {
  const toAddress = String(params.toAddress || "").trim();
  const amountSats = Math.max(0, Math.trunc(Number(params.amountSats)));
  if (!toAddress) throw new Error("recipient address required");
  if (!Number.isFinite(amountSats) || amountSats <= 0) {
    throw new Error("amount_sats must be positive");
  }

  const onchainSpendable = Math.max(0, Math.trunc(Number(params.onchainSpendableSats)));
  const feeSats = await estimateOnchainSendFeeSats();
  if (amountSats + feeSats > onchainSpendable) {
    throw new Error("amount exceeds available balance after fees");
  }

  const result = await sendBitcoinOnchainFromMusig2({ toAddress, amountSats });
  if (result.txid) {
    void PendingBitcoinSendsStore.add({
      txid: result.txid,
      amountSats,
      toAddress,
      source: "onchain",
      toRail: "arkade",
    }).catch(() => {});
  }
  EventBus.emit("bitcoin:refresh");
  return { txid: result.txid, amountSats };
}

// The arkade offboard rejects a too-fresh VTXO and a dust change with typed
// errors. The Move sheet's transfer path has no amount field to correct, so the
// rejection is stated on the failure view instead — same wording the dedicated
// send screen uses.
export function formatArkadeOffboardError(error: unknown): string {
  if (isArkadeVtxoTooFreshError(error)) {
    const remainingMs = Number.isFinite(error.availableAtMs) ? error.availableAtMs - Date.now() : 0;
    const remainingMinutes = Math.ceil(remainingMs / 60_000);
    if (remainingMinutes >= 60) {
      return `Funds cannot be moved now. Try again in about ${Math.ceil(remainingMs / 3_600_000)}h.`;
    }
    if (remainingMinutes > 0) {
      return `Funds cannot be moved now. Try again in about ${remainingMinutes} min.`;
    }
    return "Funds cannot be moved now. Please try again later.";
  }
  if (isArkadeMaxSendAmountError(error)) {
    return `Max ${Math.max(0, Math.trunc(error.maxAmountSats))} available`;
  }
  const belowMin = /ark_to_btc_amount_below_minimum[\s\S]*?min_receive_sats=(\d+)/.exec(
    errMsg(error, ""),
  );
  if (belowMin) {
    return `Minimum ${belowMin[1]} sats`;
  }
  return errMsg(error, "Something went wrong. Please try again.");
}
