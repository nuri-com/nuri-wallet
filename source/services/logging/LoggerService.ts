import { KNOWN_EMOJIS } from "../../lib/logShared";
import { logWithId, LOG_EMOJI } from "../../lib/OperationLogUtils";

export const DEBUG_LOGS_ENABLED = true;
const DEFAULT_EMOJI = "🧩";

function compactWhitespace(text: string): string {
  return (
    String(text ?? "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape stripping
      .replace(/\u001b\[[0-9:;?]*[ -/]*[@-~]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function splitLeadingEmoji(text: string): { emoji: string | null; rest: string } {
  const normalized = compactWhitespace(text);
  if (!normalized) return { emoji: null, rest: "" };

  for (const emoji of KNOWN_EMOJIS) {
    if (normalized === emoji) {
      return { emoji, rest: "" };
    }
    if (normalized.startsWith(`${emoji} `)) {
      return { emoji, rest: normalized.slice(emoji.length).trimStart() };
    }
  }

  return { emoji: null, rest: normalized };
}

function inferEmoji(text: string): string {
  const normalized = compactWhitespace(text);
  for (const emoji of KNOWN_EMOJIS) {
    if (normalized.includes(emoji)) return emoji;
  }
  if (/(network|fetch|axios|http|url|api)/i.test(normalized)) return LOG_EMOJI.network;
  if (/(auth|jwt|nonce|key|biometric|siwe|sign)/i.test(normalized)) return LOG_EMOJI.auth;
  if (/(card|balance|payment)/i.test(normalized)) return LOG_EMOJI.card;
  if (/(iban|bank)/i.test(normalized)) return LOG_EMOJI.iban;
  if (/(wallet|address)/i.test(normalized)) return LOG_EMOJI.wallet;
  if (/(bitcoin|btc|mempool|satoshi)/i.test(normalized)) return LOG_EMOJI.bitcoin;
  return DEFAULT_EMOJI;
}

function inferLegacyId(message: string): string {
  const { emoji: leadingEmoji, rest } = splitLeadingEmoji(message);
  const normalized = rest || compactWhitespace(message);
  const emoji = leadingEmoji || inferEmoji(normalized);
  const bracketTag = normalized.match(/^\[([A-Za-z0-9_.:-]+)\]/)?.[1];
  const fallbackTag = normalized.split(/\s+/)[0]?.replace(/[^A-Za-z0-9_.:-]+/g, "") || "legacy";
  const tag = bracketTag || fallbackTag || "legacy";
  return `${emoji} ${tag}.log`;
}

function normalizeExtra(extra: unknown[]): unknown {
  if (extra.length === 0) return undefined;
  if (extra.length === 1) return extra[0];
  return extra;
}

export function log(message: string, ...extra: unknown[]) {
  if (!DEBUG_LOGS_ENABLED) return;

  const body = compactWhitespace(message);
  logWithId(inferLegacyId(body), body || "-", normalizeExtra(extra));
}

export function slog(label: string, value: any) {
  if (!DEBUG_LOGS_ENABLED) return;

  logWithId(
    `${LOG_EMOJI.storage} sensitive.log`,
    `[SENSITIVE] ${compactWhitespace(label) || "value"}`,
    value,
  );
}
