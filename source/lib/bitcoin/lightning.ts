// Lightning/onchain address utilities.
import { decode } from "light-bolt11-decoder";
import { isValidBitcoinAddressMainnet } from "./address";
import {
  isLightningAddress,
  isLnurlBech32,
  isLnurlUrl,
  normalizeLightningInput,
} from "../../services/bitcoin/LnurlService";
import { errMsg } from "../errorMessage";

export function extractOnchainAddress(raw: string): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^bitcoin:/i, "");
  const withoutQuery = cleaned.split("?")[0].trim();
  return withoutQuery || null;
}

export function isBolt11Invoice(raw: string): boolean {
  if (!raw) return false;
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith("ln")) return false;
  if (lower.startsWith("lnurl")) return false;
  // A BOLT-12 offer also starts `ln`, and nothing downstream can pay one: the
  // corridor quotes a BOLT-11 invoice, and the decoder rejects an offer only
  // after it has already been labelled and priced as payable.
  if (lower.startsWith("lno1")) return false;
  if (!/^ln[0-9a-z]+$/i.test(lower)) return false;
  return lower.length > 10;
}

export function isValidRequestPrefill(raw: string): boolean {
  const normalized = normalizeLightningInput(raw);
  if (!normalized) return false;
  if (isLightningAddress(normalized)) return true;
  if (isLnurlBech32(normalized) || isLnurlUrl(normalized)) return true;
  const maybeBitcoinAddress = extractOnchainAddress(normalized);
  if (maybeBitcoinAddress && isValidBitcoinAddressMainnet(maybeBitcoinAddress)) return true;
  if (!isBolt11Invoice(normalized)) return false;
  try {
    decode(normalized.toLowerCase());
    return true;
  } catch {
    return false;
  }
}

/** What the app reads off a BOLT11 before it will pay one. */
export type Bolt11Facts = {
  /** The raw invoice, trimmed and lowercased. */
  raw: string;
  /** `sha256(P)`, lowercase hex. */
  paymentHash: string;
  amountSats: number;
  /** Absolute expiry, unix seconds. */
  expiresAt: number;
};

// The amount and the payment hash are read from the invoice itself, never from
// what a quote says about it: the amount decides what leaves the wallet, and
// the hash is what a settlement is later proven against.
export function decodeBolt11Facts(invoiceRaw: string): Bolt11Facts {
  const raw = String(invoiceRaw || "")
    .trim()
    .toLowerCase();
  if (!raw) {
    throw new Error("invoice required");
  }
  const decoded = decode(raw);
  const sections: Array<{ name: string; value?: unknown }> = Array.isArray(decoded?.sections)
    ? decoded.sections
    : [];
  const sectionValue = (name: string): unknown =>
    sections.find((section) => String(section?.name || "") === name)?.value;

  const paymentHash = String(sectionValue("payment_hash") || "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(paymentHash)) {
    throw new Error("lightning invoice payment hash missing or invalid");
  }

  const msats = Number(sectionValue("amount"));
  if (!Number.isFinite(msats) || msats <= 0) {
    throw new Error("lightning invoice amount missing or invalid");
  }
  // Every rail here counts in whole sats: the corridor is exact-out and funds a
  // lockup for the figure it was given, so a truncated 500.5-sat invoice would
  // be paid 500 and never settle. Refuse it instead of rounding the difference
  // away where nobody can see it.
  if (msats % 1000 !== 0) {
    throw new Error("lightning invoice amount is not a whole number of sats");
  }
  const amountSats = msats / 1000;

  const timestampSec = Number(sectionValue("timestamp"));
  if (!Number.isFinite(timestampSec) || timestampSec <= 0) {
    throw new Error("lightning invoice timestamp missing or invalid");
  }
  // The `x` tag, read from the sections rather than from `decoded.expiry`. The
  // section is the tag itself and is a DURATION by spec; the top-level getter
  // is the decoder's own convenience and this package ships one that returns
  // `timestamp + value` — an absolute time — which added to the timestamp again
  // would put every expiry decades out and disable the gate entirely.
  // BOLT11 leaves the tag optional and defaults it to 3600 seconds.
  const expirySec = Number(sectionValue("expiry") ?? sectionValue("expire_time"));
  const expiresAt = Math.trunc(
    timestampSec + (Number.isFinite(expirySec) && expirySec > 0 ? expirySec : 3600),
  );

  return { raw, paymentHash, amountSats, expiresAt };
}

