/**
 * Bottom offset for the absolutely-positioned welcome actions block.
 *
 * Extracted so the layout rule is testable: a hardcoded `bottom: 32` put the
 * block under Android's system navigation bar, hiding the "Use existing
 * Passkey" row behind it.
 */

/** Designed spacing, kept when the system inset is smaller (gesture nav, iOS). */
export const ACTIONS_BOTTOM_MIN = 32;

export function resolveActionsBottom(safeAreaBottomInset: number): number {
  return Math.max(safeAreaBottomInset, ACTIONS_BOTTOM_MIN);
}
