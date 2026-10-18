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
  saveOffer?: { destination: Destination } | null;
  counterpartyAddress?: string;
};

export type ActivityDetail = {
  title: string;
  /** "@username" under the title, when the title is a contact's own name. */
  handle: string | null;
  /** The other side's address or IBAN, and which way the money went. */
  counterparty: { direction: "to" | "from"; value: string } | null;
  status: "pending" | "failed" | "completed";
};

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
  return {
    title: person?.name ?? item.label,
    handle: handle && handle !== person?.name ? handle : null,
    counterparty:
      value.trim() && item.incoming !== undefined
        ? { direction: item.incoming ? "from" : "to", value: value.trim() }
        : null,
    // Failed rows are the ones drawn with a cross (rejected, declined).
    status: item.pending ? "pending" : item.icon === "cross" ? "failed" : "completed",
  };
}