export function decodeBolt11Debug(invoiceRaw: string): {
  ok: boolean;
  network: string;
  paymentHash: string;
  amountSats: string;
  timestampSec: string;
  expirySec: string;
  expiresAtSec: string;
  isExpired: string;
  err: string;
} {
  const invoice = String(invoiceRaw || "")
    .trim()
    .toLowerCase();
  if (!invoice) {
    return {
      ok: false,
      network: "n/a",
      paymentHash: "n/a",
      amountSats: "n/a",
      timestampSec: "n/a",
      expirySec: "n/a",
      expiresAtSec: "n/a",
      isExpired: "n/a",
      err: "invoice_empty",
    };
  }
  try {
    const decoded = decode(invoice) as { sections?: { name?: unknown; value?: unknown }[] };
    const sections = Array.isArray(decoded?.sections) ? decoded.sections : [];
    const findSection = (names: string[]) => {
      const wanted = names.map((name) => name.toLowerCase());
      return sections.find((section) => wanted.includes(String(section?.name || "").toLowerCase()));
    };
    const amountSection = findSection(["amount"]);
    const paymentHashSection = findSection(["payment_hash", "payment hash", "hash"]);
    const timestampSection = findSection(["timestamp"]);
    const expirySection = findSection(["expiry", "expire_time"]);

    let amountSats = "n/a";
    if (amountSection && typeof amountSection?.value === "string") {
      try {
        const msats = BigInt(amountSection.value);
        amountSats = String(msats / 1000n);
      } catch {
        amountSats = "n/a";
      }
    }

    const paymentHashRaw =
      paymentHashSection && typeof paymentHashSection?.value === "string"
        ? String(paymentHashSection.value).toLowerCase()
        : "";

    const timestampSecNum = Number(timestampSection?.value);
    const expirySecNum = Number(expirySection?.value);
    const timestampSec = Number.isFinite(timestampSecNum)
      ? String(Math.trunc(timestampSecNum))
      : "n/a";
    const expirySec = Number.isFinite(expirySecNum) ? String(Math.trunc(expirySecNum)) : "3600";
    const expiresAtSecNum =
      Number.isFinite(timestampSecNum) && Number.isFinite(expirySecNum)
        ? Math.trunc(timestampSecNum + expirySecNum)
        : Number.NaN;
    const expiresAtSec = Number.isFinite(expiresAtSecNum) ? String(expiresAtSecNum) : "n/a";
    const nowSec = Math.trunc(Date.now() / 1000);
    const isExpired =
      Number.isFinite(expiresAtSecNum) && expiresAtSecNum > 0
        ? nowSec > expiresAtSecNum
          ? "1"
          : "0"
        : "n/a";

    return {
      ok: true,
      network: invoice.slice(0, 4),
      paymentHash: paymentHashRaw || "n/a",
      amountSats,
      timestampSec,
      expirySec,
      expiresAtSec,
      isExpired,
      err: "none",
    };
  } catch (error: unknown) {
    return {
      ok: false,
      network: invoice.slice(0, 4) || "n/a",
      paymentHash: "n/a",
      amountSats: "n/a",
      timestampSec: "n/a",
      expirySec: "n/a",
      expiresAtSec: "n/a",
      isExpired: "n/a",
      err: errMsg(error, "decode_failed"),
    };
  }
}
