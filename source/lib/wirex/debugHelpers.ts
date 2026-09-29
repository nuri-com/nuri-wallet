import { MAX_VISIBLE_JSON_CHARS } from "./debugConfig";

export const shortAddress = (value: string) => {
  if (!value || value.length < 10) return value || "unknown";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
};

export const isHexAddress = (value: string) => /^0x[a-fA-F0-9]{40}$/.test(value);

export const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null;

export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

export const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export const waitMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const truncateMiddle = (value: string, max = 140): string => {
  const raw = String(value || "");
  if (raw.length <= max) return raw;
  const head = Math.ceil((max - 3) / 2);
  const tail = Math.floor((max - 3) / 2);
  return `${raw.slice(0, head)}...${raw.slice(raw.length - tail)}`;
};

export const readArray = (root: Record<string, unknown> | null, key: string): unknown[] =>
  root ? asArray(root[key]) : [];

export const toVisibleText = (value: string): string => {
  if (value.length <= MAX_VISIBLE_JSON_CHARS) {
    return value;
  }
  const hidden = value.length - MAX_VISIBLE_JSON_CHARS;
  return `${value.slice(0, MAX_VISIBLE_JSON_CHARS)}\n\n... [truncated ${hidden} chars for display, use Copy full logs for full payload]`;
};

export const hexToAscii = (hex: string): string => {
  const raw = String(hex || "").replace(/^0x/i, "");
  if (!raw || raw.length % 2 !== 0) return "";
  let out = "";
  for (let i = 0; i < raw.length; i += 2) {
    const code = Number.parseInt(raw.slice(i, i + 2), 16);
    if (!Number.isFinite(code)) return "";
    if (code === 0) continue;
    if (code >= 32 && code <= 126) {
      out += String.fromCharCode(code);
      continue;
    }
    if (code === 10 || code === 13 || code === 9) {
      out += " ";
      continue;
    }
    out += "?";
  }
  return out.trim().replace(/\s+/g, " ");
};

export const decodeRevertStringFromErrorData = (hexDataRaw: string): string => {
  const raw = String(hexDataRaw || "")
    .replace(/^0x/i, "")
    .toLowerCase();
  if (!raw.startsWith("08c379a0")) return "";
  const selectorBytes = 4;
  const wordBytes = 32;
  const headerHexLen = (selectorBytes + wordBytes + wordBytes) * 2;
  if (raw.length < headerHexLen) return "";
  const lenWordStart = (selectorBytes + wordBytes) * 2;
  const lenWordHex = raw.slice(lenWordStart, lenWordStart + wordBytes * 2);
  let strLen = 0;
  try {
    strLen = Number(BigInt(`0x${lenWordHex}`));
  } catch {
    return "";
  }
  if (!Number.isFinite(strLen) || strLen <= 0 || strLen > 4096) return "";
  const strStart = headerHexLen;
  const strHexLen = strLen * 2;
  if (raw.length < strStart + strHexLen) return "";
  return hexToAscii(raw.slice(strStart, strStart + strHexLen));
};

export const extractSumsubClientIdFromKycUrl = (value: string): string => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const queryClientId = String(parsed.searchParams.get("clientId") || "").trim();
    if (queryClientId) return queryClientId;
    const pathSegments = parsed.pathname.split("/").filter(Boolean);
    const pIndex = pathSegments.indexOf("p");
    if (pIndex >= 0 && pathSegments[pIndex + 1]) {
      return decodeURIComponent(String(pathSegments[pIndex + 1]).trim());
    }
  } catch {}
  return "";
};
