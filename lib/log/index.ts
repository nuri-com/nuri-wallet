// lib/log — a small, reusable logging system.
//
// One line = `HH:MM:SS  <emoji>  <one human sentence>`, never truncated: only
// redact() gates content, and it drops nothing but key material. The emoji
// is the source file's identity (see fileEmoji.ts). Idle app = silence: routine
// detail is `trace` and muted by default; user actions, calls, state changes and
// errors are `event`/`warn`/`error` and always show.
//
// Usage — one declaration at the top of a file, then finished sentences:
//   const log = logger("services/arkade/ArkadeReceiveUnlockService.ts");
//   log.event(`Receive claim started — swap ${id}, ${sats} sats`);
//   log.trace("vtxos_ready count=2");            // muted unless level = trace
//   log.error("Subscription lost — reconnecting", err);  // always prints
//
// Portable: depends only on ./redact and ./fileEmoji (both pure), Date, console.

import { emojiFor } from "./fileEmoji";
import { redact } from "./redact";

export { FILE_EMOJI, emojiFor, emojiForSource, assertUniqueEmojis } from "./fileEmoji";
export { redact } from "./redact";

export type LogLevel = "trace" | "event" | "user" | "warn" | "error";

// Console shows a line when its rank >= the current minimum. Default = event, so
// trace is muted while warn/error always outrank it and never hide.
const RANK: Record<LogLevel, number> = { trace: 0, event: 1, user: 1, warn: 2, error: 3 };
let minRank: number = RANK.event;

export type ConsoleLevel = "trace" | "event" | "warn";
export function setLogLevel(level: ConsoleLevel): void {
  minRank = RANK[level];
}
export function getLogLevel(): ConsoleLevel {
  if (minRank <= RANK.trace) return "trace";
  if (minRank >= RANK.warn) return "warn";
  return "event";
}

// ── ring buffer (support dumps / in-app log viewers) ──────────────────
export type LogEntry = {
  ts: number;
  level: LogLevel;
  emoji: string;
  file: string;
  message: string;
};
let buffer: LogEntry[] = [];
let bufferCap = 800;
const bufferListeners = new Set<(entry: LogEntry) => void>();

export function getLogBuffer(limit?: number): LogEntry[] {
  const n = limit && limit > 0 ? Math.min(Math.floor(limit), buffer.length) : buffer.length;
  return buffer.slice(buffer.length - n).map((entry) => ({ ...entry }));
}
export function clearLogBuffer(): void {
  buffer = [];
}
export function setLogBufferCap(n: number): void {
  bufferCap = Math.max(50, Math.floor(n));
}
export function subscribeLogBuffer(listener: (entry: LogEntry) => void): () => void {
  bufferListeners.add(listener);
  return () => {
    bufferListeners.delete(listener);
  };
}

// ── content dedup (kills the same line fired from N sources within ms) ─
const DEDUP_MS = 4000;
const seen = new Map<string, number>();
function isDuplicate(key: string, now: number): boolean {
  const last = seen.get(key);
  seen.delete(key); // re-insert to keep Map ordered oldest→newest
  seen.set(key, now);
  if (seen.size > 600) {
    const oldest = seen.keys().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return last !== undefined && now - last < DEDUP_MS;
}

// ── repeat collapse (warn/error) ──────────────────────────────────────
// A failing retry loop fires the same error every poll tick. Printing all of
// them buries the signal: 24 identical lines read as noise, not as "this has
// been failing for 5 minutes". So print the first immediately, swallow the
// repeats, and re-print once a minute carrying the count and the start time —
// an ongoing failure stays visible without drowning the timeline.
const REPEAT_MS = 60_000;
type Streak = { first: number; last: number; count: number };
const streaks = new Map<string, Streak>();

// Returns the suffix to append, or null when this line should be swallowed.
function repeatSuffix(key: string, now: number): string | null {
  const s = streaks.get(key);
  if (!s || now - s.last > REPEAT_MS) {
    streaks.set(key, { first: now, last: now, count: 1 });
    if (streaks.size > 300) {
      const oldest = streaks.keys().next().value;
      if (oldest !== undefined) streaks.delete(oldest);
    }
    return "";
  }
  s.count += 1;
  s.last = now;
  if (now - s.first < REPEAT_MS) return null; // swallow inside the window
  const suffix = ` (×${s.count} seit ${hms(s.first)})`;
  streaks.set(key, { first: now, last: now, count: 1 }); // open the next window
  return suffix;
}

function hms(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// `HH:MM:SS  <emoji>  <message>` — never truncated. A cut-off txId or error
// costs a debugging round-trip; redact() already keeps key material out.
export function formatLine(now: number, emoji: string, message: string): string {
  return `${hms(now)}  ${emoji}  ${message}`;
}

// Thousands separators for money in log sentences: group(9975) => "9,975".
// Uses a plain regex, not Intl (Hermes ships without full ICU).
export function group(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function errText(err: unknown): string {
  if (err == null) return "";
  if (err instanceof Error) return err.message;
  return String(err);
}

function write(level: LogLevel, line: string): void {
  // eslint-disable-next-line no-console
  if (level === "error") console.error(line);
  // eslint-disable-next-line no-console
  else if (level === "warn") console.warn(line);
  // eslint-disable-next-line no-console
  else console.log(line);
}

export type FileLogger = {
  event: (message: string) => void;
  user: (message: string) => void;
  trace: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string, err?: unknown) => void;
  // Same logger, every line tagged `id=<correlationId>`. One vorgang (a swap, an
  // order, a claim) usually spans several files and therefore several emojis;
  // without a shared id you reconstruct it from timestamps. With it, one grep
  // returns the whole story: `grep 'id=sk_9db09' metro.log`.
  for: (correlationId: string) => FileLogger;
};

export function logger(file: string, correlationId?: string): FileLogger {
  const emoji = emojiFor(file);
  const idTag = correlationId ? ` id=${correlationId}` : "";

  const emit = (level: LogLevel, rawMessage: string, err?: unknown): void => {
    try {
      let message = redact(String(rawMessage ?? ""))
        .replace(/\s+/g, " ")
        .trim();
      if (err !== undefined) {
        const detail = redact(errText(err)).replace(/\s+/g, " ").trim();
        if (detail) message = message ? `${message} — ${detail}` : detail;
      }
      if (!message) return;

      const now = Date.now();
      const key = `${emoji} ${message}${idTag}`;
      // Errors/warnings are never gated away, but a retry loop repeating the
      // same failure collapses into one line per minute carrying the count.
      if (level === "warn" || level === "error") {
        const suffix = repeatSuffix(key, now);
        if (suffix === null) return;
        message += idTag + suffix;
      } else {
        if (isDuplicate(key, now)) return;
        message += idTag;
      }

      const entry: LogEntry = { ts: now, level, emoji, file, message };
      buffer.push(entry);
      if (buffer.length > bufferCap) buffer = buffer.slice(buffer.length - bufferCap);
      for (const listener of bufferListeners) {
        try {
          listener(entry);
        } catch {
          // a broken listener must not break logging
        }
      }

      if (RANK[level] >= minRank) write(level, formatLine(now, emoji, message));
    } catch {
      // logging must never throw into the app
    }
  };

  return {
    for: (id: string) => logger(file, id),
    event: (message) => emit("event", message),
    user: (message) => emit("user", message),
    trace: (message) => emit("trace", message),
    warn: (message) => emit("warn", message),
    error: (message, err) => emit("error", message, err),
  };
}
