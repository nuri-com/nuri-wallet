// Internal relative-timelock normalization shared by prod-tier and debug-tier arkade code.
import type { ArkadeRelativeTimelock } from "../ArkadeApiService";

export function normalizeArkadeRelativeTimelock(value: unknown): ArkadeRelativeTimelock | null {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const type = String(record?.type || "").trim();
  const raw = Number(record?.value);
  const normalizedValue = Math.trunc(raw);
  if ((type !== "blocks" && type !== "seconds") || !Number.isFinite(raw) || normalizedValue <= 0) {
    return null;
  }
  return { type, value: normalizedValue };
}
