export const normalizeIbanInput = (iban?: string | null): string =>
  String(iban || "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();

export const formatIbanForDisplay = (iban?: string | null): string => {
  if (!iban) return "";
  const clean = normalizeIbanInput(iban);
  return clean.replace(/(.{4})/g, "$1 ").trim();
};
