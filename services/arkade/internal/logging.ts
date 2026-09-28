// Internal trace emit/subscribe and structured sign/error trace logging shared by both prod-tier and debug-tier arkade code.
import { logger } from "../../../lib/log";
import type { ArkadeWalletDebugTrace } from "./types";

// Arkade internal breadcrumbs are trace-tier: muted by default, shown when
// LOG_LEVEL=trace. Real milestones are logged as `event` by the owning file.
const traceLog = logger("services/arkade/internal/logging.ts");

const traceSubscribers: Set<(trace: ArkadeWalletDebugTrace) => void> = new Set();

export function emitTrace(trace: ArkadeWalletDebugTrace): void {
  traceSubscribers.forEach((cb) => {
    try {
      cb(trace);
    } catch {}
  });
}

export function subscribeArkadeWalletDebugTrace(
  callback: (trace: ArkadeWalletDebugTrace) => void,
): () => void {
  traceSubscribers.add(callback);
  return () => {
    traceSubscribers.delete(callback);
  };
}

function signTraceValue(value: unknown): string {
  if (value === null || value === undefined) return "n/a";
  if (typeof value === "string") return value.replace(/\s+/g, "_");
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.join(",");
  return String(value).replace(/\s+/g, "_");
}

export function logArkadeWalletSignTrace(step: string, fields: Record<string, unknown> = {}): void {
  const detail = Object.entries(fields)
    .map(([key, value]) => `${key}=${signTraceValue(value)}`)
    .join(" ");
  traceLog.trace(`${step}${detail ? ` ${detail}` : ""}`);
}

export function logArkadeWalletErrorTrace(
  step: string,
  fields: Record<string, unknown> = {},
): void {
  const detail = Object.entries(fields)
    .map(([key, value]) => `${key}=${signTraceValue(value)}`)
    .join(" ");
  traceLog.error(`${step}${detail ? ` ${detail}` : ""}`);
}
