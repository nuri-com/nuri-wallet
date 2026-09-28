import { compactWhitespace } from "./compactWhitespace";

export function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

export function shortTime(nowMs = Date.now()): string {
  const d = new Date(nowMs);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function compactPath(rawPath: string): string {
  const normalized = String(rawPath || "")
    .replace(/\\/g, "/")
    .replace(/[?#].*$/, "")
    .replace(/\/&platform=.*$/i, "");
  if (!normalized) return "unknown";
  if (/index\.bundle/i.test(normalized)) {
    return "index.bundle";
  }
  const marker = "/nuri-expo/";
  const idx = normalized.indexOf(marker);
  if (idx >= 0) {
    return normalized.slice(idx + marker.length);
  }
  const appIdx = normalized.search(/\/(lib|services|screens|components|config|apis)\//);
  if (appIdx >= 0) {
    return normalized.slice(appIdx + 1);
  }
  const chunks = normalized.split("/").filter(Boolean);
  return chunks.slice(-2).join("/") || normalized;
}

export function cleanFunc(raw: string): string {
  const base = String(raw || "")
    .replace(/^Object\./, "")
    .replace(/^new\s+/, "")
    .replace(/\[as [^\]]+\]/g, "")
    .trim();
  if (!base || base === "<anonymous>") return "anonymous";
  return base;
}

export const KNOWN_EMOJIS = [
  "🌐",
  "🔐",
  "💳",
  "🏦",
  "🟣",
  "💼",
  "₿",
  "🗄️",
  "🏁",
  "📝",
  "✅",
  "❌",
  "⏱️",
  "⚠️",
  "ℹ️",
  "🐞",
  "🧩",
].sort((a, b) => b.length - a.length);

export function splitLeadingEmoji(text: string): { emoji: string | null; rest: string } {
  const normalized = compactWhitespace(text);
  if (!normalized) return { emoji: null, rest: "" };
  for (const emoji of KNOWN_EMOJIS) {
    if (normalized === emoji) return { emoji, rest: "" };
    if (normalized.startsWith(`${emoji} `)) {
      return { emoji, rest: normalized.slice(emoji.length).trimStart() };
    }
    if (normalized.startsWith(`${emoji}[`)) {
      return { emoji, rest: normalized.slice(emoji.length).trimStart() };
    }
  }
  return { emoji: null, rest: normalized };
}
