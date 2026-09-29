import { decode as decodeBolt11 } from "light-bolt11-decoder";
import { decode as decodeBolt12 } from "light-bolt12-decoder";
import { isEpcQR, parse as parseEpc, validateIBAN } from "eu-payment-qr";
import { bech32 } from "@scure/base";
import { AccountId } from "caip";
import { isAddress } from "viem";
import {
  canonicalizeBitcoinAddress,
  isArkAddress,
  isValidBitcoinAddressMainnet,
} from "../bitcoin/address";
import { isBolt11Invoice } from "../bitcoin/lightning";
import { isLightningAddress } from "../../services/bitcoin/LnurlService";
import type { QrParseResult } from "./types";

const TAG = "[QrParser]";
const SATS_PER_BTC = 100_000_000;

/**
 * Universal QR code parser. Takes raw scanned string, returns typed result.
 */
export function parseQr(raw: string): QrParseResult {
  const input = String(raw || "").trim();
  if (!input) return { type: "unknown", raw: input };

  const lower = input.toLowerCase();

  // 1. bitcoin: or btc: URI
  if (lower.startsWith("bitcoin:") || lower.startsWith("btc:")) {
    return parseBitcoinUri(input);
  }

  // 2. ethereum: URI
  if (lower.startsWith("ethereum:")) {
    return parseEthereumUri(input);
  }

  // 3. lightning: URI prefix — strip and re-parse the remainder
  if (lower.startsWith("lightning:")) {
    const remainder = input.slice("lightning:".length).trim();
    if (remainder) return parseQr(remainder);
    return { type: "unknown", raw: input };
  }

  // 4. lnurl: URI prefix
  if (lower.startsWith("lnurl:")) {
    const remainder = input.slice("lnurl:".length).trim();
    return decodeLnurl(remainder);
  }

  // 5. monero: URI (address + optional tx_amount in XMR)
  if (lower.startsWith("monero:")) {
    return parseMoneroUri(input);
  }

  // 5a. zcash: URI (ZIP-321: address + optional amount in ZEC)
  if (lower.startsWith("zcash:")) {
    return parseZcashUri(input);
  }

  // 5b. EPC / GiroCode (starts with BCD)
  if (isEpcQR(input)) {
    return parseEpcQr(input);
  }

  // 6. BOLT12 offer (lno1) — must check before BOLT11 since isBolt11Invoice matches lno1
  if (lower.startsWith("lno1")) {
    return parseBolt12Offer(input);
  }

  // 7. BOLT11 invoice (lnbc, lntb, lnbcrt — no whitespace)
  if (isBolt11Invoice(input)) {
    return decodeBolt11Invoice(input);
  }

  // 8. LNURL bech32 (lnurl1)
  if (lower.startsWith("lnurl1")) {
    return decodeLnurl(input);
  }

  // 9. Lightning address (user@domain.tld)
  if (isLightningAddress(input)) {
    return { type: "lightning-address", address: input };
  }

  // 10. CAIP-10 (namespace:reference:address)
  const caip10 = parseCaip10(input);
  if (caip10) return caip10;

  // 11. Bare Ark address (ark1…) — must check before the plain Bitcoin branch so
  //      an Ark address is never mistaken for onchain.
  if (isArkAddress(input)) {
    return { type: "ark", address: input };
  }

  // 12. Plain bitcoin address — canonicalize first so all-uppercase bech32 from
  //     QR readers validates. Mixed-case bech32 is left untouched per BIP-173
  //     and rejected by isValidBitcoinAddressMainnet.
  const canonicalBitcoin = canonicalizeBitcoinAddress(input);
  if (isValidBitcoinAddressMainnet(canonicalBitcoin)) {
    return { type: "bitcoin", address: canonicalBitcoin };
  }

  // 12b. Bare Monero address — 95 chars (standard "4…" / subaddress "8…") or
  //      106 chars (integrated "4…"). No length overlap with any other branch.
  if (isMoneroAddress(input)) {
    return { type: "monero", address: input };
  }

  // 12c. Bare Zcash address — transparent t1/t3 (35-char base58), shielded
  //      Sapling zs1 (78-char bech32) or unified u1. Must run before the
  //      generic branches: a t-address is also 35-char base58 and would
  //      otherwise fall through to the Solana bare-address default.
  if (isZcashAddress(input)) {
    return { type: "zcash", address: input };
  }

  // 13. Plain EVM address — validate with viem (lowercase to skip EIP-55 checksum)
  if (input.startsWith("0x") && isAddress(input.toLowerCase() as `0x${string}`)) {
    return { type: "evm", address: input };
  }

  // 14. IBAN — validate checksum with eu-payment-qr
  const upperInput = input.toUpperCase();
  if (/^[A-Z]{2}\d{2}/.test(upperInput)) {
    const ibanResult = validateIBAN(upperInput);
    if (ibanResult.valid) {
      return { type: "iban", iban: upperInput };
    }
  }

  // 15. Unknown
  return { type: "unknown", raw: input };
}

