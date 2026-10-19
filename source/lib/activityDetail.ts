// What the activity details screen shows for one row (#1708): who the other
// side is, which way the money went, and the row's state. Pure, so the rules
// are tested without rendering.

import type { Destination } from "./addressBook/contact";

export type ActivityPerson = {
  /** The saved contact's name, or "@username" from the Nuri directory. */
  name: string;
  /** Their Nuri username, when known. */
  username?: string;
};

export type ActivityDetailInput = {
  label: string;
  icon: string;
  pending?: boolean;
  incoming?: boolean;
  saveOffer?: { destination: Destination; name?: string } | null;
  counterpartyAddress?: string;
  /** The row's own figure, signed ("-EUR 5.00"). */
  amount?: string;
  /** Set on a swap leg: the swap's two sides stand in for any address. */
  swap?: SwapDetailSides;
};

type SwapDetailSide = { name: string; amount: string | null };
export type SwapDetailSides = { from: SwapDetailSide; to: SwapDetailSide };

export type ActivityDetail = {
  title: string;
  /** "@username" under the title, when the title is a contact's own name. */
  handle: string | null;
  /**
   * The other side's address or IBAN, and which way the money went. Only for
   * a side known by nothing else: a contact, a Nuri user, a named bank
   * account or a swap reads by its name, not by an address.
   */
  counterparty: { direction: "to" | "from"; value: string } | null;
  status: "pending" | "failed" | "completed";
  /**
   * A swap's From and To. The row's own side falls back to the row's figure
   * when the order carries no amount (an older saved copy, an order without
   * bounds): the money this wallet saw move is always stated.
   */
  swap: SwapDetailSides | null;
};

function swapSides(item: ActivityDetailInput): SwapDetailSides | null {
  if (!item.swap) return null;
  const own = item.incoming ? "to" : "from";
  const figure = item.amount?.trim().replace(/^-/, "") || null;
  const side = item.swap[own];
  return { ...item.swap, [own]: { ...side, amount: side.amount ?? figure } };
}

function destinationText(destination: Destination): string {
  if (destination.type === "bank") return destination.iban || destination.raw;
  if (destination.type === "card") return destination.number || destination.raw;
  return destination.raw;
}

export function activityDetail(
  item: ActivityDetailInput,
  person: ActivityPerson | null,
): ActivityDetail {
  const value = item.saveOffer
    ? destinationText(item.saveOffer.destination)
    : (item.counterpartyAddress ?? "");
  const handle = person?.username ? `@${person.username}` : null;
  const named = Boolean(person || item.swap || item.saveOffer?.name?.trim());
  return {
    title: person?.name ?? item.label,
    handle: handle && handle !== person?.name ? handle : null,
    counterparty:
      !named && value.trim() && item.incoming !== undefined
        ? { direction: item.incoming ? "from" : "to", value: value.trim() }
        : null,
    swap: swapSides(item),
    // Failed rows are the ones drawn with a cross (rejected, declined).
    status: item.pending ? "pending" : item.icon === "cross" ? "failed" : "completed",
  };
}
