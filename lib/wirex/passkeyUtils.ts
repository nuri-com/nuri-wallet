const PASSKEY_LABEL_VENDOR_SEGMENT = "Nuri";
const PASSKEY_LABEL_BASE_REGEX = /^\d{6}-Nuri-[A-Za-z0-9]{2,40}$/;

export const toYyMmDd = (date: Date): string => {
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
};

export const sanitizePasskeyUserName = (valueRaw: string): string =>
  String(valueRaw || "")
    .trim()
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 40);

export const normalizePasskeyKeyBase = (valueRaw: string): string => {
  const raw = String(valueRaw || "").trim();
  if (!raw) return "";
  const normalized = raw.replace(/-Key[12]$/i, "");
  return PASSKEY_LABEL_BASE_REGEX.test(normalized) ? normalized : "";
};

export const buildPasskeyKeyBase = (userNameRaw: string, date: Date): string => {
  const userName = sanitizePasskeyUserName(userNameRaw);
  if (!userName) return "";
  return `${toYyMmDd(date)}-${PASSKEY_LABEL_VENDOR_SEGMENT}-${userName}`;
};

export const buildPasskeyKeyLabel = (base: string, keyIndex: 1 | 2): string => {
  const normalizedBase = normalizePasskeyKeyBase(base);
  if (!normalizedBase) return "";
  return `${normalizedBase}-Key${keyIndex}`;
};