// ── Internal helpers ─────────────────────────────────────────────

// Monero mainnet base58: 95-char standard (starts "4") / subaddress (starts
// "8"), or 106-char integrated address (starts "4").
const MONERO_ADDRESS = /^([48][1-9A-HJ-NP-Za-km-z]{94}|4[1-9A-HJ-NP-Za-km-z]{105})$/;

function isMoneroAddress(value: string): boolean {
  return MONERO_ADDRESS.test(value);
}

function parseMoneroUri(input: string): QrParseResult {
  try {
    const withoutScheme = input.replace(/^monero:(\/\/)?/i, "");
    const [addressPart, queryString] = withoutScheme.split("?");
    const address = addressPart.trim();
    if (!isMoneroAddress(address)) return { type: "unknown", raw: input };
    const result: QrParseResult & { type: "monero" } = { type: "monero", address };
    if (queryString) {
      const amountStr = new URLSearchParams(queryString).get("tx_amount");
      const amount = Number(amountStr);
      if (amountStr != null && Number.isFinite(amount) && amount > 0) {
        result.amountXmr = amount;
      }
    }
    return result;
  } catch (e) {
    console.log(TAG, "Failed to parse monero URI:", e);
    return { type: "unknown", raw: input };
  }
}

// Zcash mainnet: transparent P2PKH "t1…" / P2SH "t3…" (35-char base58),
// shielded Sapling "zs1…" (78-char bech32), unified "u1…" (bech32m, long).
const ZCASH_ADDRESS = /^(t[13][1-9A-HJ-NP-Za-km-z]{33}|zs1[a-z0-9]{75}|u1[a-z0-9]{50,})$/;

function isZcashAddress(value: string): boolean {
  return ZCASH_ADDRESS.test(value);
}

function parseZcashUri(input: string): QrParseResult {
  try {
    const withoutScheme = input.replace(/^zcash:(\/\/)?/i, "");
    const [addressPart, queryString] = withoutScheme.split("?");
    const address = addressPart.trim();
    if (!isZcashAddress(address)) return { type: "unknown", raw: input };
    const result: QrParseResult & { type: "zcash" } = { type: "zcash", address };
    if (queryString) {
      const amountStr = new URLSearchParams(queryString).get("amount");
      const amount = Number(amountStr);
      if (amountStr != null && Number.isFinite(amount) && amount > 0) {
        result.amountZec = amount;
      }
    }
    return result;
  } catch (e) {
    console.log(TAG, "Failed to parse zcash URI:", e);
    return { type: "unknown", raw: input };
  }
}

function parseBitcoinUri(input: string): QrParseResult {
  try {
    const withoutScheme = input.replace(/^(bitcoin:|btc:)/i, "");
    const [addressPart, queryString] = withoutScheme.split("?");
    const rawAddress = addressPart.trim();
    if (!rawAddress) return { type: "unknown", raw: input };
    const address = canonicalizeBitcoinAddress(rawAddress);
    if (!isValidBitcoinAddressMainnet(address)) {
      return { type: "unknown", raw: input };
    }

    const result: QrParseResult & { type: "bitcoin" } = {
      type: "bitcoin",
      address,
    };

    if (queryString) {
      const params = new URLSearchParams(queryString);

      const amountStr = params.get("amount");
      if (amountStr != null) {
        const btcAmount = Number(amountStr);
        if (Number.isFinite(btcAmount) && btcAmount > 0) {
          result.amountSats = Math.round(btcAmount * SATS_PER_BTC);
        }
      }

      const label = params.get("label");
      if (label) result.label = label;

      const message = params.get("message");
      if (message) result.message = message;

      const lightning = params.get("lightning");
      if (lightning) result.lightning = lightning;

      const ark = params.get("ark");
      if (ark) result.ark = ark;
    }

    return result;
  } catch (e) {
    console.log(TAG, "Failed to parse bitcoin URI:", e);
    return { type: "unknown", raw: input };
  }
}

