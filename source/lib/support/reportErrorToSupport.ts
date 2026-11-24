import { EventBus } from "../../services/events/AppEventBusService";
import type { SupportDumpAppSnapshot } from "../../services/support/SupportDumpService";
import { sendSupportDump } from "../../services/support/SupportDumpService";
import { redact } from "../log/redact";
import { SUPPORT_PUBKEY } from "../nostr/unread";
import { explainError } from "./knownErrors";

// Reusable standard: instead of showing an error on screen, report it to support.
// Sends the diagnostic dump (the error with secrets redacted) silently, and
// emits an event so a mounted SupportModals opens the chat and auto-sends a
// plain-English report on the user's behalf (#2008): what was tried, the known
// explanation (or that the cause is unknown) and the report id that links the
// chat message to its dump. The raw error never reaches the chat.
// Any screen can call this; any screen mounting SupportModals can listen via "support:report".

const DEFAULT_HELP_LINE = "Something in the app did not work.";
const LOG_ERROR_MAX_CHARS = 120;

// One id per report, shared by the chat message and the dump it points to.
const newReportId = (): string =>
  `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`.slice(0, 24);

/** The visible chat message of a report: plain words and the report id only. */
export function supportReportChatMessage(opts: {
  userMessage?: string;
  error: unknown;
  reportId: string;
}): string {
  const help = opts.userMessage?.trim() || DEFAULT_HELP_LINE;
  const { explanation } = explainError(opts.error);
  return `Automatic report from the app:\n${help}\n${explanation}\nReport ${opts.reportId}`;
}

// Extract a human-readable message from any thrown value. Plain objects with a
// `message` field (e.g. API error payloads) would otherwise stringify to
// "[object Object]", which is useless in the support dump.
const extractErrorText = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message ?? "");
  }
  return String(error ?? "");
};

// Errors already reported, so a caller further up the same failure — which
// cannot know a lower layer spoke first — does not send a second report of it.
const reportedErrors = new WeakSet<object>();

const markReportedToSupport = (error: unknown): void => {
  if (error !== null && typeof error === "object") reportedErrors.add(error);
};

/** Whether this very error has already gone to support. */
export const wasReportedToSupport = (error: unknown): boolean =>
  error !== null && typeof error === "object" && reportedErrors.has(error);

/** Where the diagnostic report for one error got to. "sent" means a support
 * relay acknowledged it, nothing less. */
export type SupportReportState =
  | { state: "sending" }
  | { state: "sent"; reportId: string }
  | { state: "failed" };

const reportStates = new WeakMap<object, SupportReportState>();
const reportListeners = new Set<() => void>();

const setReportState = (keys: readonly unknown[], next: SupportReportState): void => {
  for (const key of keys) {
    if (key !== null && typeof key === "object") reportStates.set(key, next);
  }
  for (const listener of reportListeners) {
    try {
      listener();
    } catch {}
  }
};

/** The report state of this very error, or null when it was never reported. */
export const supportReportState = (error: unknown): SupportReportState | null =>
  error !== null && typeof error === "object" ? (reportStates.get(error) ?? null) : null;

/** Called whenever any report changes state. */
export const subscribeSupportReports = (listener: () => void): (() => void) => {
  reportListeners.add(listener);
  return () => {
    reportListeners.delete(listener);
  };
};

const firstLine = (text: string): string => {
  const line = String(text || "")
    .split("\n")[0]
    .trim();
  if (line.length <= LOG_ERROR_MAX_CHARS) return line;
  return `${line.slice(0, LOG_ERROR_MAX_CHARS)}…`;
};

export async function reportErrorToSupport(opts: {
  error: unknown;
  userMessage?: string;
  appSnapshot?: SupportDumpAppSnapshot;
  /** Sanitized context for the dump only (route, phase, server call), never
   * the visible chat line. Must not contain addresses, amounts or keys. */
  detail?: string;
  /** The value this report is about, when `error` is a wrapped copy of it, so
   * a surface holding the original can tell it was reported. */
  subject?: unknown;
  /** Open the support chat with a visible message. A surface that shows the
   * report's progress itself (and offers the chat after) passes false: the
   * error then travels only in the silent report. */
  openChat?: boolean;
}): Promise<void> {
  const keys = [opts.error, opts.subject];
  // One failure, one report: a second catch of the same failure (a caller up
  // the stack, a repeated callback) sends nothing. Only a report that failed
  // to deliver may be sent again.
  const previous = keys.map(supportReportState).find((state) => state !== null);
  if (previous && previous.state !== "failed") return;
  for (const key of keys) markReportedToSupport(key);
  setReportState(keys, { state: "sending" });
  const reportId = newReportId();
  const help = opts.userMessage?.trim() || DEFAULT_HELP_LINE;
  const { code } = explainError(opts.error);
  const errorText = redact(extractErrorText(opts.error));
  const detail = opts.detail?.trim();
  // The context goes first: a long server message must not push it out of a
  // truncated diagnostic body.
  const dumpErrorText = [`known=${code ?? "unknown"}`, detail, errorText]
    .filter(Boolean)
    .join("\n");

  // Visible chat message: plain words and the report id, never the error
  // itself. A report ALWAYS opens the chat: support only ever hears about a
  // failure the user was told about; a caller that shows the failure and the
  // report itself opts out with `openChat: false`.
  if (opts.openChat !== false) {
    EventBus.emit("support:report", {
      message: supportReportChatMessage({ userMessage: help, error: opts.error, reportId }),
    });
  }

  // Full diagnostics (incl. full untruncated error) sent silently to support.
  try {
    // Static like every other app module (project rule): a dropped dynamic target fails the
    // support report at the exact moment it is needed.
    const sent = await sendSupportDump({
      supportPubkey: SUPPORT_PUBKEY,
      dumpId: reportId,
      note: `${help}\n\n${dumpErrorText}`,
      appSnapshot: opts.appSnapshot,
      // Automatic report: never block the user with a biometric prompt.
      skipBiometricUnlock: true,
    });
    setReportState(
      keys,
      sent && sent.relaysAckedOk > 0
        ? { state: "sent", reportId: sent.dumpId }
        : { state: "failed" },
    );
  } catch (dumpError) {
    setReportState(keys, { state: "failed" });
    // Dump failure must never block the user-facing support chat, but log a
    // sanitized reason so we can monitor the health of the support path.
    // Only the message (never the raw error object) to avoid leaking payload data.
    console.warn(
      `[reportErrorToSupport] silent support dump failed: ${firstLine(extractErrorText(dumpError))}`,
    );
  }
}
