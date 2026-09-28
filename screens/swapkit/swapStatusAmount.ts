import type { SwapKitV2OrderView } from "../../services/swapkit/SwapKitV2Service";

// Ticker for the amount line: "6 EURC → 0.00006844 BTC".
const assetSymbol = (asset: string): string => {
  const code = asset.toUpperCase();
  return code.startsWith("BTC") ? "BTC" : (code.split("_")[0] ?? code);
};

/** What this wallet recorded when the user accepted the quote (order store row). */
export type AcceptedLocally = {
  from: string;
  to: string;
  acceptedDepositAmount?: string;
  minimumSettleAmount?: string;
};

/**
 * One line, sent → received, as the quote was accepted. The accepted bounds
 * exist from the commit on, so the line is there while the order still runs;
 * execution values fill in only for an order without them. Server amount
 * strings are shown unchanged.
 */
export function swapAmountLine(view: SwapKitV2OrderView | null): string | null {
  const accepted = view?.accepted as
    | { from?: string; to?: string; acceptedDepositAmount?: string; minimumSettleAmount?: string }
    | undefined;
  const execution = view?.execution as
    | { depositAmount?: string; settleAmount?: string }
    | undefined;
  const path = Array.isArray(view?.path) ? (view.path as string[]) : [];
  const from = accepted?.from ?? path[0];
  const to = accepted?.to ?? path[path.length - 1];
  const sent = accepted?.acceptedDepositAmount ?? execution?.depositAmount;
  const received = accepted?.minimumSettleAmount ?? execution?.settleAmount;
  if (!from || !to || !sent || !received) return null;
  return `${sent} ${assetSymbol(from)} → ${received} ${assetSymbol(to)}`;
}

/**
 * The order-store id a status-sheet id is recorded under. A pill opened before
 * the commit reply carries the provisional `pending:<key>`; the wallet wrote
 * that intent (with the accepted bounds) as `ord_pending:<key>` before sending.
 */
export const storedOrderIdFor = (orderId: string): string =>
  orderId.startsWith("pending:") ? `ord_${orderId}` : orderId;

/**
 * The status sheet's amount line: the server's view once it has one, and until
 * then the accepted quote this wallet itself committed — the exact bound
 * strings it sent, which the server echoes back unchanged — so the sheet
 * states the quote the moment it opens, before (or without) a network read.
 */
export function statusSheetAmountLine(
  orderId: string,
  view: SwapKitV2OrderView | null,
  storedOrder: (id: string) => AcceptedLocally | null,
): string | null {
  const fromServer = swapAmountLine(view);
  if (fromServer) return fromServer;
  const local = storedOrder(storedOrderIdFor(orderId));
  if (!local) return null;
  return swapAmountLine({ accepted: local } as unknown as SwapKitV2OrderView);
}
