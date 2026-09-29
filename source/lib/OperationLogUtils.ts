// Lightweight logging helpers with one-line structured output.
// Goal: stable, human-readable, grep-friendly, and source-traceable logs.

import { compactWhitespace } from "./compactWhitespace";
import { cleanFunc, compactPath, KNOWN_EMOJIS, shortTime, splitLeadingEmoji } from "./logShared";

let __reqCounter = 0;

const MAX_INLINE_CHARS = 140;
const MAX_EVENT_CHARS = 120;
const MAX_RESULT_CHARS = 120;
const MAX_SOURCE_CHARS = 72;
const DEFAULT_LOG_EMOJI = "🧩";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "BUG";
export type LogContext = "user" | "poll" | "background" | "system";
export type LogEvent =
  | "FLOW"
  | "API"
  | "API_ERR"
  | "STATE"
  | "CACHE_HIT"
  | "CACHE_MISS"
  | "RETRY"
  | "TIMEOUT"
  | "VALIDATION"
  | "SECURITY"
  | "STATS";

export type StructuredLogOptions = {
  context?: LogContext;
  source?: string;
  scope?: string;
  action?: string;
  result?: string;
  event?: LogEvent;
  screen?: string;
  flow?: string;
};

// Emoji catalog for quick visual grouping
export const LOG_EMOJI = {
  app: "🏁",
  auth: "🔐",
  siwe: "📝",
  card: "💳",
  iban: "🏦",
  wallet: "💼",
  bitcoin: "₿",
  network: "🌐",
  storage: "🗄️",
  success: "✅",
  error: "❌",
  timing: "⏱️",
} as const;

const INTERNAL_STACK_MARKERS = [
  "OperationLogUtils",
  "LoggerService",
  "DebugLogBuffer",
  "emitStructured",
  "formatStructuredLine",
  "logWithId",
  "warnWithId",
  "errorWithId",
  "newOp",
  "getCallerInfo",
];

const GROUP_BY_EMOJI: Record<string, string> = {
  [LOG_EMOJI.network]: "Network",
  [LOG_EMOJI.auth]: "Auth",
  [LOG_EMOJI.siwe]: "Auth",
  [LOG_EMOJI.card]: "Card",
  [LOG_EMOJI.iban]: "Iban",
  [LOG_EMOJI.wallet]: "Wallet",
  [LOG_EMOJI.bitcoin]: "Bitcoin",
  [LOG_EMOJI.storage]: "Storage",
  [LOG_EMOJI.app]: "App",
  [LOG_EMOJI.success]: "App",
  [LOG_EMOJI.error]: "App",
  [LOG_EMOJI.timing]: "App",
  "⚠️": "App",
  ℹ️: "App",
  "🐞": "Debug",
  [DEFAULT_LOG_EMOJI]: "General",
};

