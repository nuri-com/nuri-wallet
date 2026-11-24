// What a scanner Paste hands to the manual recipient step when the scanner
// itself cannot route it (a Nuri username, a partial address, any text). The
// user tapped Paste once; the recipient field shows that text so they review
// and continue instead of pasting a second time (#1705). Nothing is submitted.

/** Longer than any recipient we route: not worth showing in a one-line field. */
export const PASTE_PREFILL_MAX_LENGTH = 512;

export function pastePrefill(raw: string | null | undefined): string | undefined {
  const text = (raw ?? "").trim();
  if (!text || text.length > PASTE_PREFILL_MAX_LENGTH) return undefined;
  return text;
}
