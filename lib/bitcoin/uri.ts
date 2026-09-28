import { canonicalizeBitcoinAddress } from "./address";
import { SATS_PER_BTC } from "./convert";

export function parseBitcoinUri(
  raw: string,
): { address: string; amountSats?: number; lightning?: string; ark?: string } | null {
  if (!raw) return null;
  const trimmed = raw.trim();

  if (/^(bitcoin:|btc:)/i.test(trimmed)) {
    const withoutScheme = trimmed.replace(/^(bitcoin:|btc:)/i, "");
    const [addressPart, queryString] = withoutScheme.split("?");
    const address = addressPart.trim();
    if (!address) return null;

    let amountSats: number | undefined;
    let lightning: string | undefined;
    let ark: string | undefined;
    if (queryString) {
      try {
        const params = new URLSearchParams(queryString);
        const amountStr = params.get("amount");
        if (amountStr != null) {
          const btcAmount = Number(amountStr);
          if (Number.isFinite(btcAmount) && btcAmount > 0) {
            amountSats = Math.round(btcAmount * SATS_PER_BTC);
          }
        }
        // BIP21 + BOLT-11: unified QR carries a `lightning=<bolt11|lnurl>`
        // fallback. Modern wallets prefer this path; surface it so the caller
        // can route through lightning instead of falling back to on-chain.
        const lightningParam = params.get("lightning");
        if (lightningParam) {
          const trimmedLn = lightningParam.trim();
          if (trimmedLn) lightning = trimmedLn;
        }
        // BIP21 extension: an `ark=<ark1…>` param carries an Ark address the
        // caller can route through instead of falling back to on-chain.
        const arkParam = params.get("ark");
        if (arkParam) {
          const trimmedArk = arkParam.trim();
          if (trimmedArk) ark = trimmedArk;
        }
      } catch {
        // Ignore parse errors and treat as address-only
      }
    }

    return { address: canonicalizeBitcoinAddress(address), amountSats, lightning, ark };
  }

  const address = trimmed;
  if (!address) return null;
  return { address: canonicalizeBitcoinAddress(address) };
}
