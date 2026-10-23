// A payment link opened IN the app: `nuri://pay/@username?to=…&amount=…` from a
// mobile handoff, or `/?pay=@username&to=…&amount=…` when the installed PWA is
// handed the same link. The public page guesses nothing about a session; this is
// the signed-in side, so the payer pays from their own balance.
//
// Pure: a string in, the intent out. Nothing here sends or opens anything.
import { type SendBalance, type SendRecipient } from "../send/sendRouting";
import { exactBaseUnits } from "./payTarget";
import { type PaySettleCurrency, parsePayLink, parsePayLinkPath } from "./payLinkPath";

export type PayIntent = {
  username: string;
  /** What the link asks the recipient to receive. */
  settle: PaySettleCurrency;
  /** What the recipient receives, in `settle`; null when the link names none. */
  amount: string | null;
  /**
   * Whether the link actually ASKED for that currency or figure (`parsePayLink`'s
   * `explicit`). A plain `/pay/@name` is not a euro request: it means "pay them
   * however you can", and the page offers every rail the person has. The
   * narrowing below applies only to a link that named something.
   */
  explicit: boolean;
};

/**
 * The intent an app URL carries, or null when it carries none.
 *
 * Two shapes, one parser: the deep link's own path (`/pay/@username`) and the
 * web root's `?pay=@username`. The amount and currency rules are the pay page's
 * (`parsePayLink`), so a figure the page would refuse cannot arrive in the app.
 */
export function parsePayIntent(pathname: string, search: string): PayIntent | null {
  let handle = parsePayLinkPath(pathname);
  if (!handle) {
    let asked = "";
    try {
      asked = (new URLSearchParams(String(search || "")).get("pay") || "").trim();
    } catch {
      return null;
    }
    handle = asked ? parsePayLinkPath(`/pay/@${asked.replace(/^@/, "")}`) : null;
  }
  if (!handle) return null;
  const link = parsePayLink(search);
  return { username: handle, settle: link.settle, amount: link.amount, explicit: link.explicit };
}

/**
 * The recipient with the link's figure pinned to it, exactly as a scanned code
 * that names its amount would pin it: the amount step opens on it, and the
 * payer still confirms. A figure the asset cannot express is dropped, never
 * rounded.
 */
export function withPayIntentAmount(recipient: SendRecipient, intent: PayIntent): SendRecipient {
  if (!intent.amount) return { ...recipient };
  if (intent.settle === "BTC") {
    const sats = exactBaseUnits(intent.amount, 8);
    return sats === null ? { ...recipient } : { ...recipient, amountSats: sats.toString() };
  }
  return { ...recipient, amountStable: intent.amount };
}

/**
 * The balance the confirm screen opens on, so the money lands in the currency
 * the link names. A hint, not a constraint: an unfunded or unroutable balance is
 * skipped exactly as it is for any other send, and the payer can switch.
 */
export function payIntentBalances(intent: PayIntent): SendBalance[] {
  // A plain link asks for nothing in particular: the normal order decides, so
  // the payer lands on the balance that pays without a swap, as any send does.
  if (!intent.explicit) return [];
  if (intent.settle === "USDC_BASE") return ["dollar"];
  if (intent.settle === "BTC") return ["arkade", "onchain"];
  return ["wallet"];
}

/**
 * The recipient narrowed to the rail the link asks for, or null when this
 * recipient cannot be paid that way.
 *
 * The directory answers with every address the person has, and an amount screen
 * opened on all of them pays whichever one the payer's balance happens to
 * suit: a dollars link paid from a funded Euro balance would send EURC, and a
 * bitcoin link paid from the Arkade balance would land on their Ark address.
 * So the request is what narrows the destination:
 *
 *   · a stable link keeps the EVM address, tagged with that stable, so every
 *     balance that pays it either sends that exact token or swaps into it
 *     (`routeFor`: `swap-to-stable`, never a direct EURC transfer);
 *   · a bitcoin link keeps the onchain bitcoin addresses only, so an Arkade
 *     balance pays the plain onchain one and a cash balance swaps into it;
 *   · a rail this person does not have refuses the whole intent. Nothing opens,
 *     rather than opening a payment for something the link never asked for.
 */
export function payIntentRecipient(
  recipient: SendRecipient,
  intent: PayIntent,
): SendRecipient | null {
  // A plain link names no currency, so there is nothing to narrow: every rail
  // the person has stays available (a BTC-only recipient must still be payable).
  if (!intent.explicit) return withPayIntentAmount(recipient, intent);
  const destinations = settleDestinations(recipient.destinations, intent.settle);
  if (destinations.length === 0) return null;
  return withPayIntentAmount({ ...recipient, destinations }, intent);
}

function settleDestinations(
  destinations: SendRecipient["destinations"],
  settle: PaySettleCurrency,
): SendRecipient["destinations"] {
  if (settle === "BTC") {
    // Onchain bitcoin only. The Ark and boarding addresses are a different
    // balance of theirs, and the boarding one is what a Lightning payer funds.
    return destinations.filter(
      (destination) =>
        destination.type === "crypto" &&
        destination.network === "bitcoin" &&
        destination.asset === "BTC",
    );
  }
  const asset = settle === "USDC_BASE" ? "USDC" : "EURC";
  const evm = destinations.find(
    (destination) =>
      destination.type === "crypto" &&
      (destination.network === "evm" || destination.network === "base") &&
      typeof destination.raw === "string" &&
      destination.raw.trim().length > 0,
  );
  // One address, tagged with the stable the link asks for: a Base address pays
  // only in that token (`tokenDestination`).
  return evm ? [{ type: "crypto", raw: evm.raw.trim(), network: "base", asset }] : [];
}
