// lib/activitySearch.ts
// Free-text search over activity rows (#1675): what the row shows (title,
// time/type line, amounts) plus who the other side is (a bank holder or
// IBAN, an address). Case- and accent-insensitive; spaces in the query are
// separate words that must all match. Pure.
import type { Destination } from "./addressBook/contact";

type SearchableRow = {
  label: string;
  sublabel?: string;
  amount?: string;
  amountSecondary?: string;
  counterpartyAddress?: string;
  saveOffer?: { destination: Destination; name?: string } | null;
};

/** Lower-case, accents dropped, so "Cafe" finds "Café". */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

/** The words of a query; none for an empty or blank one. */
export function searchWords(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean);
}

function haystack(row: SearchableRow, shownAs: readonly (string | undefined)[]): string {
  const destination = row.saveOffer?.destination;
  const parts = [
    row.label,
    // What the list actually shows for the row (a saved contact's name).
    ...shownAs,
    row.sublabel,
    row.amount,
    row.amountSecondary,
    row.counterpartyAddress,
    row.saveOffer?.name,
    // A card number is not searchable; its holder is.
    destination && destination.type !== "card" ? destination.raw : undefined,
    destination && "holder" in destination ? destination.holder : undefined,
  ];
  const text = fold(parts.filter((part): part is string => Boolean(part)).join("\n"));
  // An IBAN or amount typed with or without its spaces matches either way.
  return `${text}\n${text.replace(/\s+/g, "")}`;
}

/**
 * The rows matching every word of `query`, in their order; all rows for a
 * blank query. `shownAs` adds what the list renders for a row beyond its raw
 * fields (the saved contact's name, the Nuri username), so a row is found by
 * the name on screen.
 */
export function filterActivityRows<T extends SearchableRow>(
  rows: T[],
  query: string,
  shownAs: (row: T) => readonly (string | undefined)[] = () => [],
): T[] {
  const words = searchWords(query);
  if (words.length === 0) return rows;
  return rows.filter((row) => {
    const text = haystack(row, shownAs(row));
    return words.every((word) => text.includes(word));
  });
}
