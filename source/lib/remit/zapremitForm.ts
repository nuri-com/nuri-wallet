/**
 * ZapRemit's payout catalog, as the "abroad" form reads it.
 *
 * Countries, methods and each method's recipient fields come live from the
 * service, so a method ZapRemit adds or retires needs no release. This module
 * only decides which methods the app offers (active, and no sender KYC), how a
 * typed value is put in the shape ZapRemit accepts, and how a finished form is
 * named back on the send screen.
 */

export type ZapRemitField = {
  /** ZapRemit's own field name, dotted for nested objects (`address.city`). */
  name: string;
  label: string;
  /** Pick from ZapRemit's option list (banks, networks) instead of typing. */
  options: boolean;
};

export type ZapRemitMethod = {
  code: string;
  name: string;
  currency: string;
  min: number;
  max: number;
  fields: ZapRemitField[];
};

export type ZapRemitOption = { code: string; name: string };

/** Who pays the destination out: ZapRemit, or the Tanzanian order service. */
export type PayoutProvider = "zapremit" | "tz";

/** A finished destination: everything the quote needs, plus how to show it. */
export type ZapRemitDestination = {
  provider: PayoutProvider;
  country: string;
  methodCode: string;
  currency: string;
  recipient: Record<string, unknown>;
  /** `Juan Dela Cruz (BDO Unibank ···7890)`, the recipient row on the send screen. */
  summary: string;
};

/**
 * Tanzania's destinations on the same host (`send_tzs`), shaped like
 * ZapRemit's catalog so one form serves both. Phones stay on the existing
 * remit.nuri.com rail. The bands are the service's own per-destination caps.
 */
export const TZ_METHODS: ZapRemitMethod[] = [
  {
    code: "TZ_LIPA",
    name: "Lipa Namba",
    currency: "TZS",
    min: 500,
    max: 3_000_000,
    fields: [
      { name: "lipaNamba", label: "Lipa Namba", options: false },
      { name: "providerCode", label: "Provider", options: true },
    ],
  },
  {
    code: "TZ_TANQR",
    name: "TanQR",
    currency: "TZS",
    min: 500,
    max: 3_000_000,
    fields: [{ name: "qrCode", label: "TanQR", options: false }],
  },
  {
    code: "TZ_BANK",
    name: "Bank",
    currency: "TZS",
    min: 500,
    max: 21_000_000,
    fields: [
      { name: "accountName", label: "Full Name", options: false },
      { name: "bic", label: "Bank", options: true },
      { name: "accountNumber", label: "Account Number", options: false },
    ],
  },
];

export const TANZANIA = { code: "TZ", name: "Tanzania", currency: "TZS" };

/**
 * A Tanzanian bank takes USDC only, so the Bitcoin send pays it by a swap into
 * USDC, not over Lightning: the Lightning band does not apply to it.
 */
export function paysBySwap(destination: ZapRemitDestination | null | undefined): boolean {
  return destination?.provider === "tz" && destination.methodCode === "TZ_BANK";
}

/** A scanned TanQR code: the national merchant QR, recognised by its domain tag. */
export function tanQrDestination(raw: string): ZapRemitDestination | null {
  const qrCode = String(raw || "").trim();
  if (!qrCode || !/tz\.go\.bot\.tips/i.test(qrCode)) return null;
  return {
    provider: "tz",
    country: "TZ",
    methodCode: "TZ_TANQR",
    currency: "TZS",
    recipient: { qrCode },
    summary: "TanQR",
  };
}

/** Dial codes of the countries ZapRemit serves, for a number typed in national form. */
const DIAL_CODES: Record<string, string> = { KE: "254", PH: "63", MX: "52", NG: "234" };

function finite(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The methods the app offers. A method with sender fields asks for the
 * sender's own identity (ID, birth date, address), which is KYC and out of
 * scope; an inactive one cannot be quoted.
 */
export function parseZapRemitMethods(raw: unknown): ZapRemitMethod[] {
  if (!Array.isArray(raw)) return [];
  const methods: ZapRemitMethod[] = [];
  for (const entry of raw as Array<Record<string, unknown>>) {
    if (!entry || entry.active === false) continue;
    const sender = entry.senderFields as Record<string, unknown> | undefined;
    if (sender && Object.keys(sender).length > 0) continue;
    const min = finite(entry.min);
    const max = finite(entry.max);
    if (typeof entry.code !== "string" || typeof entry.currency !== "string") continue;
    if (min === null || max === null) continue;
    const fields = Object.entries((entry.recipientFields ?? {}) as Record<string, unknown>).map(
      ([name, spec]) => {
        const s = (spec ?? {}) as { label?: unknown; options?: unknown };
        return {
          name,
          label: typeof s.label === "string" ? s.label : name,
          options: s.options === true,
        };
      },
    );
    methods.push({
      code: entry.code,
      name: typeof entry.name === "string" ? entry.name : entry.code,
      currency: entry.currency,
      min,
      max,
      fields,
    });
  }
  return methods;
}

/**
 * A typed value in the form ZapRemit takes. Phone numbers go as digits with
 * the country code and no plus (it refuses `+…` and the national `0…`);
 * account and card numbers lose the spaces people group them with.
 */
export function normalizeZapRemitValue(country: string, field: string, value: string): string {
  const trimmed = String(value || "").trim();
  const leaf = field.split(".").pop() ?? field;
  if (leaf === "phoneNumber") {
    const digits = trimmed.replace(/\D/g, "");
    const dial = DIAL_CODES[country];
    if (dial && digits.startsWith("0")) return `${dial}${digits.slice(1)}`;
    return digits;
  }
  if (leaf === "accountNumber" || leaf === "cardNumber" || leaf === "lipaNamba") {
    return trimmed.replace(/[\s-]/g, "");
  }
  // A QR payload is matched byte for byte; its spacing is part of it.
  if (leaf === "qrCode") return trimmed;
  return trimmed.replace(/\s+/g, " ");
}

/** Every field filled. ZapRemit itself validates the values. */
export function isZapRemitFormComplete(
  fields: ZapRemitField[],
  values: Record<string, string>,
): boolean {
  return fields.length > 0 && fields.every((f) => String(values[f.name] ?? "").trim() !== "");
}

/** The recipient object, dotted names nested as ZapRemit expects. */
export function buildZapRemitRecipient(
  country: string,
  fields: ZapRemitField[],
  values: Record<string, string>,
): Record<string, unknown> {
  const recipient: Record<string, unknown> = {};
  for (const field of fields) {
    const parts = field.name.split(".");
    let target = recipient;
    for (const part of parts.slice(0, -1)) {
      target[part] = (target[part] as Record<string, unknown>) ?? {};
      target = target[part] as Record<string, unknown>;
    }
    target[parts[parts.length - 1]] = normalizeZapRemitValue(
      country,
      field.name,
      values[field.name] ?? "",
    );
  }
  return recipient;
}

/** `Name (Bank ···7890)`: the name plus enough of the account to recognise it. */
export function zapRemitSummary(
  recipient: Record<string, unknown>,
  institutionName: string | null,
): string {
  const name = [recipient.fullName, recipient.accountName].find(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  const account = [
    recipient.accountNumber,
    recipient.cardNumber,
    recipient.phoneNumber,
    recipient.lipaNamba,
  ].find((v): v is string => typeof v === "string" && v.length > 0);
  const tail = account ? `\u00b7\u00b7\u00b7${account.slice(-4)}` : "";
  const detail = [institutionName, tail].filter(Boolean).join(" ");
  if (!name) return detail || "TanQR";
  return detail ? `${name} (${detail})` : name;
}
