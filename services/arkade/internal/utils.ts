// Internal pure utilities (record guards, hex, timeout, log truncation, zero summary) shared by both prod-tier and debug-tier arkade code.
import type { ArkadeWalletSummary } from "../types/wallet";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function hexToBytesLocal(value: string): Uint8Array {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]+$/.test(normalized) || normalized.length % 2 !== 0) {
    return new Uint8Array();
  }
  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function withTimeout<T>(label: string, timeoutMs: number, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        reject(new Error(`${label} timeout after ${timeoutMs}ms`));
      },
      Math.max(1, timeoutMs),
    );

    work
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

function compactArkadeErrorText(input: string): string {
  const text = String(input || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "unknown";
  const lower = text.toLowerCase();
  if (
    lower.includes("arkade.computer") &&
    (lower.includes("unexpected status 429") ||
      lower.includes("cloudflare") ||
      lower.includes("error 1015") ||
      lower.includes("rate limited"))
  ) {
    return "arkade_indexer_rate_limited http_429 cloudflare_1015";
  }
  return text;
}

export function truncateForLog(input: string, max = 140): string {
  const text = compactArkadeErrorText(input);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

export function errorMessageText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const value = (error as { message?: unknown }).message;
    if (typeof value === "string") return value;
  }
  return String(error ?? "");
}

export function compactArkadeLogValue(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function stringifyArkadeErrorData(value: unknown, max = 220): string {
  if (value == null) return "";
  if (typeof value === "string") {
    return truncateForLog(compactArkadeLogValue(value), max);
  }
  try {
    return truncateForLog(compactArkadeLogValue(JSON.stringify(value)), max);
  } catch {
    return truncateForLog(compactArkadeLogValue(String(value)), max);
  }
}

export function isZeroArkadeWalletSummary(
  summary: ArkadeWalletSummary | null | undefined,
): boolean {
  if (!summary) return true;
  return (
    Number(summary.balanceTotalSats || "0") === 0 &&
    Number(summary.balanceBoardingTotalSats || "0") === 0 &&
    Number(summary.balanceAvailableSats || "0") === 0 &&
    Number(summary.balanceSettledSats || "0") === 0 &&
    Number(summary.balancePreconfirmedSats || "0") === 0 &&
    Number(summary.balanceRecoverableSats || "0") === 0
  );
}
