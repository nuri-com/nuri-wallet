// Nuri users suggested while a recipient is typed, saved in the address book
// or not. The server lists usernames starting with what was typed; this decides
// when to ask and which answers to show.
import { normalizeKenyanMobileNumber } from "../remit/kenyaPhone";
import { normalizeTanzanianMobileNumber } from "../remit/tanzaniaPhone";

/** The server answers nothing shorter. */
export const NURI_SEARCH_MIN_CHARS = 2;

/**
 * What to search for, or null when the entry cannot start a username (an
 * address, an invoice, a phone number, too short). A leading "@" is how people
 * write a handle and is dropped.
 */
export function nuriSearchPrefix(typed: string): string | null {
  // A phone number the send pays (written any way) is someone's number, never
  // sent to the name search.
  if (normalizeTanzanianMobileNumber(typed) || normalizeKenyanMobileNumber(typed)) return null;
  const value = String(typed || "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "");
  if (value.length < NURI_SEARCH_MIN_CHARS || value.length > 32) return null;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) return null;
  // Addresses look like names to the alphabet above; they never are one.
  if (/^0x[0-9a-f]{6,}$/.test(value) || /^(bc1|tb1|bcrt1|ark1|tark1|lnbc|lntb|lnurl)/.test(value)) {
    return null;
  }
  return value;
}

/**
 * The answers to show for `prefix`: only names that still start with it (an
 * answer to an earlier, shorter query may arrive late) and not people the
 * address book already lists, who show as contacts above.
 */
export function unsavedNuriUsers(
  usernames: readonly string[],
  prefix: string | null,
  contacts: ReadonlyArray<{ nuriUsername?: string; deleted?: boolean }>,
): string[] {
  if (!prefix) return [];
  const saved = new Set(
    contacts
      .filter((c) => !c.deleted && c.nuriUsername)
      .map((c) => String(c.nuriUsername).toLowerCase().replace(/^@/, "")),
  );
  const out: string[] = [];
  for (const raw of usernames) {
    const name = String(raw || "").toLowerCase();
    if (!name.startsWith(prefix) || saved.has(name) || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}
