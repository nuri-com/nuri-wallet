// lib/send/recipientInput.ts
// What a typed, pasted or scanned recipient string is, for the one send flow.
// Everything the app can pay is accepted here; which balance pays it is
// decided later (sendRouting). Pure and synchronous: names that need a lookup
// (a Nuri username, an ENS name) come back as a lookup to run.
import type { Destination } from "../addressBook/contact";
import { isArkAddress, isValidBitcoinAddressMainnet } from "../bitcoin/address";
import { isBolt11Invoice } from "../bitcoin/lightning";
import { parseBitcoinUri } from "../bitcoin/uri";
import { isNuriLightningAddress, toNuriUsername } from "../pay/nuriUsername";
import { isEnsName } from "../qr/resolveEns";
import { normalizeKenyanMobileNumber } from "../remit/kenyaPhone";
import { normalizeTanzanianMobileNumber } from "../remit/tanzaniaPhone";
import { isValidEvmAddress } from "../validation";
import { isLnurlPaymentInput, normalizeLightningInput } from "../../services/bitcoin/LnurlService";

export type RecipientInput =
  | { kind: "destinations"; destinations: Destination[]; amountSats?: string }
  | { kind: "nuri-user"; username: string }
  | { kind: "ens"; name: string };

export const evm = (raw: string): Destination => ({
  type: "crypto",
  raw,
  network: "evm",
  asset: "ANY",
});
export const bitcoin = (raw: string): Destination => ({
  type: "crypto",
  raw,
  network: "bitcoin",
  asset: "BTC",
});
export const ark = (raw: string): Destination => ({
  type: "crypto",
  raw,
  network: "ark",
  asset: "BTC",
});
// Invoices, Lightning addresses, LNURLs and the phone numbers the Bitcoin send
// pays by minting an invoice: all of them are paid over Lightning from Arkade.
export const lightning = (raw: string): Destination => ({ type: "lightning", raw });

/** The recipient a string names, or null when it names nothing payable. */
export function parseRecipientInput(input: string): RecipientInput | null {
  const raw = String(input || "").trim();
  if (!raw) return null;
  if (isValidEvmAddress(raw)) return { kind: "destinations", destinations: [evm(raw)] };

  const uri = parseBitcoinUri(raw);
  if (uri) {
    const amountSats = uri.amountSats != null ? String(uri.amountSats) : undefined;
    const withAmount = (destinations: Destination[]): RecipientInput => ({
      kind: "destinations",
      destinations,
      ...(amountSats ? { amountSats } : {}),
    });
    // An ark= extension settles instantly; an invalid one is refused rather
    // than downgraded to the onchain fallback.
    if (uri.ark) return isArkAddress(uri.ark.trim()) ? withAmount([ark(uri.ark.trim())]) : null;
    // A Lightning alternative is preferred only when it is one this app pays;
    // otherwise the onchain address stands.
    const ln = uri.lightning ? normalizeLightningInput(uri.lightning) : "";
    if (ln && (isBolt11Invoice(ln) || (isLnurlPaymentInput(ln) && !isNuriLightningAddress(ln)))) {
      return withAmount([lightning(ln)]);
    }
    const address = uri.address.trim();
    if (isArkAddress(address)) return withAmount([ark(address)]);
    if (isValidBitcoinAddressMainnet(address)) return withAmount([bitcoin(address)]);
  }
  if (isArkAddress(raw)) return { kind: "destinations", destinations: [ark(raw)] };
  if (isValidBitcoinAddressMainnet(raw)) {
    return { kind: "destinations", destinations: [bitcoin(raw)] };
  }

  const ln = normalizeLightningInput(raw);
  if (isBolt11Invoice(ln) || (isLnurlPaymentInput(ln) && !isNuriLightningAddress(ln))) {
    return { kind: "destinations", destinations: [lightning(ln)] };
  }
  if (normalizeTanzanianMobileNumber(raw) || normalizeKenyanMobileNumber(raw)) {
    return { kind: "destinations", destinations: [lightning(raw)] };
  }

  const username = toNuriUsername(raw);
  if (username) return { kind: "nuri-user", username };
  if (isEnsName(raw)) return { kind: "ens", name: raw };
  return null;
}
