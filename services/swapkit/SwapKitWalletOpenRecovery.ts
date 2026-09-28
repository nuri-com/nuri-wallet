import type { SwapKitOrder } from "./SwapKitOrderStore";
import type { SwapKitTrackResponse } from "./SwapKitService";

const address = (value: unknown): string =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : "";

/** Read-only eligibility, not authorization. The existing sheet validates fresh terms.
 *
 * Why these gates exist (incident 2026-09-13, #1325): the original funded
 * Satora BTC_ARKADE order completed its claim but its CoW final leg was never
 * submitted, leaving it AWAITING_SIGNATURE with no owner-visible path forward.
 * Every condition below is a guard against over-prompting: owner/recipient
 * binding (no foreign order), claimed-first-leg proof (a quote or unsigned HTLC
 * is not funding), unsubmitted-final-leg proof (never prompt once the CoW
 * order is out), and one-shot-per-session handled by the host. Opening the
 * sheet never signs or spends; explicit Continue owns acceptance. */
export function isWalletOpenRecovery(
  order: SwapKitOrder,
  status: SwapKitTrackResponse | null,
  owner: string,
): boolean {
  if (!status || !address(owner) || order.recoveryConsent?.accepted) return false;
  const ids = [status.id, status.txId].filter((id) => id !== undefined);
  if (!ids.length || ids.some((id) => id !== order.txId)) return false;
  if (
    address(status.fromAddress) !== address(owner) ||
    !address(order.settleTarget) ||
    address(status.recipient) !== address(order.settleTarget) ||
    status.from !== "BTC_ARKADE" ||
    status.to !== "EURC_BASE" ||
    status.status !== "AWAITING_SIGNATURE" ||
    status.terminal === true ||
    order.recovery?.status === "FUNDING"
  )
    return false;
  const first = status.legs?.[0];
  const last = status.legs?.at(-1);
  const state = first?.state as { phase?: string; claimTxHash?: string } | undefined;
  // A quote or unsigned HTLC is not evidence of funding. Require the original
  // claimed first leg, and never prompt once the final provider order is out.
  return Boolean(
    status.legs?.length === 2 &&
      first?.provider === "satora" &&
      first.status === "COMPLETED" &&
      first.terminal === true &&
      state?.phase === "claim_redeemed" &&
      /^0x[0-9a-fA-F]{64}$/.test(state.claimTxHash ?? "") &&
      last?.provider === "cow" &&
      last.status === "AWAITING_SIGNATURE" &&
      last.terminal !== true &&
      !last.externalId &&
      !last.txids?.length &&
      !last.advance &&
      (status.recoveryQuote || status.walletActionError),
  );
}
