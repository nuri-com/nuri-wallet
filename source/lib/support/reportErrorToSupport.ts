import { EventBus } from "../../services/events/AppEventBusService";
import type { SupportDumpAppSnapshot } from "../../services/support/SupportDumpService";
import { sendSupportDump } from "../../services/support/SupportDumpService";
import { SUPPORT_PUBKEY } from "../nostr/unread";

// Reusable standard: instead of showing an error on screen, report it to support.
// Sends the full diagnostic dump (incl. full error) silently, and emits an event
// so a mounted SupportModals opens the chat and auto-sends a short visible message.
// Any screen can call this; any screen mounting SupportModals can listen via "support:report".

const DEFAULT_HELP_LINE = "Something went wrong, please help!";
const CHAT_ERROR_MAX_CHARS = 120;

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

const firstLine = (text: string): string => {
  const line = String(text || "")
    .split("\n")[0]
    .trim();
  if (line.length <= CHAT_ERROR_MAX_CHARS) return line;
  return `${line.slice(0, CHAT_ERROR_MAX_CHARS)}…`;
};

export async function reportErrorToSupport(opts: {
  error: unknown;
  userMessage?: string;
  appSnapshot?: SupportDumpAppSnapshot;
}): Promise<void> {
  markReportedToSupport(opts.error);
  const help = opts.userMessage?.trim() || DEFAULT_HELP_LINE;
  const errorText = extractErrorText(opts.error);

  // Visible chat message: help line + truncated first line of the error (full
  // error goes in the dump). A report ALWAYS opens the chat — support only ever
  // hears about a failure the user was shown, never one they were not.
  const chatMessage = errorText ? `${help}\n${firstLine(errorText)}` : help;
  EventBus.emit("support:report", { message: chatMessage });

  // Full diagnostics (incl. full untruncated error) sent silently to support.
  try {
    // Static like every other app module (project rule): a dropped dynamic target fails the
    // support report at the exact moment it is needed.
    await sendSupportDump({
      supportPubkey: SUPPORT_PUBKEY,
      note: errorText ? `${help}\n\n${errorText}` : help,
      appSnapshot: opts.appSnapshot,
      // Automatic report: never block the user with a biometric prompt.
      skipBiometricUnlock: true,
    });
  } catch (dumpError) {
    // Dump failure must never block the user-facing support chat, but log a
    // sanitized reason so we can monitor the health of the support path.
    // Only the message (never the raw error object) to avoid leaking payload data.
    console.warn(
      `[reportErrorToSupport] silent support dump failed: ${firstLine(extractErrorText(dumpError))}`,
    );
  }
}
