// The last few passkey ceremonies, for the support dump.
//
// A blocked restore only posts support text (no dump), and a ceremony that dies
// before the platform shows any UI reaches no error handler at all, so a user
// who "cannot sign in" leaves no diagnostic trace anywhere. These records are
// deliberately tiny and secret-free: stage, outcome, duration and a sanitized
// error code. Never a credential id, PRF, challenge or assertion.

export type PasskeyCeremonyKind = "create" | "existing";
export type PasskeyCeremonyOutcome = "ok" | "error" | "timeout";

export type PasskeyCeremonyRecord = {
  atIso: string;
  kind: PasskeyCeremonyKind;
  outcome: PasskeyCeremonyOutcome;
  durationMs: number;
  code?: string;
};

const MAX_RECORDS = 5;
const records: PasskeyCeremonyRecord[] = [];

export function recordPasskeyCeremony(record: Omit<PasskeyCeremonyRecord, "atIso">): void {
  records.push({ ...record, atIso: new Date().toISOString() });
  if (records.length > MAX_RECORDS) {
    records.splice(0, records.length - MAX_RECORDS);
  }
}

export function getPasskeyCeremonyDiagnostics(): PasskeyCeremonyRecord[] {
  return records.slice();
}

export function resetPasskeyCeremonyDiagnostics(): void {
  records.length = 0;
}

const sanitizeCode = (value: string): string =>
  value
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 80);

export function formatPasskeyCeremonyLines(): string[] {
  if (records.length === 0) {
    return ["Passkey ceremonies none"];
  }
  return records.map((record) => {
    const code = record.code ? ` code=${sanitizeCode(record.code)}` : "";
    return `Passkey ceremony ${record.atIso} kind=${record.kind} outcome=${record.outcome} dur_ms=${record.durationMs}${code}`;
  });
}
