// Fits the support dump's log lines into one message and says what it covers.
//
// The dump goes out as a single encrypted Nostr event, so it has a hard size
// budget. Lines are kept newest first until the budget is full, then put back in
// time order. A "Coverage" line between the header and the logs names the first
// and last shown entry and how many older entries did not fit, so support can
// tell a short journey from a cut one.

// Manual "Share Info" (user-initiated, consented), measured in UTF-8 bytes.
// Large enough to follow one payment journey from preparation to outcome; the
// gift-wrapped event (rumor -> seal -> wrap, two NIP-44 layers) stays far below
// the 65,535-byte NIP-44 plaintext limit and common relay message limits.
export const SHARE_INFO_DUMP_TEXT_BYTES = 12_000;

// The coverage line is reserved up front so it never pushes logs over budget.
const COVERAGE_LINE_RESERVE = 160;

export type DumpLogLine = { ts: number; text: string };

export type FittedDumpText = {
  text: string;
  shownCount: number;
  omittedCount: number;
};

const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

export function utf8Length(text: string): number {
  if (encoder) return encoder.encode(text).length;
  return unescape(encodeURIComponent(text)).length;
}

export function formatCoverageLine(opts: {
  first: string | null;
  last: string | null;
  shownCount: number;
  totalCount: number;
  budget: number;
}): string {
  const omitted = Math.max(0, opts.totalCount - opts.shownCount);
  const range = opts.first && opts.last ? `${opts.first}..${opts.last}` : "none";
  return `Coverage ${range} shown=${opts.shownCount}/${opts.totalCount} omitted=${omitted} budget=${opts.budget}`;
}

// When more entries are selected than the cap allows, first reserve the newest
// `reserveTail` entries (the current journey, so noisy older failures cannot
// evict it), then keep warnings/errors (newest first), fill with the newest
// remaining entries, and return them in their original (time) order. Order
// matters: fitDumpText keeps the END of the list as the newest lines.
export function capPreferringIssues<T extends { level: string }>(
  entries: T[],
  max: number,
  reserveTail = 0,
): T[] {
  const limit = Math.max(0, Math.floor(max));
  if (entries.length <= limit) return entries.slice();
  const keep = new Set<number>();
  const tail = Math.min(limit, Math.max(0, Math.floor(reserveTail)));
  for (let i = entries.length - 1; i >= entries.length - tail; i -= 1) {
    keep.add(i);
  }
  for (let i = entries.length - 1; i >= 0 && keep.size < limit; i -= 1) {
    const level = entries[i].level;
    if (level === "error" || level === "warn") keep.add(i);
  }
  for (let i = entries.length - 1; i >= 0 && keep.size < limit; i -= 1) {
    keep.add(i);
  }
  return Array.from(keep)
    .sort((a, b) => a - b)
    .map((i) => entries[i]);
}

// `measure` defaults to string length (automatic reports, unchanged); manual
// Share Info passes utf8Length so the byte budget holds with emoji/non-Latin text.
// `availableCount` is how many log entries existed before selection (selection
// drops older ordinary entries); coverage counts against it so support sees how
// much history the dump does not carry.
export function fitDumpText(opts: {
  header: string;
  lines: DumpLogLine[];
  budget: number;
  formatTime: (ts: number) => string;
  measure?: (text: string) => number;
  availableCount?: number;
}): FittedDumpText {
  const { header, lines, formatTime } = opts;
  const measure = opts.measure ?? ((text: string) => text.length);
  const budget = Math.max(COVERAGE_LINE_RESERVE * 2, Math.floor(opts.budget));
  const totalCount = Math.max(lines.length, Math.floor(opts.availableCount ?? 0));
  const coverageFor = (picked: DumpLogLine[]) =>
    formatCoverageLine({
      first: picked.length > 0 ? formatTime(picked[0].ts) : null,
      last: picked.length > 0 ? formatTime(picked[picked.length - 1].ts) : null,
      shownCount: picked.length,
      totalCount,
      budget,
    });

  const headerSize = measure(header);
  if (headerSize + 1 + COVERAGE_LINE_RESERVE >= budget) {
    const coverage = coverageFor([]);
    let head = header.slice(0, Math.max(0, budget - coverage.length - 1));
    while (head && measure(head) + 1 + coverage.length > budget) {
      head = head.slice(0, Math.floor(head.length * 0.9));
    }
    return {
      text: head ? `${head}\n${coverage}` : coverage,
      shownCount: 0,
      omittedCount: totalCount,
    };
  }

  const remaining = budget - headerSize - 1 - COVERAGE_LINE_RESERVE - 1;
  const picked: DumpLogLine[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const size = measure(line.text);
    const next = used === 0 ? size : used + 1 + size;
    if (next > remaining) break;
    picked.push(line);
    used = next;
  }
  picked.reverse();

  const coverage = coverageFor(picked);
  const body = picked.map((l) => l.text).join("\n");
  return {
    text: body ? `${header}\n${coverage}\n${body}` : `${header}\n${coverage}`,
    shownCount: picked.length,
    omittedCount: totalCount - picked.length,
  };
}
