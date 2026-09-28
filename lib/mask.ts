export const maskAddress = (value: string): string => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.length <= 14) return raw;
  return `${raw.slice(0, 6)}…${raw.slice(-6)}`;
};

export const maskToken = (value: string): string => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.length <= 12 ? raw : `${raw.slice(0, 8)}…`;
};

export const maskEmail = (value: string): string => {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  const [local, domain] = raw.split("@");
  if (!local || !domain) return raw ? "redacted" : "";
  return `${local.slice(0, 2)}…@${domain}`;
};

export const maskIp = (value: string): string => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const ipv4 = raw.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (ipv4) return `${ipv4[1]}.${ipv4[2]}.x.x`;
  return raw.length <= 16 ? raw : `${raw.slice(0, 8)}…${raw.slice(-4)}`;
};

export const truncate = (value: string, max = 240): string => {
  const raw = String(value || "");
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max)}…`;
};

export const errorToLog = (err: unknown) => {
  const e = (err ?? {}) as { code?: unknown; name?: unknown; message?: unknown; stack?: unknown };
  return {
    code: String(e.code || ""),
    name: String(e.name || ""),
    message: String(e.message || String(err)),
    stack: truncate(String(e.stack || ""), 500),
  };
};

export function maskPhoneForLog(phone?: string | null): string | null {
  const raw = typeof phone === "string" ? phone.trim() : "";
  if (!raw) return null;
  if (raw.length <= 4) return raw;
  return `${raw.slice(0, 3)}…${raw.slice(-2)}`;
}
