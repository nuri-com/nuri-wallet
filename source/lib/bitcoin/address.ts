import { ArkAddress } from "@arkade-os/sdk";
import * as btc from "@scure/btc-signer";

const addressCoder = btc.Address(btc.NETWORK);

export function isValidBitcoinAddressMainnet(addr: string): boolean {
  const trimmed = addr.trim();
  if (!trimmed) return false;

  try {
    const decoded = addressCoder.decode(trimmed);
    return (
      decoded.type === "pkh" ||
      decoded.type === "sh" ||
      decoded.type === "wpkh" ||
      decoded.type === "wsh" ||
      decoded.type === "tr"
    );
  } catch {
    return false;
  }
}

// Pure format check for Ark addresses. ArkAddress.decode() enforces the bech32m
// encoding and throws on malformed input, so a clean decode of a non-empty string
// means the address is well-formed. No network/hrp arg needed here.
export function isArkAddress(addr: string): boolean {
  const trimmed = addr.trim();
  if (!trimmed) return false;

  try {
    ArkAddress.decode(trimmed);
    return true;
  } catch {
    return false;
  }
}

// Bech32 is case-insensitive but mixed case is forbidden by BIP-173 (substitution
// risk). Lowercase only when uniformly cased; leave mixed-case bech32 untouched
// so validation rejects it. Base58 is case-sensitive — pass through unchanged.
export function canonicalizeBitcoinAddress(addr: string): string {
  const trimmed = addr.trim();
  if (!trimmed) return trimmed;
  if (!/^(bc1|tb1|bcrt1)/i.test(trimmed)) return trimmed;
  const letters = trimmed.replace(/[^a-zA-Z]/g, "");
  if (letters === letters.toLowerCase() || letters === letters.toUpperCase()) {
    return trimmed.toLowerCase();
  }
  return trimmed;
}