/**
 * Parse EIP-681 URI: ethereum:<address>[@<chainId>][/<functionName>]?[params]
 */
function parseEthereumUri(input: string): QrParseResult {
  try {
    const withoutScheme = input.replace(/^ethereum:/i, "");
    // Split path and query
    const [pathPart, queryString] = withoutScheme.split("?");

    // Parse address, optional chain ID, optional function name
    // Format: <address>@<chainId>/<functionName> or <address>/<functionName> or <address>@<chainId> or <address>
    let addressAndChain: string;
    let functionName: string | undefined;

    const slashIdx = pathPart.indexOf("/");
    if (slashIdx !== -1) {
      addressAndChain = pathPart.slice(0, slashIdx);
      functionName = pathPart.slice(slashIdx + 1);
    } else {
      addressAndChain = pathPart;
    }

    let address: string;
    let chainId: number | undefined;

    const atIdx = addressAndChain.indexOf("@");
    if (atIdx !== -1) {
      address = addressAndChain.slice(0, atIdx);
      const chainStr = addressAndChain.slice(atIdx + 1);
      const parsed = Number(chainStr);
      if (Number.isFinite(parsed)) chainId = parsed;
    } else {
      address = addressAndChain;
    }

    address = address.trim();
    if (!address || !isAddress(address.toLowerCase() as `0x${string}`))
      return { type: "unknown", raw: input };

    const result: QrParseResult & { type: "evm" } = {
      type: "evm",
      address,
    };

    if (chainId != null) result.chainId = chainId;
    if (functionName) result.functionName = functionName;

    if (queryString) {
      const params = new URLSearchParams(queryString);
      const valueStr = params.get("value");
      if (valueStr != null && valueStr.trim() !== "") {
        let parsedValue: bigint | undefined;
        try {
          parsedValue = parseEip681Value(valueStr);
        } catch {
          parsedValue = undefined;
        }
        // Fail closed on a PRESENT native value. Forms parseEip681Value does not
        // cover ("+1", ".1e18") or outright malformed strings would otherwise
        // leave `value` unset and be read as a valueless address send — letting a
        // native (ETH) payment intent settle as the chain's stable asset. Any
        // present, non-zero/unrecognized value becomes a positive amount so every
        // `value > 0n` consumer guard rejects it; a literal zero stays 0n.
        result.value = parsedValue ?? 1n;
      }
      const transferRecipient = params.get("address");
      if (transferRecipient) result.transferRecipient = transferRecipient;
      const tokenAmount = params.get("uint256");
      if (tokenAmount) {
        try {
          result.tokenAmount = parseEip681Value(tokenAmount);
        } catch {
          // ignore invalid amount
        }
      }
    }

    return result;
  } catch (e) {
    console.log(TAG, "Failed to parse ethereum URI:", e);
    return { type: "unknown", raw: input };
  }
}

function parseEpcQr(input: string): QrParseResult {
  try {
    const parsed = parseEpc(input) as {
      valid: boolean;
      data?: {
        iban?: string;
        bic?: string;
        recipient?: string;
        amount?: number;
        currency?: string;
        reference?: string;
      };
    };

    if (!parsed.valid || !parsed.data?.iban) {
      return { type: "unknown", raw: input };
    }

    const d = parsed.data;
    return {
      type: "sepa",
      iban: d.iban,
      bic: d.bic || undefined,
      name: d.recipient || undefined,
      amount: d.amount || undefined,
      currency: d.currency || undefined,
      reference: d.reference || undefined,
    };
  } catch (e) {
    console.log(TAG, "Failed to parse EPC QR:", e);
    return { type: "unknown", raw: input };
  }
}