const GROUP_HINTS: Array<{ re: RegExp; group: string; emoji: string }> = [
  {
    re: /(bitcoin|btc|mempool|satoshi|psbt|utxo|txid|esplora)/i,
    group: "Bitcoin",
    emoji: LOG_EMOJI.bitcoin,
  },
  {
    re: /(network|fetch|axios|http|url|api|request|response)/i,
    group: "Network",
    emoji: LOG_EMOJI.network,
  },
  {
    re: /(auth|jwt|nonce|siwe|biometric|passkey|sign|signature|token)/i,
    group: "Auth",
    emoji: LOG_EMOJI.auth,
  },
  {
    re: /(card|payment|spendable|balance|pin|cvv|iban details)/i,
    group: "Card",
    emoji: LOG_EMOJI.card,
  },
  { re: /(iban|bank|bic|sepa)/i, group: "Iban", emoji: LOG_EMOJI.iban },
  { re: /(wallet|safe|address)/i, group: "Wallet", emoji: LOG_EMOJI.wallet },
  { re: /(storage|keychain|secure storage)/i, group: "Storage", emoji: LOG_EMOJI.storage },
  { re: /(kyc|applicant|sumsub)/i, group: "Kyc", emoji: LOG_EMOJI.app },
  { re: /(eventbus|event:|emit )/i, group: "EventBus", emoji: LOG_EMOJI.app },
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

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

function compactText(text: string, max = MAX_INLINE_CHARS): string {
  return truncate(compactWhitespace(text), max);
}

function q(text: string): string {
  return `"${compactText(text, MAX_INLINE_CHARS).replace(/"/g, "'")}"`;
}

function inferEmoji(text: string, fallback = DEFAULT_LOG_EMOJI): string {
  const normalized = compactWhitespace(text);
  if (!normalized) return fallback;

  const leading = splitLeadingEmoji(normalized);
  if (leading.emoji) return leading.emoji;

  for (const emoji of KNOWN_EMOJIS) {
    if (normalized.includes(emoji)) return emoji;
  }
  for (const hint of GROUP_HINTS) {
    if (hint.re.test(normalized)) return hint.emoji;
  }
  return fallback;
}

function inferGroup(text: string, emoji?: string): string {
  const normalized = compactWhitespace(text);
  if (emoji && GROUP_BY_EMOJI[emoji]) {
    return GROUP_BY_EMOJI[emoji];
  }
  for (const hint of GROUP_HINTS) {
    if (hint.re.test(normalized)) return hint.group;
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

function resolveGroup(text: string, emoji: string | undefined, source?: string): string {
  const bySource = source ? inferGroupFromSource(source) : null;
  if (bySource) return bySource;
  return inferGroup(text, emoji);
}

function stableToken(text: string, max = 40): string {
  const normalized = compactWhitespace(text)
    .replace(/[^A-Za-z0-9_.:-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized) return "unknown";
  return compactText(normalized, max);
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
  const hashIndex = source.indexOf("#");
  if (hashIndex < 0) return null;
  const fn = source.slice(hashIndex + 1).trim();
  if (!fn || /^anonymous$/i.test(fn)) return null;
  return fn.replace(/:\d+$/, "");
}

function inferActionFromId(id: string): string | null {
  const raw = compactWhitespace(id).split(/\s+/)[0] || "";
  if (!raw) return null;
  const lastDot = raw.lastIndexOf(".");
  if (lastDot >= 0 && lastDot < raw.length - 1) {
    return raw.slice(lastDot + 1);
  }
  return raw;
}

function resolveScope(source: string, fallback: string): string {
  return stableToken(inferScopeFromSource(source) || fallback, 48);
}

function resolveAction(source: string, fallback: string): string {
  return stableToken(inferActionFromSource(source) || inferActionFromId(fallback) || fallback, 48);
}

function startCaseToken(text: string): string {
  const normalized = compactWhitespace(text)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._:/#-]+/g, " ");
  if (!normalized) return "";
  return normalized
    .split(" ")
    .filter(Boolean)
    .map((part) => {
      if (/^[A-Z0-9]{2,}$/.test(part)) return part;
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

function readableScope(scope: string): string {
  const cleaned = startCaseToken(scope)
    .replace(/\bService\b/g, "service")
    .replace(/\bScreen\b/g, "screen");
  return cleaned || "App";
}

function readableAction(action: string): string {
  const cleaned = startCaseToken(action).toLowerCase();
  return cleaned || "step";
}

function sentence(text: string): string {
  const normalized = compactWhitespace(text).replace(/^"+|"+$/g, "");
  if (!normalized) return "-";
  const withCapital = `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
  if (/[.!?…]$/.test(withCapital)) return withCapital;
  return `${withCapital}.`;
}

function screenStory(screen: string | undefined, text: string): string {
  const normalized = compactWhitespace(text);
  if (!screen) return sentence(normalized);
  const screenLower = screen.toLowerCase();
  const body = normalized
    .replace(new RegExp(`^${screenLower}\\s+screen\\s+`, "i"), "")
    .replace(new RegExp(`^${screenLower}\\s+`, "i"), "");
  if (!body) return sentence(`${screen} screen`);
  if (
    /^(loading|opening|showing|waiting|refreshing|triggering|preparing|starting|using|reusing|checking)\b/i.test(
      body,
    )
  ) {
    return sentence(`${screen} screen is ${body}`);
  }
  return sentence(`${screen} screen ${body}`);
}

function categoryLabel(level: LogLevel, event: LogEvent): string {
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
      return "FLOW";
  }
}

function inferScreen(source: string, scope: string): string | undefined {
  if (/screens\/CardScreen\.tsx/i.test(source) || /\bCardScreen\b/.test(scope)) return "Card";
  if (/screens\/WalletScreen\.tsx/i.test(source) || /\bWalletScreen\b/.test(scope)) return "Wallet";
  if (/screens\/BitcoinScreen\.tsx/i.test(source) || /\bBitcoinScreen\b/.test(scope))
    return "Bitcoin";
  if (/screens\/.*Screen\.tsx/i.test(source)) {
    const match = source.match(/screens\/([A-Za-z0-9]+)Screen\.tsx/i);
    if (match?.[1]) return startCaseToken(match[1]);
  }
  return undefined;
}

function operationStory(scope: string, action: string, status: string, level: LogLevel): string {
  const subject = `${readableScope(scope)} ${readableAction(action)}`.trim();
  const normalizedStatus = compactWhitespace(status);
  const lower = normalizedStatus.toLowerCase();

  if (level === "BUG") return sentence(`${subject} hit a bug`);
  if (level === "ERROR") return sentence(`${subject} failed`);
  if (level === "WARN") return sentence(`${subject} completed with warnings`);
  if (/no_account_for_wallet/.test(lower)) {
    return sentence(`${subject} stopped because this wallet has no account`);
  }
  if (/\bgated|skip|skipped\b/.test(lower)) {
    return sentence(`${subject} was skipped by a guard`);
  }
  if (/\bcache|cached|stale_cache|dedup_wait\b/.test(lower)) {
    return sentence(`${subject} used cached data`);
  }
  if (/\btimeout\b/.test(lower)) {
    return sentence(`${subject} timed out`);
  }
  if (/\b(err|error|failed)\b/.test(lower)) {
    return sentence(`${subject} failed`);
  }
  if (
    /\b(ok|done|finished|initialized|success|succeeded|complete|completed|loaded|parsed|resolved|authenticated)\b/.test(
      lower,
    )
  ) {
    return sentence(`${subject} succeeded`);
  }
  return sentence(normalizedStatus);
}

function inferEvent(text: string, level: LogLevel): LogEvent {
  const raw = compactWhitespace(text);
  const isApi = /(^|\s)(get|post|put|patch|delete)\s|https?:\/\/|status=\d{3}|←\s?\d{3}/i.test(raw);

  if (/\bnetworkstats\b/i.test(raw)) return "STATS";
  if (/\btimeout(?:ed)?\b|timeout_\d+ms|\baborted\b|\babort\b/i.test(raw)) return "TIMEOUT";
  if (/\bretry|retrying\b/i.test(raw)) return "RETRY";
  if (/\bcache(hit|d)\b/i.test(raw)) return "CACHE_HIT";
  if (/\bcache miss\b/i.test(raw)) return "CACHE_MISS";
  if (/\bstate\b/i.test(raw)) return "STATE";
  if (/\binvalid|validate|validation|missing required\b/i.test(raw)) return "VALIDATION";
  if (/\bauth|token|siwe|signature|biometric|passkey\b/i.test(raw) && level !== "INFO")
    return "SECURITY";
  if (isApi && level === "ERROR") return "API_ERR";
  if (isApi) return "API";
  return "FLOW";
}

function nextSeq(): string {
  __reqCounter = (__reqCounter + 1) % 1_679_616; // 36^4
  return __reqCounter.toString(36).padStart(4, "0");
}

function stringifyExtra(extra: unknown, max = MAX_INLINE_CHARS): string {
  if (extra === undefined) return "";
  if (extra === null) return "null";
  if (typeof extra === "string") return compactText(extra, max);
  if (typeof extra === "number" || typeof extra === "boolean" || typeof extra === "bigint") {
    return compactText(String(extra), max);
  }
  if (extra instanceof Error) {
    return compactText(`${extra.name || "Error"}: ${extra.message || "unknown"}`, max);
  }
  try {
    const json = JSON.stringify(extra, (_k, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    return compactText(json ?? String(extra), max);
  } catch {
    return compactText(String(extra), max);
  }
}

type CallerInfo = {
  file: string;
  func: string;
  line?: number;
};

function parseStackLine(line: string): CallerInfo | null {
  const trimmed = String(line || "").trim();
  if (!trimmed) return null;

  const a = trimmed.match(/at\s+([^\s(]+)\s+\((.+):(\d+):(\d+)\)$/);
  if (a) {
    const func = cleanFunc(a[1]);
    const file = compactPath(a[2]);
    return { file, func, line: Number(a[3]) || undefined };
  }

  const b = trimmed.match(/at\s+(.+):(\d+):(\d+)$/);
  if (b) {
    const file = compactPath(b[1]);
    return { file, func: "anonymous", line: Number(b[2]) || undefined };
  }

  const c = trimmed.match(/^([^@]+)@(.+):(\d+):(\d+)$/);
  if (c) {
    const func = cleanFunc(c[1]);
    const file = compactPath(c[2]);
    return { file, func, line: Number(c[3]) || undefined };
  }

  return null;
}

function getCallerInfo(fallbackModule = "unknown", fallbackFunc = "anonymous"): CallerInfo {
  const err = new Error();
  const stack = typeof err.stack === "string" ? err.stack : "";
  const lines = stack.split("\n").slice(1);

  for (const line of lines) {
    const parsed = parseStackLine(line);
    if (!parsed) continue;
    if (
      /^(logWithId|warnWithId|errorWithId|newOp|emitStructured|formatStructuredLine|getCallerInfo|sourceTag)$/.test(
        parsed.func,
      )
    ) {
      continue;
    }
    const markerHit = INTERNAL_STACK_MARKERS.some(
      (marker) => parsed.file.includes(marker) || parsed.func.includes(marker),
    );
    if (markerHit) continue;
    if (parsed.file.includes("node_modules")) continue;
    return parsed;
  }

  return {
    file: fallbackModule || "unknown",
    func: fallbackFunc || "anonymous",
  };
}

function sourceTag(caller: CallerInfo, fallbackModule: string, fallbackFunc: string): string {
  const file = caller.file || fallbackModule || "unknown";
  const fn = caller.func || fallbackFunc || "anonymous";
  const ln = caller.line ? `:${caller.line}` : "";
  return `${file}${ln}#${fn}`;
}

function sourceFromOpId(opId: string, fallbackFunc: string): string {
  const token = compactText(
    String(opId || "")
      .trim()
      .split(/\s+/)[0] || "log",
    64,
  );
  if (!token) return `log#${fallbackFunc}`;
  if (token.includes("#")) return token;
  const lastDot = token.lastIndexOf(".");
  if (lastDot > 0 && lastDot < token.length - 1) {
    return `${token.slice(0, lastDot)}#${token.slice(lastDot + 1)}`;
  }
  return `${token}#${fallbackFunc}`;
}

function normalizeSource(rawSource: string, fallbackId?: string, fallbackFunc = "log"): string {
  const source = compactText(rawSource || "", MAX_SOURCE_CHARS);
  if (
    !source ||
    /^unknown(#|$)/i.test(source) ||
    /^index\.bundle(?::\d+)?(?:#|$)/i.test(source) ||
    /[(),%]/.test(source)
  ) {
    return compactText(sourceFromOpId(fallbackId || "log", fallbackFunc), MAX_SOURCE_CHARS);
  }
  return source;
}

function formatStructuredLine(opts: {
  emoji: string;
  level: LogLevel;
  group: string;
  scope: string;
  action: string;
  event: LogEvent;
  result?: string;
  context?: LogContext;
  screen?: string;
  flow?: string;
  source: string;
  opId?: string;
  msg: string;
  extraText?: string;
  tsMs?: number;
  tsText?: string;
  durMs?: number;
}): string {
  const nowTs = Number.isFinite(opts.tsMs) ? Number(opts.tsMs) : Date.now();
  const tsText = opts.tsText || shortTime(nowTs);
  const humanLabel = categoryLabel(opts.level, opts.event);
  const screen = opts.screen || inferScreen(opts.source, opts.scope);
  const story = screenStory(screen, opts.msg || "-");
  const parts: string[] = [
    // `lvl=`, `evt=`, and `grp=` are REQUIRED on every line by the AGENTS.md
    // LOGGING STANDARD (#9–11) and are relied on by DebugLogBuffer
    // (isCanonicalLine needs `| lvl=…`; normalizeCanonicalLine/SupportDump group
    // by `grp=`). The only suffix trim kept here is dropping the no-signal
    // `act=log` fallback; `dt=` was removed separately (it was a meaningless
    // cross-scope global delta).
    `lvl=${opts.level}`,
    `evt=${opts.event}`,
    `grp=${compactText(opts.group, 32)}`,
    `scope=${stableToken(opts.scope, 48)}`,
    ...(opts.action && opts.action !== "log" ? [`act=${stableToken(opts.action, 48)}`] : []),
    ...(screen ? [`screen=${stableToken(screen, 24)}`] : []),
    ...(opts.flow ? [`flow=${stableToken(opts.flow, 48)}`] : []),
    ...(opts.result ? [`res=${stableToken(opts.result, 24)}`] : []),
    ...(opts.context ? [`ctx=${opts.context}`] : []),
    `t=${tsText}`,
  ];

  if (typeof opts.durMs === "number" && Number.isFinite(opts.durMs)) {
    parts.push(`dur=${Math.max(0, Math.round(opts.durMs))}ms`);
  }
  parts.push(`src=${compactText(opts.source, MAX_SOURCE_CHARS)}`);
  if (opts.opId) {
    parts.push(`op=${compactText(opts.opId, 72)}`);
  }
  if (opts.extraText) {
    parts.push(`data=${q(opts.extraText)}`);
  }

  return `${opts.emoji || DEFAULT_LOG_EMOJI} ${humanLabel} ${story} | ${parts.join(" ")}`;
}

function emitStructured(
  level: LogLevel,
  opts: Omit<Parameters<typeof formatStructuredLine>[0], "level">,
) {
  const line = formatStructuredLine({ ...opts, level });
  if (level === "ERROR" || level === "BUG") {
    // eslint-disable-next-line no-console
    console.error(line);
    return;
  }
  if (level === "WARN") {
    // eslint-disable-next-line no-console
    console.warn(line);
    return;
  }
  if (level === "DEBUG") {
    // eslint-disable-next-line no-console
    console.debug(line);
    return;
  }
  // eslint-disable-next-line no-console
  console.log(line);
}

export function newReqId(prefix = "REQ"): string {
  return `${compactText(prefix, 48)}#${nextSeq()}`;
}

export function maskToken(token?: string | null): string {
  if (!token) return "null";
  const s = String(token);
  if (s.length <= 10) return `${s.slice(0, 3)}…`;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

export function now(): number {
  return Date.now();
}
export function since(start: number): string {
  return `${Date.now() - start}ms`;
}

export function logWithId(
  id: string,
  message: string,
  extra?: unknown,
  opts?: StructuredLogOptions,
) {
  const normalizedId = compactText(id || "log", 80);
  const idLeading = splitLeadingEmoji(normalizedId);
  const plainId = idLeading.rest || normalizedId || "log";
  const body = compactText(message);
  const emoji = idLeading.emoji || inferEmoji(`${plainId} ${body}`);
  const rawSource =
    opts?.source || sourceTag(getCallerInfo("log", "logWithId"), "log", "logWithId");
  const source = normalizeSource(rawSource, plainId, "logWithId");
  const group = resolveGroup(`${plainId} ${body}`, emoji, source);
  const scope = resolveScope(source, group);
  const action = stableToken(opts?.action || inferActionFromId(plainId) || "log", 48);
  const event = opts?.event || inferEvent(body, "INFO");
  const extraText = stringifyExtra(extra, MAX_EVENT_CHARS);
  emitStructured("INFO", {
    emoji,
    group,
    scope: opts?.scope || scope,
    action,
    event,
    result: opts?.result,
    context: opts?.context,
    screen: opts?.screen,
    flow: opts?.flow,
    source,
    opId: plainId,
    msg: body || plainId,
    extraText: extraText || undefined,
  });
}

export function warnWithId(
  id: string,
  message: string,
  extra?: unknown,
  opts?: StructuredLogOptions,
) {
  const normalizedId = compactText(id || "warn", 80);
  const idLeading = splitLeadingEmoji(normalizedId);
  const plainId = idLeading.rest || normalizedId || "warn";
  const body = compactText(message);
  const emoji = idLeading.emoji || inferEmoji(`${plainId} ${body}`);
  const rawSource =
    opts?.source || sourceTag(getCallerInfo("log", "warnWithId"), "log", "warnWithId");
  const source = normalizeSource(rawSource, plainId, "warnWithId");
  const group = resolveGroup(`${plainId} ${body}`, emoji, source);
  const scope = resolveScope(source, group);
  const action = stableToken(opts?.action || inferActionFromId(plainId) || "warn", 48);
  const event = opts?.event || inferEvent(body, "WARN");
  const extraText = stringifyExtra(extra, MAX_EVENT_CHARS);
  emitStructured("WARN", {
    emoji,
    group,
    scope: opts?.scope || scope,
    action,
    event,
    result: opts?.result || "warn",
    context: opts?.context,
    screen: opts?.screen,
    flow: opts?.flow,
    source,
    opId: plainId,
    msg: body || plainId,
    extraText: extraText || undefined,
  });
}

export function errorWithId(
  id: string,
  message: string,
  extra?: unknown,
  opts?: StructuredLogOptions,
) {
  const normalizedId = compactText(id || "error", 80);
  const idLeading = splitLeadingEmoji(normalizedId);
  const plainId = idLeading.rest || normalizedId || "error";
  const body = compactText(message);
  const emoji = idLeading.emoji || inferEmoji(`${plainId} ${body}`, LOG_EMOJI.error);
  const rawSource =
    opts?.source || sourceTag(getCallerInfo("log", "errorWithId"), "log", "errorWithId");
  const source = normalizeSource(rawSource, plainId, "errorWithId");
  const group = resolveGroup(`${plainId} ${body}`, emoji, source);
  const scope = resolveScope(source, group);
  const action = stableToken(opts?.action || inferActionFromId(plainId) || "error", 48);
  const event = opts?.event || inferEvent(body, "ERROR");
  const extraText = stringifyExtra(extra, MAX_EVENT_CHARS);
  emitStructured("ERROR", {
    emoji,
    group,
    scope: opts?.scope || scope,
    action,
    event,
    result: opts?.result || "error",
    context: opts?.context,
    screen: opts?.screen,
    flow: opts?.flow,
    source,
    opId: plainId,
    msg: body || plainId,
    extraText: extraText || undefined,
  });
}

// Convenience helper to create a scoped operation logger (module + function).
// Each operation emits one final line on `end()`.
export function newOp(
  moduleName: string,
  funcName: string,
  emoji?: string,
  sourceOverride?: string,
  context?: LogContext,
  options?: { emitSuccess?: boolean },
) {
  const opName = `${moduleName}.${funcName}`;
  const opEmoji = emoji || inferEmoji(opName);
  const id = `${opName}#${nextSeq()}`;
  const startTs = now();
  const caller = getCallerInfo(moduleName, funcName);
  const source = sourceOverride
    ? compactText(sourceOverride, MAX_SOURCE_CHARS)
    : sourceTag(caller, moduleName, funcName);
  const normalizedSource = normalizeSource(source, opName, funcName);
  const emitSuccess = options?.emitSuccess !== false;
  const group = resolveGroup(opName, opEmoji, normalizedSource);
  const scope = resolveScope(normalizedSource, moduleName);
  const action = resolveAction(normalizedSource, funcName);

  type OpEvent = { text: string; error: boolean; bug?: boolean; warn?: boolean };
  const events: OpEvent[] = [];
  let finalized = false;
  let hasError = false;
  let hasWarn = false;
  let hasBug = false;

  const pushEvent = (
    msg: string,
    extra?: unknown,
    flags?: { error?: boolean; warn?: boolean; bug?: boolean },
  ) => {
    const parts: string[] = [];
    const msgText = compactText(msg, MAX_EVENT_CHARS);
    if (msgText) parts.push(msgText);
    if (extra !== undefined) {
      const extraText = stringifyExtra(extra, MAX_EVENT_CHARS);
      if (extraText) parts.push(extraText);
    }
    const text = parts.join(" ").trim();
    if (!text) return;
    events.push({
      text,
      error: Boolean(flags?.error),
      warn: Boolean(flags?.warn),
      bug: Boolean(flags?.bug),
    });
  };

  const summarizeEvents = (status: string): Record<string, unknown> | undefined => {
    if (events.length === 0) return undefined;
    const deduped: string[] = [];
    for (const event of events) {
      const prefix = event.bug ? "BUG: " : event.error ? "ERR: " : event.warn ? "WARN: " : "";
      const line = `${prefix}${event.text}`;
      if (deduped[deduped.length - 1] !== line) {
        deduped.push(line);
      }
    }
    if (deduped.length === 1 && deduped[0] === status) return { status };
    const detail: Record<string, unknown> = {
      status,
      steps: deduped.length,
    };
    if (deduped.length === 1) {
      detail.note = deduped[0];
    } else {
      detail.first = deduped[0];
      detail.last = deduped[deduped.length - 1];
    }
    if (hasWarn) detail.warn = true;
    if (hasError) detail.error = true;
    if (hasBug) detail.bug = true;
    return detail;
  };

  const finish = (result?: string) => {
    if (finalized) return;
    finalized = true;

    const fallbackStatus = hasBug ? "BUG" : hasError ? "ERR" : hasWarn ? "WARN" : "OK";
    const status = compactText(result || fallbackStatus, MAX_RESULT_CHARS);
    const statusLower = status.toLowerCase();
    const level: LogLevel =
      hasBug || /\bbug\b/.test(statusLower)
        ? "BUG"
        : hasError || /\berr(or)?\b/.test(statusLower)
          ? "ERROR"
          : hasWarn || /\bwarn\b/.test(statusLower)
            ? "WARN"
            : "INFO";

    if (!emitSuccess && level === "INFO") {
      return;
    }

    const summary = summarizeEvents(status);
    const event = inferEvent(`${opName} ${status}`, level);
    const durMs = Date.now() - startTs;
    const resultToken = hasBug ? "bug" : hasError ? "error" : hasWarn ? "warn" : "ok";
    const extraText = summary ? stringifyExtra(summary, MAX_INLINE_CHARS) : undefined;

    emitStructured(level, {
      emoji: opEmoji,
      group,
      scope,
      action,
      event,
      result: resultToken,
      context,
      source: normalizedSource,
      opId: id,
      msg: operationStory(scope, action, status, level),
      extraText,
      durMs,
    });
  };

  return {
    id,
    startTs,
    log: (msg: string, extra?: unknown) => pushEvent(msg, extra),
    warn: (msg: string, extra?: unknown) => {
      hasWarn = true;
      pushEvent(msg, extra, { warn: true });
    },
    error: (msg: string, extra?: unknown) => {
      hasError = true;
      pushEvent(msg, extra, { error: true });
    },
    bug: (msg: string, extra?: unknown) => {
      hasBug = true;
      pushEvent(msg, extra, { bug: true });
    },
    end: (msg?: string) => finish(msg),
  };
}
