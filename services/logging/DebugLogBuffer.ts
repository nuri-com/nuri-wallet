/**
 * In-memory ring buffer for console logs, used for support dumps.
 *
 * Logging goals:
 * 1) Every line starts with an emoji.
 * 2) Stable, one-line structured format for filtering.
 * 3) Always include source (`src=file#function`) for fast traceability.
 * 4) Keep only truly sensitive key material redacted.
 */

import {
  LOG_MAX_MSG_CHARS,
  LOG_MAX_SOURCE_CHARS,
  LOG_REPEAT_SUPPRESS_WINDOW_MS,
  LOG_POLL_REPEAT_SUPPRESS_WINDOW_MS,
} from "../../config/constants";
import { compactWhitespace } from "../../lib/compactWhitespace";
import { emojiForSource, getLogLevel } from "../../lib/log";
import {
  cleanFunc,
  compactPath,
  KNOWN_EMOJIS,
  shortTime,
  splitLeadingEmoji,
} from "../../lib/logShared";

export type BufferedLogLevel = "log" | "warn" | "error" | "info" | "debug";

export type BufferedLogEntry = {
  ts: number;
  level: BufferedLogLevel;
  message: string;
};

type InstallOptions = {
  maxEntries?: number;
  maxEntryChars?: number;
};

const GLOBAL_INSTALLED_KEY = "__nuriConsoleBufferInstalled";

const LEVELS: BufferedLogLevel[] = ["log", "warn", "error", "info", "debug"];
const DEFAULT_EMOJI = "🧩";
const LEVEL_EMOJI: Record<BufferedLogLevel, string> = {
  log: DEFAULT_EMOJI,
  info: "ℹ️",
  warn: "⚠️",
  error: "❌",
  debug: "🐞",
};
const LEVEL_LABEL: Record<BufferedLogLevel, "INFO" | "WARN" | "ERROR" | "DEBUG"> = {
  log: "INFO",
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
  debug: "DEBUG",
};

const GROUP_BY_EMOJI: Record<string, string> = {
  "🌐": "Network",
  "🔐": "Auth",
  "💳": "Card",
  "🏦": "Iban",
  "💼": "Wallet",
  "₿": "Bitcoin",
  "🗄️": "Storage",
  "🏁": "App",
  "📝": "Auth",
  "✅": "App",
  "❌": "App",
  "⏱️": "App",
  "⚠️": "App",
  ℹ️: "App",
  "🐞": "Debug",
  "🧩": "General",
};

const GROUP_HINTS: Array<{ re: RegExp; group: string; emoji: string }> = [
  { re: /(bitcoin|btc|mempool|satoshi|utxo|txid|psbt|esplora)/i, group: "Bitcoin", emoji: "₿" },
  {
    re: /(network|fetch|axios|http|url|api|request|response|status=)/i,
    group: "Network",
    emoji: "🌐",
  },
  {
    re: /(auth|jwt|nonce|siwe|biometric|passkey|signature|token|key)/i,
    group: "Auth",
    emoji: "🔐",
  },
  { re: /(card|balance|payment|pin|cvv)/i, group: "Card", emoji: "💳" },
  { re: /(iban|bank|bic|sepa)/i, group: "Iban", emoji: "🏦" },
  { re: /(wallet|safe|address)/i, group: "Wallet", emoji: "💼" },
  { re: /(storage|keychain|secure storage)/i, group: "Storage", emoji: "🗄️" },
  { re: /(kyc|applicant|sumsub)/i, group: "Kyc", emoji: "🏁" },
  { re: /(eventbus|event:|emit )/i, group: "EventBus", emoji: "🏁" },
];

const SOURCE_GROUP_HINTS: Array<{ re: RegExp; group: string }> = [
  { re: /(^|\/)services\/network/i, group: "Network" },
  { re: /(^|\/)services\/appeventbus/i, group: "EventBus" },
  { re: /(^|\/)services\/auth|authstateservice/i, group: "Auth" },
  { re: /(^|\/)screens\/cardscreen/i, group: "Card" },
  { re: /(^|\/)screens\/walletscreen|walletservice/i, group: "Wallet" },
  { re: /(^|\/)kyc/i, group: "Kyc" },
  { re: /bitcoin|btc|mempool/i, group: "Bitcoin" },
  { re: /(^|\/)storage|keychain|securekey/i, group: "Storage" },
];

const INTERNAL_STACK_MARKERS = [
  "DebugLogBuffer",
  "OperationLogUtils",
  "LoggerService",
  "getCallerSource",
  "normalizeConsoleMessage",
];

let buffer: BufferedLogEntry[] = [];
let maxEntries = 320;
let maxEntryChars = 900;
let lastEmitTs = 0;
const recentLineTs = new Map<string, number>();

const originalConsole: Partial<Record<BufferedLogLevel, (...args: unknown[]) => void>> = {};

function truncate(text: string, limit: number): string {
  const raw = String(text ?? "");
  if (!raw) return "";
  if (raw.length <= limit) return raw;
  return `${raw.slice(0, limit)}…[truncated ${raw.length - limit}]`;
}

function compactText(text: string, max: number): string {
  return truncate(compactWhitespace(text), max);
}