function decodeBolt11Invoice(input: string): QrParseResult {
  try {
    const decoded = decodeBolt11(input.toLowerCase()) as {
      sections?: Array<{ name: string; value: unknown }>;
    };
    const sections = Array.isArray(decoded?.sections) ? decoded.sections : [];

    const findSection = (names: string[]): { name: string; value: unknown } | undefined => {
      const wanted = names.map((n) => n.toLowerCase());
      return sections.find((s) => wanted.includes(String(s?.name || "").toLowerCase()));
    };

    let amountSats: number | undefined;
    const amountSection = findSection(["amount"]);
    if (amountSection && typeof amountSection.value === "string") {
      try {
        const msats = BigInt(amountSection.value);
        amountSats = Number(msats / BigInt(1000));
      } catch {
        // ignore
      }
    }

    let description: string | undefined;
    const descSection = findSection(["description"]);
    if (descSection && typeof descSection.value === "string") {
      description = descSection.value;
    }

    let expiry: number | undefined;
    const expirySection = findSection(["expiry", "expire_time"]);
    if (expirySection) {
      const val = Number(expirySection.value);
      if (Number.isFinite(val)) expiry = val;
    }

    return {
      type: "lightning-invoice",
      invoice: input,
      amountSats,
      description,
      expiry,
    };
  } catch (e) {
    console.log(TAG, "Failed to decode BOLT11 invoice:", e);
    // Still return as lightning-invoice even if decode fails — the raw invoice is valid-looking
    return { type: "lightning-invoice", invoice: input };
  }
}

function parseBolt12Offer(input: string): QrParseResult {
  try {
    decodeBolt12(input);
  } catch (e) {
    console.log(TAG, "BOLT12 decode failed (returning raw offer):", e);
  }
  return { type: "bolt12-offer", offer: input };
}

function decodeLnurl(input: string): QrParseResult {
  try {
    const decoded = bech32.decode(input.toLowerCase() as `${string}1${string}`, 2000);
    const bytes = bech32.fromWords(decoded.words);
    const url = new TextDecoder().decode(new Uint8Array(bytes));
    return { type: "lnurl", url };
  } catch (e) {
    console.log(TAG, "Failed to decode LNURL bech32:", e);
    // Return as lnurl with the raw input as url fallback
    return { type: "lnurl", url: input };
  }
}

function parseCaip10(input: string): QrParseResult | null {
  // Quick check: must have exactly 2 colons (namespace:reference:address)
  const parts = input.split(":");
  if (parts.length !== 3) return null;

  try {
    const parsed = AccountId.parse(input);
    const chainId =
      typeof parsed.chainId === "string"
        ? {
            namespace: parsed.chainId.split(":")[0] || "",
            reference: parsed.chainId.split(":")[1] || "",
          }
        : parsed.chainId;
    const address =
      chainId.namespace === "bip122" ? canonicalizeBitcoinAddress(parsed.address) : parsed.address;
    return {
      type: "caip10",
      namespace: chainId.namespace,
      chainRef: chainId.reference,
      address,
    };
  } catch {
    return null;
  }
}

/**
 * Parse EIP-681 value strings without floating-point precision loss.
 * Handles scientific notation (2.014e18) and plain integers (1000000000000000001).
 */
function parseEip681Value(valueStr: string): bigint | undefined {
  const trimmed = valueStr.trim();
  if (!trimmed) return undefined;

  // Plain integer — parse directly as BigInt (no precision loss)
  if (/^\d+$/.test(trimmed)) {
    return BigInt(trimmed);
  }

  // Scientific notation (e.g., 2.014e18, 1e18)
  const sciMatch = trimmed.match(/^(\d+(?:\.\d+)?)[eE]\+?(\d+)$/);
  if (sciMatch) {
    const [, mantissa, exponentStr] = sciMatch;
    const exponent = Number.parseInt(exponentStr, 10);
    const dotIndex = mantissa.indexOf(".");
    if (dotIndex === -1) {
      // No decimal: 2e18 → 2 * 10^18
      return BigInt(mantissa) * BigInt(10) ** BigInt(exponent);
    }
    // Has decimal: 2.014e18 → 2014 * 10^(18-3)
    const decimals = mantissa.length - dotIndex - 1;
    const integerStr = mantissa.replace(".", "");
    const adjustedExp = exponent - decimals;
    if (adjustedExp < 0) return undefined;
    return BigInt(integerStr) * BigInt(10) ** BigInt(adjustedExp);
  }

  return undefined;
}
