import { t } from "../lib/i18n";
import type { SwapKitV2Move } from "../services/swapkit/SwapKitV2MoveStatus";

/** The pill's one-line label for a move. A failed move with an app-written
 * reason says why; every other failure stays the generic "Move failed". */
export function v2MoveLabel(move: SwapKitV2Move): string {
  switch (move.phase) {
    case "preparing":
      return t("swap.move.preparing");
    case "approving":
      return t("swap.move.approving");
    case "executing":
      return t("swap.move.executing");
    case "completed":
      return t("swap.move.completed");
    case "failed":
      return move.failureReason || t("swap.move.failed");
    case "refunded":
      return t("swap.move.refunded");
    case "action_required":
      return t("swap.move.actionRequired");
    default:
      return t("swap.move.processing");
  }
}

/** What makes a pill worth showing again: its order, phase and label. The
 * label is in it so a failure reason that arrives after a generic "Move failed"
 * replaces that pill, while an unchanged outcome is still shown once. */
export function movePillSignature(move: SwapKitV2Move, othersRunning: number): string {
  return `${move.orderId}:${move.phase}:${othersRunning}:${v2MoveLabel(move)}`;
}