function stableToken(text: string, max = 40): string {
  const normalized = compactWhitespace(text)
    .replace(/[^A-Za-z0-9_.:-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized) return "unknown";
  return compactText(normalized, max);
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, v) => {
      if (typeof v === "bigint") return v.toString();
      if (typeof v === "string" && v.length > 8000) {
        return `${v.slice(0, 8000)}…[truncated ${v.length - 8000}]`;
      }
      if (v && typeof v === "object") {
        if (seen.has(v as object)) return "[Circular]";
        seen.add(v as object);
      }
      return v;
    });
  } catch {
    try {
      return String(value);
    } catch {
      return "[Unserializable]";
    }
  }
}

function formatArg(arg: unknown): string {
  if (arg === null) return "null";
  if (arg === undefined) return "undefined";
  if (typeof arg === "string") return arg;
  if (typeof arg === "number" || typeof arg === "boolean" || typeof arg === "bigint") {
    return String(arg);
  }
  if (arg instanceof Error) {
    const head = `${arg.name || "Error"}: ${arg.message || "unknown"}`;
    const stack = typeof arg.stack === "string" ? arg.stack : "";
    if (!stack) return head;
    const lines = stack.split("\n").slice(0, 9).join(" ");
    return `${head} ${lines}`;
  }
  return safeJsonStringify(arg);
}

function inferEmoji(level: BufferedLogLevel, text: string): string {
  const normalized = compactWhitespace(text);
  const leading = splitLeadingEmoji(normalized);
  if (leading.emoji) return leading.emoji;
  for (const emoji of KNOWN_EMOJIS) {
    if (normalized.includes(emoji)) return emoji;
  }
  for (const hint of GROUP_HINTS) {
    if (hint.re.test(normalized)) return hint.emoji;
  }
  return LEVEL_EMOJI[level] || DEFAULT_EMOJI;
}

function inferGroup(text: string, emoji: string): string {
  if (GROUP_BY_EMOJI[emoji]) return GROUP_BY_EMOJI[emoji];
  for (const hint of GROUP_HINTS) {
    if (hint.re.test(text)) return hint.group;
  }
  return "General";
}

function inferGroupFromSource(source: string): string | null {
  const normalized = compactWhitespace(source).toLowerCase();
  if (!normalized) return null;
  for (const hint of SOURCE_GROUP_HINTS) {
    if (hint.re.test(normalized)) return hint.group;
  }
  return null;
}

function resolveGroup(text: string, emoji: string, source: string): string {
  const bySource = inferGroupFromSource(source);
  if (bySource) return bySource;
  return inferGroup(text, emoji);
}

function inferEvent(text: string, level: "INFO" | "WARN" | "ERROR" | "DEBUG" | "BUG"): string {
  const raw = compactWhitespace(text);
  const s = raw.toLowerCase();
  const isApi = /(^|\s)(get|post|put|patch|delete)\s|https?:\/\/|status=\d{3}|←\s?\d{3}/i.test(raw);

  if (/\bnetworkstats\b/i.test(raw)) return "STATS";
  if (/\btimeout|aborted|abort\b/i.test(s)) return "TIMEOUT";
  if (/\bretry|retrying\b/i.test(s)) return "RETRY";
  if (/\bcache(hit|d)\b/i.test(s)) return "CACHE_HIT";
  if (/\bcache miss\b/i.test(s)) return "CACHE_MISS";
  if (/\bstate\b/i.test(s)) return "STATE";
  if (/\binvalid|validate|validation|missing required\b/i.test(s)) return "VALIDATION";
  if (/\bauth|token|siwe|signature|biometric|passkey\b/i.test(s) && level !== "INFO")
    return "SECURITY";
  if (isApi && level === "ERROR") return "API_ERR";
  if (isApi) return "API";
  return "FLOW";
}

function q(text: string): string {
  return `"${compactText(text, LOG_MAX_MSG_CHARS).replace(/"/g, "'")}"`;
}

type StackCaller = { source: string; file: string; func: string; line?: number };

