// Pure CSV text building. No platform imports, so row builders and their tests
// can use it; writing/sharing the file lives in lib/csvExport.ts.

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (!/[",\n\r]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/** One CSV document: the header line, then one line per row. */
export function csvDocument(
  header: readonly string[],
  rows: readonly (readonly unknown[])[],
): string {
  return [header, ...rows].map((cells) => cells.map(csvEscape).join(",")).join("\n");
}

/** `<prefix>-YYYY-MM-DD.csv`, dated in UTC like every export before it. */
export function csvFileName(prefix: string, now: Date = new Date()): string {
  return `${prefix}-${now.toISOString().slice(0, 10)}.csv`;
}