function parseStackLine(line: string): StackCaller | null {
  const trimmed = String(line || "").trim();
  if (!trimmed) return null;

  const a = trimmed.match(/at\s+([^\s(]+)\s+\((.+):(\d+):(\d+)\)$/);
  if (a) {
    const func = cleanFunc(a[1]);
    const file = compactPath(a[2]);
    const lineNum = Number(a[3]) || undefined;
    const source = `${file}${lineNum ? `:${lineNum}` : ""}#${func}`;
    return { source, file, func, line: lineNum };
  }

  const b = trimmed.match(/at\s+(.+):(\d+):(\d+)$/);
  if (b) {
    const file = compactPath(b[1]);
    const lineNum = Number(b[2]) || undefined;
    const source = `${file}${lineNum ? `:${lineNum}` : ""}#anonymous`;
    return { source, file, func: "anonymous", line: lineNum };
  }

  const c = trimmed.match(/^([^@]+)@(.+):(\d+):(\d+)$/);
  if (c) {
    const func = cleanFunc(c[1]);
    const file = compactPath(c[2]);
    const lineNum = Number(c[3]) || undefined;
    const source = `${file}${lineNum ? `:${lineNum}` : ""}#${func}`;
    return { source, file, func, line: lineNum };
  }

  return null;
}

function getCallerSource(): string {
  const err = new Error();
  const stack = typeof err.stack === "string" ? err.stack : "";
  const lines = stack.split("\n").slice(1);
  for (const line of lines) {
    const parsed = parseStackLine(line);
    if (!parsed) continue;
    if (
      /^(getCallerSource|normalizeConsoleMessage|installDebugLogBuffer|sourceTag)$/.test(
        parsed.func,
      )
    ) {
      continue;
    }
    if (parsed.file.includes("node_modules")) continue;
    const skip = INTERNAL_STACK_MARKERS.some(
      (marker) => parsed.file.includes(marker) || parsed.func.includes(marker),
    );
    if (skip) continue;
    return parsed.source;
  }
  return "unknown#anonymous";
}

function extractTime(text: string): string | null {
  const m1 = text.match(/\b(\d{2}:\d{2}:\d{2}\.\d{3})\b/);
  if (m1?.[1]) return m1[1];
  const m2 = text.match(/\b\d{4}-\d{2}-\d{2}\s+(\d{2}:\d{2}:\d{2}\.\d{3})\b/);
  if (m2?.[1]) return m2[1];
  return null;
}

function extractDurationMs(text: string): number | null {
  const m1 = text.match(/\bdur=(\d+)ms\b/i);
  if (m1?.[1]) return Number(m1[1]);
  const m2 = text.match(/\bin\s+(\d+)ms\b/i);
  if (m2?.[1]) return Number(m2[1]);
  return null;
}

function extractExplicitSource(text: string): string | null {
  const srcKey = text.match(/\bsrc=([^\s]+)/);
  if (srcKey?.[1]) {
    const candidate = srcKey[1];
    // Reject histogram/summary pseudo-sources like "foo(80.0%),bar(20.0%)".
    if (!/[(),%]/.test(candidate)) return candidate;
  }
  const atSource = text.match(/\s@([A-Za-z0-9_./:#-]+)/);
  if (atSource?.[1]) return atSource[1];

  const bracket = text.match(/^\[([^\]]+)\]/);
  if (bracket?.[1]) {
    const inside = compactWhitespace(bracket[1]);
    const colon = inside.match(/^([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+)$/);
    if (colon) return `${colon[1]}#${colon[2]}`;
    const dot = inside.match(/^([A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+)$/);
    if (dot) return dot[1];
  }
  return null;
}

function inferContext(text: string): "user" | "poll" | "background" | "system" | null {
  const s = compactWhitespace(text).toLowerCase();
  if (!s) return null;
  if (/\bpoll\b|pendingpoll|interval|watchdog|heartbeat|retry/i.test(s)) return "poll";
  if (/\b(onpress|pressed|tap|clicked|submit|open|close|copy|paste|scan)\b/i.test(s)) return "user";
  if (/\b(refresh|prefetch|init|startup|bootstrap|resume)\b/i.test(s)) return "background";
  return null;
}

function stripLegacyPrefix(text: string): { body: string; opId?: string } {
  let value = compactWhitespace(text);
  const lead = splitLeadingEmoji(value);
  value = lead.rest || value;

  const bracket = value.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (!bracket) {
    return { body: value };
  }

  const insideRaw = compactWhitespace(bracket[1]);
  let tail = compactWhitespace(bracket[2] || "");
  const insideLead = splitLeadingEmoji(insideRaw);
  const inside = insideLead.rest || insideRaw;

  let opId: string | undefined;
  const opMatch = inside.match(/([A-Za-z0-9_.:-]+#[A-Za-z0-9]+)/);
  if (opMatch?.[1]) opId = opMatch[1];

  const insideWithoutTime = inside
    .replace(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}/g, "")
    .replace(/\d{2}:\d{2}:\d{2}\.\d{3}/g, "")
    .replace(/\s+@.+$/, "")
    .trim();

  if (!tail) {
    tail = insideWithoutTime || inside;
  }

  return { body: compactWhitespace(tail), opId };
}

function sourceFromOpId(opId?: string | null): string | null {
  const raw = String(opId || "").trim();
  if (!raw) return null;
  const token = raw.split(/\s+/)[0];
  if (!token) return null;
  const opName = token.replace(/#[0-9a-z]+$/i, "");
  if (!opName) return null;
  if (opName.includes("#")) return opName;
  const lastDot = opName.lastIndexOf(".");
  if (lastDot > 0 && lastDot < opName.length - 1) {
    return `${opName.slice(0, lastDot)}#${opName.slice(lastDot + 1)}`;
  }
  return `${opName}#op`;
}

function sourceNeedsFallback(source: string): boolean {
  const value = String(source || "").trim();
  if (!value) return true;
  if (/^unknown(#|$)/i.test(value)) return true;
  if (/^index\.bundle(?::\d+)?(?:#|$)/i.test(value)) return true;
  if (/[(),%]/.test(value)) return true;
  return false;
}

function redactSensitiveText(raw: string): string {
  let out = String(raw ?? "");
  if (!out) return "";

  // Keep logs verbose, but never allow private key material.
  out = out.replace(
    /(\"?(privateKey|authKeyHex|mnemonic|seedPhrase|seed|passphrase|nsec|ncryptsec|register_session_id|session_id|sessionId)\"?\s*[:=]\s*\")([^\"]{6,})(\")/gi,
    "$1[REDACTED]$4",
  );
  out = out.replace(
    /((?:private\s*key|mnemonic|seed(?:\s*phrase)?|passphrase|register_session_id|session_id|sessionId)\s*[:=]\s*)([^\s,;]{6,})/gi,
    "$1[REDACTED]",
  );
  out = out.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY_BLOCK]",
  );
  return out;
}

export function isCanonicalLine(text: string): boolean {
  return (
    /^\S+\s+(DEBUG|INFO|WARN|ERROR|BUG)\s+grp=\S+\s+(?:scope=\S+\s+)?(?:act=\S+\s+)?evt=\S+(?:\s+res=\S+)?(?:\s+ctx=\S+)?\s+t=\d{2}:\d{2}:\d{2}\.\d{3}\b/.test(
      text,
    ) ||
    /^\S+\s+\S+\s+.+\|\s+lvl=(DEBUG|INFO|WARN|ERROR|BUG)\b.*\bt=\d{2}:\d{2}:\d{2}\.\d{3}\b/.test(
      text,
    )
  );
}

function isNoisyRawLine(text: string): boolean {
  const s = compactWhitespace(text);
  if (!s) return true;
  if (/^iOS Bundled\b/i.test(s) || /^Android Bundled\b/i.test(s)) return true;
  if (/^Running 'main' with\b/i.test(s)) return true;
  if (/^\[NetworkStats\]/i.test(s)) return true;
  if (/^stop undefined$/i.test(s)) return true;
  if (/^Closed$/i.test(s)) return true;
  if (/^\[UI\]\s+Press\b/i.test(s)) return true;
  if (/^\[UI\]\s+Close\b/i.test(s)) return true;
  if (/^\[NostrChatModal\]\s+Relay connected\b/i.test(s)) return true;
  if (/^\[NostrChatModal\]\s+Relay closed\b/i.test(s)) return true;
  if (/^\[NostrChatModal\]\s+Subscribed dm\+giftwrap\b/i.test(s)) return true;
  if (/^\[NostrChatModal\]\s+Outbound event snapshot\b/i.test(s)) return true;
  if (/^\[NostrChatModal\]\s+Relay send attempt\b/i.test(s)) return true;
  if (/^\[NostrChatModal\]\s+Sent encrypted DM\b/i.test(s)) return true;
  if (/^\[NostrChatModal\]\s+Relay send summary\b/i.test(s)) return true;
  return false;
}

export function buildRepeatKey(line: string): string {
  return (
    line
      .replace(/\bt=\d{2}:\d{2}:\d{2}\.\d{3}\b/g, "t=*")
      .replace(/\bdt=\+\d+ms\b/g, "dt=*")
      .replace(/\bdur=\d+ms\b/g, "dur=*")
      // Variable timing fields embedded in the story (e.g. the arkade poll trace
      // emits `durMs=…`, `elapsedMs=…`, `ageMs=…`). Without this, two otherwise
      // identical steady-poll lines differ only by elapsed time → different keys →
      // the poll-suppression window never collapses them.
      .replace(/\b([A-Za-z]+Ms)=\d+\b/g, "$1=*")
      .replace(/\bop=([A-Za-z0-9_.:-]+)#[0-9a-z]+\b/g, "op=$1#*")
      .replace(/\bsrc=([^#\s]+):\d+#/g, "src=$1:#")
      .replace(/https?:\/\/[^\s"']+/g, "url=*")
      .replace(/\b(npub1[0-9a-z]+)\b/gi, "npub=*")
      .replace(/\b(bc1[0-9a-z]+)\b/gi, "btc=*")
      .replace(/\b[0-9a-f]{20,}\b/gi, "hex=*")
  );
}

// A line is "poll-class" when it belongs to a fixed-cadence polling loop whose
// steady-state repeats should be held for a full cycle (LOG_POLL_REPEAT_SUPPRESS_WINDOW_MS)
// rather than the short default window. Exported so the regression self-check
// (scripts/log-dedup-check.mjs) can assert classification directly — immediate
// repeats are caught by BOTH windows, so window choice can only be tested via
// this seam, not via shouldSuppressRepeat timing.
export function isPollClassLine(line: string): boolean {
  const isPollCtx = /\bctx=poll\b/.test(line);
  const isBitcoinPollOp = /\bop=BlockchainService\.(fetchAddressSummary|getBalanceSummary)#/.test(
    line,
  );
  const isMempoolNetworkOp =
    /\bop=Network\.(fetch|axios)#/.test(line) && /\bmempool\.space\/api\//.test(line);
  // The arkade sign-trace marker (ARKADE_SIGN_TRACE_V2_*) lives inside the
  // `[time MARKER]` bracket, which stripLegacyPrefix removes during
  // normalization — so it never survives into the line we classify here. Key
  // instead on tokens that DO survive: `nuri_server_api=` (on every
  // logArkadeWalletSignTrace line, case-insensitive because sentence() may
  // capitalize the leading word), the arkade balance-dump namespace, and the
  // known per-cycle state lines.
  const isArkadePollTrace =
    /\bnuri_server_api=/i.test(line) ||
    /\bnamespace=nuri:arkade:/i.test(line) ||
    /\b(lnurl_pending_snapshot|arkade_receive_unlock_state|arkade_wallet_pending_vtxo_state|public_context_cache_hit|cached_assertion_missing|contract_diagnostics)\b/i.test(
      line,
    );
  return isPollCtx || isBitcoinPollOp || isMempoolNetworkOp || isArkadePollTrace;
}

// Record `key`→`ts` and prune oldest entries when the map grows past `max`.
// JS Map preserves insertion order, so delete-then-set moves the (possibly
// existing) key to the newest position, keeping the map ordered oldest→newest.
// Pruning then walks the front of that order, deleting the oldest `size-keep`
// keys in O(1) amortized each — no sort. Safe to delete already-yielded keys
// mid-iteration (the Map iterator skips only not-yet-visited deletions).
function touchAndPrune(
  map: Map<string, number>,
  key: string,
  ts: number,
  max: number,
  keep: number,
): void {
  map.delete(key);
  map.set(key, ts);
  if (map.size > max) {
    const toDelete = map.size - keep;
    const iterator = map.keys();
    for (let i = 0; i < toDelete; i += 1) {
      const next = iterator.next();
      if (next.done) break;
      map.delete(next.value);
    }
  }
}

export function shouldSuppressRepeat(line: string): boolean {
  if (!(/\s(INFO|DEBUG)\s/.test(line) || /\blvl=(INFO|DEBUG)\b/.test(line))) return false;
  const key = buildRepeatKey(line);
  const now = Date.now();
  const prev = recentLineTs.get(key) || 0;
  touchAndPrune(recentLineTs, key, now, 1500, 1200);
  if (!prev) return false;
  const windowMs = isPollClassLine(line)
    ? LOG_POLL_REPEAT_SUPPRESS_WINDOW_MS
    : LOG_REPEAT_SUPPRESS_WINDOW_MS;
  return now - prev < windowMs;
}

function normalizeSourceField(rawSource: string): string {
  const raw = String(rawSource || "").trim();
  if (!raw) return "unknown";
  const hashIndex = raw.indexOf("#");
  const left = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  const fn = hashIndex >= 0 ? compactWhitespace(raw.slice(hashIndex + 1)) : "";
  const file = compactPath(left);
  if (!fn || /^anonymous$/i.test(fn) || /^getCallerSource$/i.test(fn)) {
    return file;
  }
  return `${file}#${fn}`;
}

function cleanSourcePath(rawSource: string): string {
  const source = String(rawSource || "").trim();
  if (!source) return "";
  const hashIndex = source.indexOf("#");
  const left = hashIndex >= 0 ? source.slice(0, hashIndex) : source;
  return left.replace(/:\d+$/, "");
}

function inferScopeFromSource(source: string): string | null {
  const clean = cleanSourcePath(source);
  if (!clean) return null;
  const tail = clean.split("/").filter(Boolean).pop() || clean;
  const withoutExt = tail.replace(/\.(tsx?|jsx?)$/i, "");
  const withoutLine = withoutExt.replace(/:\d+$/, "");
  if (!withoutLine || /^unknown$/i.test(withoutLine)) return null;
  if (/^[A-Za-z0-9_.:-]+$/.test(withoutLine) && !withoutLine.includes(".")) {
    return withoutLine;
  }
  return null;
}

function inferActionFromSource(source: string): string | null {
  const hashIndex = String(source || "").indexOf("#");
  if (hashIndex < 0) return null;
  const fn = String(source || "")
    .slice(hashIndex + 1)
    .trim();
  if (!fn || /^anonymous$/i.test(fn)) return null;
  return fn.replace(/:\d+$/, "");
}

function inferActionFromOp(opId: string): string | null {
  const raw = compactWhitespace(opId).split(/\s+/)[0] || "";
  if (!raw) return null;
  const lastDot = raw.lastIndexOf(".");
  if (lastDot >= 0 && lastDot < raw.length - 1) {
    return raw.slice(lastDot + 1);
  }
  return raw;
}

function sentence(text: string): string {
  const normalized = compactWhitespace(text).replace(/^"+|"+$/g, "");
  if (!normalized) return "-";
  const withCapital = `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
  if (/[.!?…]$/.test(withCapital)) return withCapital;
  return `${withCapital}.`;
}

function categoryLabel(level: string, event: string): string {
  if (level === "BUG") return "BUG";
  if (level === "ERROR") return "FAIL";
  if (level === "WARN") return "WARN";
  switch (event) {
    case "API":
      return "CALL";
    case "API_ERR":
      return "FAIL";
    case "STATE":
      return "STATE";
    case "CACHE_HIT":
    case "CACHE_MISS":
      return "CACHE";
    case "RETRY":
      return "RETRY";
    case "TIMEOUT":
      return "TIMEOUT";
    case "VALIDATION":
      return "CHECK";
    case "STATS":
      return "STATS";
    default:
      return "STEP";
  }
}

function inferScreen(source: string, scope: string): string | null {
  if (/screens\/CardScreen\.tsx/i.test(source) || /\bCardScreen\b/.test(scope)) return "Card";
  if (/screens\/WalletScreen\.tsx/i.test(source) || /\bWalletScreen\b/.test(scope)) return "Wallet";
  if (/screens\/BitcoinScreen\.tsx/i.test(source) || /\bBitcoinScreen\b/.test(scope))
    return "Bitcoin";
  return null;
}

function fieldValue(line: string, key: string): string | null {
  const quoted = line.match(new RegExp(`\\b${key}="([^"]*)"`, "i"));
  if (quoted?.[1]) return quoted[1];
  const plain = line.match(new RegExp(`\\b${key}=([^\\s|]+)`, "i"));
  return plain?.[1] || null;
}

function buildReadableCanonicalLine(opts: {
  emoji: string;
  level: string;
  event: string;
  story: string;
  fields: string[];
}): string {
  return `${opts.emoji} ${categoryLabel(opts.level, opts.event)} ${sentence(opts.story)} | ${opts.fields.join(" ")}`;
}

// Clean render: `HH:MM:SS  <emoji>  <sentence>`, never truncated — same contract
// as lib/log (see d18069f4). The old 160-char SMS cap lived here after lib/log
// dropped it, and it cost a whole debugging session: a swap sat in
// RECOVERY_PENDING for 32h and the server's explanation of *why* was cut off
// mid-sentence at char 160 (issue #889). redact() is what gates content here,
// not a length limit.
function renderCleanLine(tsText: string, emoji: string, story: string): string {
  return `${tsText.slice(0, 8)}  ${emoji}  ${story}`;
}

// Successful reads to the steady polling endpoints (indexer/vtxos, receive/sync,
// swap status, mempool, price feeds, node info, mcp status). These repeat
// every few seconds and are the bulk of idle noise.
function isPollNetworkLine(line: string): boolean {
  if (!/←\s?2\d\d\b/.test(line) && !/\bres=ok\b/.test(line)) return false;
  return /indexer\/vtxos|\/receive\/sync|mempool\.space\/api|\/v1\/info\b|\/v4\/arkade\/info\b|script\/subscribe|coingecko|kraken|bitstamp|frankfurter|\/mcp\/v1\/(status|wallet)/i.test(
    line,
  );
}

// Muted at the default level: steady polls (so idle is quiet) — everything else
// prints, clean. warn level mutes all but warnings/errors; trace shows all.
// Warnings/errors always print regardless. Shared with lib/log via getLogLevel.
function mutedAtEventLevel(rawLine: string, level: string): boolean {
  const lvl = level.toUpperCase();
  if (lvl === "WARN" || lvl === "ERROR" || lvl === "BUG") return false;
  const wanted = getLogLevel();
  if (wanted === "trace") return false;
  if (wanted === "warn") return true;
  return isPollClassLine(rawLine) || isPollNetworkLine(rawLine);
}

export function normalizeCanonicalLine(line: string): string {
  let normalized = compactWhitespace(redactSensitiveText(line));
  // Already-canonical lines (the bulk: every logWithId/newOp/network line carries
  // `| lvl=`) used to pass through verbose. Render them clean + gated instead.
  if (/\|\s+lvl=/.test(normalized)) {
    const level = fieldValue(normalized, "lvl") || "INFO";
    if (mutedAtEventLevel(normalized, level)) return "";
    const story = extractCanonicalStory(normalized) || "-";
    const time = fieldValue(normalized, "t") || shortTime();
    const groupEmoji = splitLeadingEmoji(normalized).emoji || DEFAULT_EMOJI;
    const fileEmoji =
      emojiForSource(fieldValue(normalized, "src")) ??
      emojiForSource(fieldValue(normalized, "op")) ??
      groupEmoji;
    return renderCleanLine(time, fileEmoji, story);
  }
  const rawOpMatch = normalized.match(/\bop=([^\s]+)/);
  const rawOpId = rawOpMatch?.[1] || "";
  const opSource = sourceFromOpId(rawOpId);

  normalized = normalized.replace(/\bop=([^\s]+)/, (_whole, opId: string) => {
    return `op=${compactText(opId, 72)}`;
  });

  normalized = normalized.replace(/\bsrc=([^\s]+)/, (_whole, rawSource: string) => {
    let source = compactText(normalizeSourceField(rawSource), LOG_MAX_SOURCE_CHARS);
    if (sourceNeedsFallback(source) && opSource) {
      source = compactText(opSource, LOG_MAX_SOURCE_CHARS);
    }
    return `src=${source}`;
  });

  if (!/\bsrc=/.test(normalized) && opSource) {
    normalized = normalized.replace(
      /\bmsg=/,
      `src=${compactText(opSource, LOG_MAX_SOURCE_CHARS)} msg=`,
    );
  }

  const normalizedSourceMatch = normalized.match(/\bsrc=([^\s]+)/);
  const normalizedSource = normalizedSourceMatch?.[1] || "";
  const scope = inferScopeFromSource(normalizedSource);
  const action = inferActionFromSource(normalizedSource) || inferActionFromOp(rawOpId);

  if (!/\bscope=/.test(normalized) && scope) {
    normalized = normalized.replace(/\bevt=/, `scope=${stableToken(scope, 48)} evt=`);
  }

  if (!/\bact=/.test(normalized) && action) {
    normalized = normalized.replace(/\bevt=/, `act=${stableToken(action, 48)} evt=`);
  }

  const emoji = splitLeadingEmoji(normalized).emoji || DEFAULT_EMOJI;
  const level = normalized.match(/\s(DEBUG|INFO|WARN|ERROR|BUG)\s+/)?.[1] || "INFO";
  const event = fieldValue(normalized, "evt") || "FLOW";
  const result = fieldValue(normalized, "res");
  const context = fieldValue(normalized, "ctx");
  const time = fieldValue(normalized, "t") || shortTime();
  const dt = fieldValue(normalized, "dt") || "+0ms";
  const dur = fieldValue(normalized, "dur");
  const group = fieldValue(normalized, "grp") || "General";
  const story = fieldValue(normalized, "msg") || "-";
  const dataText = fieldValue(normalized, "data");
  const screen = fieldValue(normalized, "screen") || inferScreen(normalizedSource, scope || "");
  const flow = fieldValue(normalized, "flow");
  const fields: string[] = [
    `lvl=${level}`,
    `evt=${event}`,
    `grp=${group}`,
    `scope=${fieldValue(normalized, "scope") || stableToken(scope || "General", 48)}`,
    `act=${fieldValue(normalized, "act") || stableToken(action || "log", 48)}`,
    ...(screen ? [`screen=${stableToken(screen, 24)}`] : []),
    ...(flow ? [`flow=${stableToken(flow, 48)}`] : []),
    ...(result ? [`res=${result}`] : []),
    ...(context ? [`ctx=${context}`] : []),
    `t=${time}`,
    `dt=${dt}`,
    ...(dur ? [`dur=${dur}`] : []),
    `src=${normalizedSource || compactText(opSource || "unknown#anonymous", LOG_MAX_SOURCE_CHARS)}`,
    ...(rawOpId ? [`op=${compactText(rawOpId, 72)}`] : []),
    ...(dataText ? [`data=${q(dataText)}`] : []),
  ];

  // `fields` is the retired verbose tail — built but no longer emitted.
  void fields;
  if (mutedAtEventLevel(normalized, level)) return "";
  const fileEmoji = emojiForSource(normalizedSource) ?? emojiForSource(rawOpId) ?? emoji;
  return renderCleanLine(time, fileEmoji, story);
}

function extractCanonicalStory(line: string): string | null {
  if (/\|\s+lvl=/.test(line)) {
    const pipeIndex = line.indexOf("|");
    const head = pipeIndex >= 0 ? line.slice(0, pipeIndex) : line;
    const { rest } = splitLeadingEmoji(head);
    const story = rest.replace(
      /^(FLOW|STEP|CALL|STATE|CACHE|RETRY|TIMEOUT|CHECK|STATS|WARN|FAIL|BUG)\s+/,
      "",
    );
    return compactWhitespace(story) || null;
  }
  const match = line.match(/\bmsg="([^"]*)"/);
  return match?.[1] ? compactWhitespace(match[1]) : null;
}

function isNoisyCanonicalLine(line: string): boolean {
  const story = extractCanonicalStory(line);
  if (story && isNoisyRawLine(story)) return true;
  if (/\bop=EventBus\.emit\b/.test(line) && /support:(unreadCount|chatActive)\b/.test(line)) {
    return true;
  }
  if (
    /\bctx=poll\b/.test(line) &&
    /\bop=BlockchainService\.(fetchAddressSummary|getBalanceSummary|fetchAddressTransactions|fetchAllAddressTransactions)#/.test(
      line,
    )
  ) {
    return true;
  }
  return false;
}

function nextDeltaMs(nowTs: number): number {
  const prev = lastEmitTs;
  lastEmitTs = nowTs;
  if (!prev) return 0;
  return Math.max(0, nowTs - prev);
}

function normalizeConsoleMessage(level: BufferedLogLevel, args: unknown[]): string {
  const raw = args.map(formatArg).join(" ");
  // lib/log lines are already formatted, redacted, length-capped and deduped.
  // Pass them through untouched so their `HH:MM:SS  <emoji>  sentence` columns
  // survive the normalizer (which would otherwise reformat them). Detection:
  // a leading `HH:MM:SS` followed by two spaces — no legacy line starts that way.
  if (/^\d{2}:\d{2}:\d{2} {2}\S/.test(raw)) {
    return raw;
  }
  const redacted = redactSensitiveText(raw);
  const compact = compactWhitespace(redacted);
  if (!compact) {
    const nowTs = Date.now();
    const source = getCallerSource();
    const scope = stableToken(inferScopeFromSource(source) || "General", 48);
    const action = stableToken(inferActionFromSource(source) || "log", 48);
    return buildReadableCanonicalLine({
      emoji: LEVEL_EMOJI[level] || DEFAULT_EMOJI,
      level: LEVEL_LABEL[level],
      event: "FLOW",
      story: "-",
      fields: [
        `lvl=${LEVEL_LABEL[level]}`,
        "evt=FLOW",
        "grp=General",
        `scope=${scope}`,
        `act=${action}`,
        `t=${shortTime(nowTs)}`,
        `dt=+${nextDeltaMs(nowTs)}ms`,
        `src=${source}`,
      ],
    });
  }

  if (isNoisyRawLine(compact)) {
    return "";
  }

  if (isCanonicalLine(compact)) {
    const canonical = normalizeCanonicalLine(compact);
    if (!canonical) return "";
    if (isNoisyCanonicalLine(canonical)) return "";
    lastEmitTs = Date.now();
    return shouldSuppressRepeat(canonical) ? "" : canonical;
  }

  const baseLevel = LEVEL_LABEL[level];
  const levelFromContent = /\bBUG\b/i.test(compact) ? "BUG" : baseLevel;
  const legacy = stripLegacyPrefix(compact);
  let message = legacy.body || compact;

  const durMs = extractDurationMs(message);
  if (durMs !== null) {
    message = compactWhitespace(message.replace(/\bdur=\d+ms\b/gi, ""));
  }

  const sourceFromStack = getCallerSource();
  const sourceFromMessage = extractExplicitSource(compact);
  const sourceRaw = sourceFromMessage || sourceFromStack || "unknown#anonymous";
  const opSource = sourceFromOpId(legacy.opId);
  let source = compactText(sourceRaw, LOG_MAX_SOURCE_CHARS);
  if (sourceNeedsFallback(source) && opSource) {
    source = compactText(opSource, LOG_MAX_SOURCE_CHARS);
  }

  const emoji = inferEmoji(level, compact);
  const group = resolveGroup(`${source} ${compact}`, emoji, source);
  const scope = stableToken(inferScopeFromSource(source) || group, 48);
  const action = stableToken(
    inferActionFromSource(source) || inferActionFromOp(legacy.opId) || "log",
    48,
  );
  const event = inferEvent(message || compact, levelFromContent as any);
  const context = inferContext(compact);
  const tsText = extractTime(compact) || shortTime();
  const nowTs = Date.now();
  const dtMs = nextDeltaMs(nowTs);
  const screen = inferScreen(source, scope);
  const parts: string[] = [
    `lvl=${levelFromContent}`,
    `evt=${event}`,
    `grp=${group}`,
    `scope=${scope}`,
    `act=${action}`,
    ...(screen ? [`screen=${stableToken(screen, 24)}`] : []),
    ...(context ? [`ctx=${context}`] : []),
    `t=${tsText}`,
    `dt=+${dtMs}ms`,
  ];
  if (durMs !== null && Number.isFinite(durMs)) {
    parts.push(`dur=${Math.max(0, Math.round(durMs))}ms`);
  }
  parts.push(`src=${source}`);
  if (legacy.opId) {
    parts.push(`op=${legacy.opId}`);
  }
  // `parts` is the retired verbose tail — built but no longer emitted.
  void parts;
  if (mutedAtEventLevel(compact, levelFromContent)) return "";
  const fileEmoji = emojiForSource(source) ?? emojiForSource(legacy.opId) ?? emoji;
  const clean = renderCleanLine(tsText, fileEmoji, message || compact);
  return shouldSuppressRepeat(clean) ? "" : clean;
}

type BufferedLogListener = (entry: BufferedLogEntry) => void;
const listeners = new Set<BufferedLogListener>();

export function subscribeToBufferedLogs(listener: BufferedLogListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function push(level: BufferedLogLevel, message: string) {
  try {
    const entry: BufferedLogEntry = {
      ts: Date.now(),
      level,
      message: truncate(message, maxEntryChars),
    };
    buffer.push(entry);
    if (buffer.length > maxEntries) {
      buffer = buffer.slice(buffer.length - maxEntries);
    }
    if (listeners.size > 0) {
      for (const fn of listeners) {
        try {
          fn(entry);
        } catch {
          // Listener failures must not break logging.
        }
      }
    }
  } catch {
    // Do not let logging break the app.
  }
}

function downgradeRecoverableArkadeErrors(
  level: BufferedLogLevel,
  message: string,
): BufferedLogLevel {
  if (level !== "error") return level;
  if (
    /ContractWatcher connection failed/i.test(message) ||
    /Subscribe fetch failed/i.test(message) ||
    /\/v1\/indexer\/script\/subscribe/i.test(message) ||
    /subscription not found/i.test(message) ||
    /failed to subscribe to scripts/i.test(message)
  ) {
    return "warn";
  }
  if (
    /Failed to execute autonomous action for swap/i.test(message) &&
    /VHTLC is already spent/i.test(message)
  ) {
    return "warn";
  }
  return level;
}

export function installDebugLogBuffer(opts?: InstallOptions) {
  const g: any = typeof globalThis !== "undefined" ? (globalThis as any) : (global as any);
  if (g?.[GLOBAL_INSTALLED_KEY]) return;
  if (g) g[GLOBAL_INSTALLED_KEY] = true;

  if (opts?.maxEntries && Number.isFinite(opts.maxEntries)) {
    maxEntries = Math.max(50, Math.floor(opts.maxEntries));
  }
  if (opts?.maxEntryChars && Number.isFinite(opts.maxEntryChars)) {
    maxEntryChars = Math.max(300, Math.floor(opts.maxEntryChars));
  }

  const consoleRecord = console as unknown as Record<string, (...args: unknown[]) => void>;
  LEVELS.forEach((level) => {
    const existing = consoleRecord[level];
    if (typeof existing !== "function") return;
    if (!originalConsole[level]) {
      originalConsole[level] = existing.bind(console);
    }
    consoleRecord[level] = (...args: unknown[]) => {
      const normalized = normalizeConsoleMessage(level, args);
      if (!normalized) return;
      const effectiveLevel = downgradeRecoverableArkadeErrors(level, normalized);
      push(effectiveLevel, normalized);
      try {
        originalConsole[effectiveLevel]?.(normalized);
      } catch {
        // ignore
      }
    };
  });
}

export function getBufferedLogs(opts?: { maxEntries?: number }): BufferedLogEntry[] {
  const limitRaw = opts?.maxEntries;
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.floor(limitRaw as number))
    : buffer.length;
  const slice = limit >= buffer.length ? buffer : buffer.slice(buffer.length - limit);
  return slice.map((entry) => ({ ...entry }));
}

export function clearBufferedLogs() {
  buffer = [];
}
